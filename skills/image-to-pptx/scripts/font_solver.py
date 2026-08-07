"""Offline font inventory, deterministic text tiers, and bounded font fitting.

The module deliberately has no network or package-manager path.  ``fontTools``
is the preferred parser and is declared as a strict runtime dependency.  A
fontconfig metadata fallback is retained for developer environments that have
not installed the package yet; it never invents coverage and marks the runtime
as degraded in the emitted inventory.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import statistics
import subprocess
import copy
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont

try:  # The requirements file pins this dependency in production.
    from fontTools.ttLib import TTFont
    import fontTools
except ImportError:  # pragma: no cover - exercised by developer environments
    TTFont = None
    fontTools = None


INVENTORY_VERSION = "1.0.0"
SOLVER_VERSION = "font-fit-v1"
METRIC_VERSION = "font-fit-metrics-v1"
FONT_DPI = 96
POINTS_PER_INCH = 72
PT_TO_PX = FONT_DPI / POINTS_PER_INCH
FONT_FAMILY_CAP = 6
FONT_SIZE_CAP = 5
FONT_WEIGHT_CAP = 3
FONT_SPACING_CAP = 3
FONT_LINE_HEIGHT_CAP = 4
FONT_WIDTH_CAP = 4
FONT_LAYOUT_TUPLE_CAP = 4
FONT_PAGE_BUDGET = 180
FONT_LINE_BUDGET = 36
FONT_TIER_REPRESENTATIVE_BUDGET = 24
_INVENTORY_BASE_CACHE: dict[str, dict[str, Any]] = {}
_FACE_TRUTH_CACHE: dict[str, dict[str, Any]] = {}
TIER_ORDER = [
    "Display Title",
    "Section Title",
    "Card Title",
    "Body",
    "Caption",
    "Footnote",
    "Badge",
]


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_text(value: Any) -> str:
    return str(value or "").strip()


def _font_files() -> tuple[list[tuple[Path, str, str, int, str]], dict[str, Any]]:
    command = shutil.which("fc-list")
    if not command:
        raise RuntimeError("fontconfig fc-list is not available on PATH")
    try:
        result = subprocess.run(
            [command, "--format=%{file}\t%{family}\t%{style}\t%{weight}\t%{charset}\n"],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"cannot enumerate system fonts: {error}") from error
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "fontconfig font enumeration failed")
    entries: dict[Path, tuple[str, str, int, str]] = {}
    for line in result.stdout.splitlines():
        fields = line.split("\t", 4)
        if len(fields) != 5:
            continue
        path = Path(fields[0].strip())
        if not path.is_file() or path.suffix.lower() not in {".ttf", ".otf", ".ttc", ".otc"}:
            continue
        family = _stable_text(fields[1]).split(",")[0] or path.stem
        subfamily = _stable_text(fields[2]).split(",")[0] or "Regular"
        try:
            fc_weight = int(float(fields[3]))
        except ValueError:
            fc_weight = 80
        weight = 700 if fc_weight >= 180 else 600 if fc_weight >= 120 else 500 if fc_weight >= 100 else 400
        entries[path] = (family, subfamily, weight, fields[4])
    paths = [(path, *entries[path]) for path in sorted(entries)]
    if not paths:
        raise RuntimeError("fontconfig reported no readable fonts")
    return paths, {"command": command, "status": "available", "version": "fontconfig"}


def _font_name(font: Any, identifiers: tuple[int, ...], fallback: str) -> str:
    for identifier in identifiers:
        for record in font["name"].names:
            if record.nameID != identifier:
                continue
            try:
                value = record.toUnicode().strip()
            except Exception:  # pragma: no cover - malformed font metadata
                continue
            if value:
                return value
    return fallback


def _parse_charset(value: str) -> set[int]:
    result: set[int] = set()
    for token in value.split():
        try:
            if "-" in token:
                start, end = (int(item, 16) for item in token.split("-", 1))
                result.update(range(start, end + 1))
            else:
                result.add(int(token, 16))
        except ValueError:
            continue
    return result


def _charset_flags(value: str) -> dict[str, bool]:
    """Inspect fontconfig charset ranges without expanding large CJK ranges."""

    latin = han = False
    digit_codes = set()
    for token in value.split():
        try:
            if "-" in token:
                start, end = (int(item, 16) for item in token.split("-", 1))
            else:
                start = end = int(token, 16)
        except ValueError:
            continue
        latin = latin or (start <= 0x41 <= end) or (start <= 0xE9 <= end)
        han = han or (start <= 0x4E00 <= end)
        digit_codes.update(code for code in range(max(0x30, start), min(0x39, end) + 1))
    return {"latin": bool(latin), "han": bool(han), "digits": len(digit_codes) == 10}


def _fontconfig_face(path: Path) -> tuple[str, str, int, set[int]]:
    command = shutil.which("fc-query")
    if not command:
        return path.stem, "Regular", 400, set()
    try:
        result = subprocess.run(
            [command, "--format=%{family}\n%{style}\n%{weight}\n%{charset}\n", str(path)],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return path.stem, "Regular", 400, set()
    lines = result.stdout.splitlines()
    family = _stable_text(lines[0] if lines else path.stem).split(",")[0]
    style = _stable_text(lines[1] if len(lines) > 1 else "Regular").split(",")[0]
    try:
        fc_weight = int(float(lines[2])) if len(lines) > 2 else 80
    except ValueError:
        fc_weight = 80
    weight = 700 if fc_weight >= 180 else 600 if fc_weight >= 120 else 500 if fc_weight >= 100 else 400
    charset = _parse_charset(" ".join(lines[3:]))
    return family or path.stem, style or "Regular", weight, charset


def _coverage(cmap: set[int]) -> dict[str, bool]:
    return {
        "latin": any(0x41 <= code <= 0x024F for code in cmap),
        "han": any(0x3400 <= code <= 0x9FFF for code in cmap),
        "digits": all(code in cmap for code in range(0x30, 0x3A)),
    }


def _face_record(path: Path, parse_fonttools: bool = True) -> tuple[dict[str, Any], set[int]] | None:
    digest = _digest(path)
    if TTFont is not None and parse_fonttools:
        try:
            parsed = TTFont(str(path), lazy=True, fontNumber=0)
            cmap = set(parsed.getBestCmap() or {})
            if not cmap:
                return None
            family = _font_name(parsed, (16, 1), path.stem)
            subfamily = _font_name(parsed, (17, 2), "Regular")
            os2 = parsed.get("OS/2")
            weight = int(getattr(os2, "usWeightClass", 400) or 400)
            weight = max(100, min(900, weight))
            parsed.close()
        except Exception:
            return None
    else:
        family, subfamily, weight, cmap = _fontconfig_face(path)
        if not cmap:
            return None
    face_digest = digest[:16]
    record = {
        "faceId": f"face-{face_digest}",
        "family": family,
        "selectionFamily": family,
        "actualFamily": family,
        "subfamily": subfamily,
        "pathEvidence": str(path),
        "pathDigest": digest,
        "runtimeIdentity": f"{family}|{subfamily}|{digest}",
        "weight": weight,
        "os2WeightClass": weight if TTFont is not None and parse_fonttools else None,
        "weightSource": "OS/2" if TTFont is not None and parse_fonttools else "fontconfig",
        "glyphCount": len(cmap),
        "coverage": _coverage(cmap),
        "requiredGlyphCount": 0,
        "missingGlyphCount": 0,
        "requiredGlyphs": [],
        "missingGlyphs": [],
    }
    return record, cmap


def discover_font_inventory(required_texts: Iterable[str] = ()) -> dict[str, Any]:
    """Discover local faces deterministically; never downloads or resolves remotely."""

    paths, fontconfig = _font_files()
    cache_key = str(fontconfig["command"])
    if cache_key in _INVENTORY_BASE_CACHE:
        inventory = copy.deepcopy(_INVENTORY_BASE_CACHE[cache_key])
        refresh_font_inventory(inventory, required_texts)
        return inventory
    metadata: list[tuple[Path, dict[str, Any], str]] = []
    for path, family, subfamily, weight, charset in paths:
        # Fontconfig already exposes family/style/weight/charset metadata.  Use
        # that cheap deterministic index to select the six families first;
        # parsing every CJK TTC through fontTools makes cold-start analysis
        # needlessly expensive.  The selected family representatives are then
        # parsed with fontTools below for strict runtime provenance.
        digest = _digest(path)
        record = {
            "faceId": f"face-{digest[:16]}",
            "family": family,
            "selectionFamily": family,
            "actualFamily": None,
            "subfamily": subfamily,
            "pathEvidence": str(path),
            "pathDigest": digest,
            "runtimeIdentity": f"{family}|{subfamily}|{digest}",
            "weight": weight,
            # Fontconfig weight is only a selection hint.  Do not present it
            # as an OS/2 truth value until this face is parsed lazily by
            # fontTools.
            "os2WeightClass": None,
            "weightSource": "fontconfig",
            "glyphCount": 0,
            "coverage": _charset_flags(charset),
            "requiredGlyphCount": 0,
            "missingGlyphCount": 0,
            "requiredGlyphs": [],
            "missingGlyphs": [],
        }
        metadata.append((path, record, charset))
    if not metadata:
        raise RuntimeError("no parseable local font faces")
    family_counts = Counter(record["family"] for _, record, _ in metadata)
    family_names = sorted(family_counts, key=lambda name: (-family_counts[name], name.casefold()))
    family_coverage = {
        family: {
            name: any(record["family"] == family and record["coverage"].get(name, False) for _, record, _ in metadata)
            for name in ("latin", "han", "digits")
        }
        for family in family_names
    }
    # Reserve a stable union for the three representative scripts, then fill
    # the remaining slots in deterministic family order.  Replacing the last
    # slot for each feature could otherwise evict an earlier reservation.
    reserved: list[str] = []
    for feature in ("latin", "han", "digits"):
        representative = next((family for family in family_names if family_coverage[family][feature]), None)
        if representative and representative not in reserved:
            reserved.append(representative)
    candidates = (reserved + [family for family in family_names if family not in reserved])[:FONT_FAMILY_CAP]
    representative_paths = {
        family: next(path for path, record, _ in metadata if record["family"] == family)
        for family in candidates
    }
    faces: list[dict[str, Any]] = []
    coverage: dict[str, set[int]] = {}
    for path, metadata_record, metadata_charset in metadata:
        if metadata_record["family"] not in candidates:
            continue
        if path in representative_paths.values():
            parsed = _face_record(path, parse_fonttools=True)
            if parsed is None:
                parsed = (metadata_record, _parse_charset(metadata_charset))
            record, cmap = parsed
        else:
            cmap = _parse_charset(metadata_charset)
            record = metadata_record
        # Keep selection alias and parsed typographic family separately.  The
        # alias remains the candidate-family key; ``family`` is actual truth
        # once fontTools has parsed this face.
        record["selectionFamily"] = metadata_record["family"]
        record.setdefault("actualFamily", record.get("family"))
        if record["selectionFamily"] not in candidates:
            continue
        faces.append(record)
        coverage[record["faceId"]] = cmap
    if not faces:
        raise RuntimeError("no parseable candidate font faces")
    faces.sort(key=lambda item: (item["selectionFamily"].casefold(), item["weight"], item["faceId"]))
    selected_faces = [face for face in faces if face["selectionFamily"] in candidates]
    selected_ids = {face["faceId"] for face in selected_faces}
    coverage = {face_id: cmap for face_id, cmap in coverage.items() if face_id in selected_ids}
    inventory = {
        "version": INVENTORY_VERSION,
        "kind": "offline-font-inventory",
        "offline": True,
        "runtime": {
            "fontTools": {
                "status": "available" if fontTools is not None else "unavailable",
                "version": str(getattr(fontTools, "__version__", "missing")),
                "requirement": "fonttools>=4.55,<5",
            },
            "fontconfig": fontconfig,
        },
        "candidateFamilies": candidates,
        "faces": selected_faces,
        "requiredGlyphs": [],
        "requiredGlyphCount": 0,
        "coverageSummary": {"latin": 0, "han": 0, "digits": 0},
        "solver": {
            "version": SOLVER_VERSION,
            "familyCap": FONT_FAMILY_CAP,
            "sizeCap": FONT_SIZE_CAP,
            "weightCap": FONT_WEIGHT_CAP,
            "spacingCap": FONT_SPACING_CAP,
            "pageBudget": FONT_PAGE_BUDGET,
            "lineBudget": FONT_LINE_BUDGET,
        },
        "_coverage": coverage,
    }
    _INVENTORY_BASE_CACHE[cache_key] = copy.deepcopy(inventory)
    refresh_font_inventory(inventory, required_texts)
    return inventory


def refresh_font_inventory(inventory: dict[str, Any], required_texts: Iterable[str]) -> dict[str, Any]:
    texts = [str(text) for text in required_texts if str(text)]
    codepoints = sorted({ord(character) for text in texts for character in text if ord(character) >= 0x20})
    inventory["requiredGlyphs"] = [f"U+{codepoint:04X}" for codepoint in codepoints]
    inventory["requiredGlyphCount"] = len(codepoints)
    summary = {"latin": 0, "han": 0, "digits": 0}
    for face in inventory.get("faces", []):
        cmap = inventory.get("_coverage", {}).get(face["faceId"], set())
        required = [codepoint for codepoint in codepoints if codepoint in cmap]
        missing = [codepoint for codepoint in codepoints if codepoint not in cmap]
        face["requiredGlyphCount"] = len(required)
        face["missingGlyphCount"] = len(missing)
        face["requiredGlyphs"] = [f"U+{codepoint:04X}" for codepoint in required]
        face["missingGlyphs"] = [f"U+{codepoint:04X}" for codepoint in missing]
        for name, present in _coverage(cmap).items():
            if present:
                summary[name] += 1
    inventory["coverageSummary"] = summary
    return inventory


def serializable_inventory(inventory: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in inventory.items() if not key.startswith("_")}


def _ensure_face_truth(inventory: dict[str, Any], face: dict[str, Any]) -> tuple[dict[str, Any], set[int]]:
    """Parse one selected face with fontTools and update its auditable truth.

    Fontconfig metadata is intentionally only a cheap selection hint.  Any
    face that reaches measurement (and therefore any final selected face) is
    parsed here so family, cmap, and OS/2 weight all come from the actual
    runtime font file.
    """

    if TTFont is None:
        raise RuntimeError("fontTools is required for selected font face measurement")
    path = Path(str(face.get("pathEvidence", "")))
    if not path.is_file():
        raise RuntimeError(f"selected font face is unavailable: {path}")
    digest = _digest(path)
    cache_key = f"{path}\0{digest}"
    cached = _FACE_TRUTH_CACHE.get(cache_key)
    if cached is None:
        try:
            parsed = TTFont(str(path), lazy=True, fontNumber=0)
            cmap = set(parsed.getBestCmap() or {})
            if not cmap:
                parsed.close()
                raise RuntimeError(f"selected font face has no cmap: {path}")
            family = _font_name(parsed, (16, 1), path.stem)
            subfamily = _font_name(parsed, (17, 2), "Regular")
            os2 = parsed.get("OS/2")
            if os2 is None or not isinstance(getattr(os2, "usWeightClass", None), int):
                parsed.close()
                raise RuntimeError(f"selected font face has no OS/2 weight class: {path}")
            weight = max(100, min(900, int(os2.usWeightClass)))
            parsed.close()
        except RuntimeError:
            raise
        except Exception as error:
            raise RuntimeError(f"cannot parse selected font face {path}: {error}") from error
        cached = {
            "family": family,
            "subfamily": subfamily,
            "weight": weight,
            "cmap": cmap,
            "digest": digest,
        }
        _FACE_TRUTH_CACHE[cache_key] = cached
    face["selectionFamily"] = face.get("selectionFamily", face.get("family", cached["family"]))
    face["actualFamily"] = cached["family"]
    face["family"] = cached["family"]
    face["subfamily"] = cached["subfamily"]
    face["pathDigest"] = cached["digest"]
    face["runtimeIdentity"] = f"{cached['family']}|{cached['subfamily']}|{cached['digest']}"
    face["weight"] = cached["weight"]
    face["os2WeightClass"] = cached["weight"]
    face["weightSource"] = "OS/2"
    face["glyphCount"] = len(cached["cmap"])
    face["coverage"] = _coverage(cached["cmap"])
    inventory.setdefault("_coverage", {})[face["faceId"]] = set(cached["cmap"])
    return face, set(cached["cmap"])


def _face_for(inventory: dict[str, Any], family: str, weight: int, text: str) -> dict[str, Any] | None:
    faces = [
        face for face in inventory.get("faces", [])
        if face.get("selectionFamily", face.get("family")) == family
    ]
    if not faces:
        return None
    wanted = {ord(character) for character in text if ord(character) >= 0x20}
    return min(
        faces,
        key=lambda face: (
            len(wanted - inventory.get("_coverage", {}).get(face["faceId"], set())),
            abs(int(face.get("weight", 400)) - weight),
            face.get("subfamily", "").casefold(),
            face.get("faceId", ""),
        ),
    )


def classify_text_tier(line: dict[str, Any], page_height: int) -> tuple[str, str]:
    role = _stable_text(line.get("regionRole") or line.get("semanticRole") or line.get("role")).casefold()
    direct = {
        "title": "Display Title",
        "display-title": "Display Title",
        "section-title": "Section Title",
        "section": "Section Title",
        "card-title": "Card Title",
        "body": "Body",
        "text": "Body",
        "caption": "Caption",
        "footer": "Footnote",
        "footnote": "Footnote",
        "badge": "Badge",
        "label": "Badge",
    }
    if role in direct:
        return direct[role], f"role:{role}"
    height = max(1.0, float(line.get("pixelBox", {}).get("h", 1)))
    ratio = height / max(1.0, float(page_height))
    if ratio >= 0.055:
        return "Display Title", "relative-height>=0.055"
    if ratio >= 0.038:
        return "Section Title", "relative-height>=0.038"
    if ratio >= 0.026:
        return "Card Title", "relative-height>=0.026"
    if ratio <= 0.012:
        return "Footnote", "relative-height<=0.012"
    return "Body", "unknown-role-fallback"


def build_tier_requirements(lines: Iterable[dict[str, Any]], page_height: int) -> dict[str, dict[str, Any]]:
    """Collect required glyphs before any representative face is measured."""

    requirements: dict[str, dict[str, Any]] = {}
    for line in lines:
        if line.get("disposition") not in {None, "editable-text"}:
            continue
        text = str(line.get("text", ""))
        if not text:
            continue
        tier, _ = classify_text_tier(line, page_height)
        item = requirements.setdefault(tier, {"texts": [], "codepoints": set(), "representativeObjectId": None})
        item["texts"].append(text)
        item["codepoints"].update(ord(character) for character in text if ord(character) >= 0x20)
        if item["representativeObjectId"] is None and line.get("id"):
            item["representativeObjectId"] = str(line["id"])
    for item in requirements.values():
        item["texts"] = list(item["texts"])
        item["requiredText"] = "\n".join(item["texts"])
        item["codepoints"] = sorted(item["codepoints"])
    return requirements


def infer_alignment(line: dict[str, Any], box: dict[str, Any], page_width: int) -> tuple[str, str, str]:
    """Infer alignment from explicit evidence or stable page geometry."""

    explicit = line.get("align")
    if explicit in {"left", "center", "right", "justify"}:
        return explicit, "explicit", "line.align"
    x = float(box.get("x", 0))
    width = max(1.0, float(box.get("w", 1)))
    right = x + width
    center = x + width / 2.0
    tolerance = max(8.0, page_width * 0.08)
    if abs(center - page_width / 2.0) <= tolerance:
        return "center", "geometry", "box-center-near-page-center"
    if abs(page_width - right) <= tolerance:
        return "right", "geometry", "box-right-near-page-edge"
    role = _stable_text(line.get("regionRole") or line.get("semanticRole") or line.get("role")).casefold()
    if role in {"title", "display-title", "section-title"} and abs(center - page_width / 2.0) <= page_width * 0.18:
        return "center", "geometry-role", "title-box-near-page-center"
    return "left", "geometry", "default-left-box-origin"


def _target_mask(image: Image.Image, box: dict[str, Any]) -> Image.Image:
    x, y = int(box["x"]), int(box["y"])
    w, h = max(1, int(box["w"])), max(1, int(box["h"]))
    crop = image.crop((x, y, x + w, y + h)).convert("RGB")
    pixels = list(crop.getdata())
    border = []
    for yy in range(h):
        for xx in range(w):
            if xx in (0, w - 1) or yy in (0, h - 1):
                border.append(pixels[yy * w + xx])
    background = Counter((pixel[0] // 8, pixel[1] // 8, pixel[2] // 8) for pixel in border).most_common(1)[0][0]
    bg = tuple(value * 8 + 4 for value in background)
    output = Image.new("L", (w, h), 0)
    out = output.load()
    for yy in range(h):
        for xx in range(w):
            pixel = pixels[yy * w + xx]
            distance = math.sqrt(sum((pixel[index] - bg[index]) ** 2 for index in range(3)))
            if distance >= 18:
                out[xx, yy] = 255
    return output


def _target_ink_metrics(mask: Image.Image) -> dict[str, float]:
    pixels = list(mask.getdata())
    area = max(1, mask.width * mask.height)
    ink = sum(1 for value in pixels if value >= 96)
    bbox = mask.getbbox() or (0, 0, 1, 1)
    bbox_area = max(1, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    return {
        "targetInkDensity": round(ink / area, 6),
        "targetInkBboxRatio": round(ink / bbox_area, 6),
    }


def _wrap_text(lines: list[str], font: ImageFont.FreeTypeFont, spacing_px: float, max_width_px: int) -> list[str]:
    """Deterministically wrap explicit OCR lines for both Latin and Han text."""

    wrapped: list[str] = []
    limit = max(1.0, float(max_width_px))
    for source in lines:
        if source == "":
            wrapped.append("")
            continue
        current = ""
        for character in source:
            proposed = current + character
            proposed_width = sum(float(font.getlength(char)) for char in proposed) + max(0, len(proposed) - 1) * spacing_px
            if current and proposed_width > limit:
                # Prefer a whitespace break for Latin while retaining a
                # character boundary for CJK and unspaced text.
                split_at = current.rfind(" ")
                if split_at > 0:
                    wrapped.append(current[:split_at])
                    current = current[split_at + 1:] + character
                else:
                    wrapped.append(current)
                    current = character
            else:
                current = proposed
        wrapped.append(current)
    return wrapped


def _measure_font_layout(
    path: str,
    size_pt: float,
    text: str,
    spacing_pt: float,
    line_height_pt: float,
    box_width_px: int,
) -> dict[str, Any]:
    """Measure deterministic line wrapping without rasterizing a candidate.

    Reused typography tiers call this helper so their current text layout can
    change with the target box while consuming no candidate render or budget.
    """

    size_px = max(1, int(round(float(size_pt) * PT_TO_PX)))
    spacing_px = float(spacing_pt) * PT_TO_PX
    font = ImageFont.truetype(path, size_px)
    source_lines = text.splitlines() or [text]
    container_width = max(1, int(box_width_px))
    lines = _wrap_text(source_lines, font, spacing_px, max(1, container_width - 8))
    return {
        "renderedLineCount": int(len(lines)),
        "lineBreaks": list(lines),
        "textBoxWidthPx": container_width,
        "lineHeightPt": round(float(line_height_pt), 4),
        "provenance": "selected-font-layout",
    }


def _render_font_mask(
    path: str,
    size_pt: float,
    text: str,
    spacing_pt: float,
    line_height_pt: float | None = None,
    box_width_px: int | None = None,
) -> tuple[Image.Image, dict[str, Any]]:
    size_px = max(1, int(round(float(size_pt) * PT_TO_PX)))
    spacing_px = float(spacing_pt) * PT_TO_PX
    font = ImageFont.truetype(path, size_px)
    source_lines = text.splitlines() or [text]
    natural_line_height = max(1, int(font.getbbox("Ag")[3] - font.getbbox("Ag")[1]))
    line_height = max(1, int(round(float(line_height_pt) * PT_TO_PX))) if line_height_pt is not None else natural_line_height
    wrap_width = max(1, int(box_width_px)) if box_width_px is not None else None
    lines = _wrap_text(source_lines, font, spacing_px, max(1, wrap_width - 8) if wrap_width is not None else 10**9)
    widths = []
    for line in lines:
        widths.append(sum(float(font.getlength(char)) for char in line) + max(0, len(line) - 1) * spacing_px)
    width = max(1, int(math.ceil(max(widths or [1])) + 8))
    if wrap_width is not None:
        width = max(width, wrap_width)
    height = max(1, int(math.ceil(line_height * len(lines) + 8)))
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    y = 4
    for line in lines:
        x = 4.0
        for character in line:
            draw.text((round(x), y), character, font=font, fill=255)
            x += float(font.getlength(character)) + spacing_px
        y += line_height
    bbox = mask.getbbox() or (0, 0, 1, 1)
    return mask, {
        "width": float(bbox[2] - bbox[0]),
        "height": float(bbox[3] - bbox[1]),
        "baseline": float(line_height),
        "lineCount": float(len(lines)),
        "renderedLineCount": int(len(lines)),
        "lineBreaks": [line for line in lines],
        "lineHeightPt": float(line_height / PT_TO_PX),
        "containerWidthPx": int(width),
        "bboxX": float(bbox[0]),
        "bboxY": float(bbox[1]),
        "fontSizePx": float(size_px),
        "charSpacingPx": float(spacing_px),
        "dpi": float(FONT_DPI),
        "ptToPx": float(PT_TO_PX),
    }


def _binary_pixels(image: Image.Image, size: tuple[int, int]) -> list[int]:
    resized = image.resize(size, Image.Resampling.BILINEAR)
    return [255 if value >= 96 else 0 for value in resized.getdata()]


def _ssim(left: list[int], right: list[int]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    mean_left = statistics.fmean(left)
    mean_right = statistics.fmean(right)
    var_left = statistics.fmean((value - mean_left) ** 2 for value in left)
    var_right = statistics.fmean((value - mean_right) ** 2 for value in right)
    covariance = statistics.fmean((a - mean_left) * (b - mean_right) for a, b in zip(left, right))
    c1, c2 = 6.5025, 58.5225
    denominator = (mean_left**2 + mean_right**2 + c1) * (var_left + var_right + c2)
    if denominator == 0:
        return 1.0 if left == right else 0.0
    return max(0.0, min(1.0, ((2 * mean_left * mean_right + c1) * (2 * covariance + c2)) / denominator))


def font_candidate_score(metrics: dict[str, float]) -> float:
    """Return a higher-is-better score used by both solver and tests."""

    return round(
        0.30 * float(metrics.get("inkBboxIou", 0.0))
        + 0.30 * float(metrics.get("localSsim", 0.0))
        + 0.12 * max(0.0, 1.0 - float(metrics.get("widthError", 1.0)))
        + 0.10 * max(0.0, 1.0 - float(metrics.get("heightError", 1.0)))
        + 0.06 * max(0.0, 1.0 - float(metrics.get("baselineError", 1.0)))
        + 0.06 * float(metrics.get("lineCountConsistency", 0.0))
        + 0.06 * float(metrics.get("ocrContentConsistency", 0.0)),
        6,
    )


def _render_box_from_metrics(image: Image.Image, target_box: dict[str, Any], render_metrics: dict[str, Any]) -> dict[str, int]:
    width = max(float(target_box["w"]), float(render_metrics.get("width", target_box["w"])) + 4.0)
    height = max(float(target_box["h"]), float(render_metrics.get("height", target_box["h"])) + 4.0)
    x = max(0.0, float(target_box["x"]) - max(0.0, (width - float(target_box["w"])) / 2.0))
    y = max(0.0, float(target_box["y"]) - max(0.0, (height - float(target_box["h"])) / 2.0))
    x = min(x, max(0.0, image.width - width))
    y = min(y, max(0.0, image.height - height))
    return {
        "x": round(x),
        "y": round(y),
        "w": round(min(width, image.width - x)),
        "h": round(min(height, image.height - y)),
    }


def solve_text_style(
    image: Image.Image,
    target_box: dict[str, Any],
    text: str,
    line: dict[str, Any],
    inventory: dict[str, Any],
    page_budget: dict[str, int] | None = None,
    object_id: str | None = None,
    tier_requirements: dict[str, dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]:
    state = page_budget or {"evaluated": 0, "limit": FONT_PAGE_BUDGET}
    state.setdefault("evaluated", 0)
    state.setdefault("limit", FONT_PAGE_BUDGET)
    target_mask = _target_mask(image, target_box)
    target_ink = _target_ink_metrics(target_mask)
    target_bbox = target_mask.getbbox() or (0, 0, max(1, int(target_box["w"])), max(1, int(target_box["h"])))
    target_width = max(1.0, float(target_box["w"]))
    target_height = max(1.0, float(target_box["h"]))
    tier, tier_evidence = classify_text_tier(line, image.height)
    alignment, alignment_source, alignment_evidence = infer_alignment(line, target_box, image.width)
    object_ref = str(object_id or line.get("id") or f"font-{tier.casefold().replace(' ', '-')}-representative")
    tier_representatives = state.setdefault("tierRepresentatives", {})
    tier_representative_objects = state.setdefault("tierRepresentativeObjects", {})
    representative = tier_representatives.get(tier)
    representative_object_id = tier_representative_objects.get(tier) or object_ref
    tier_requirements = tier_requirements or state.get("tierRequirements", {})
    if tier_requirements:
        state["tierRequirements"] = tier_requirements
    letters = [character for character in text if character.isalpha()]
    uppercase = bool(letters) and sum(character.isupper() for character in letters) / len(letters) >= 0.85
    requested_weights = [700, 500, 400] if uppercase or len(text) <= 4 else [400, 500, 700]
    requested_weights = requested_weights[:FONT_WEIGHT_CAP]
    base_size = max(6.0, min(72.0, target_height * 0.75))
    size_values = sorted({round(max(6.0, min(72.0, base_size * factor)), 2) for factor in (0.80, 0.90, 1.00, 1.10, 1.20)})[:FONT_SIZE_CAP]
    spacing_values = [-0.4, 0.0, 0.4][:FONT_SPACING_CAP]
    line_height_scales = [1.00, 1.15, 1.30, 1.50][:FONT_LINE_HEIGHT_CAP]
    width_scales = [0.80, 1.00, 1.20, 1.40][:FONT_WIDTH_CAP]
    families = list(inventory.get("candidateFamilies", []))[:FONT_FAMILY_CAP]
    if not families:
        raise RuntimeError("font inventory has no candidate families")
    if representative:
        # A tier representative has already been measured against the local
        # visual target.  Reuse that measured truth for all later members;
        # this branch performs no render and consumes no page budget.
        selected = dict(representative)
        selected["metrics"] = dict(selected.get("metrics", {}))
        selected["metricProvenance"] = "tier-representative"
        render_metrics = dict(selected.get("renderMetrics", {}))
        reuse_width_scale = float(selected.get("textBoxWidthScale", 1.0))
        reuse_line_height = float(selected.get("lineHeightPt", selected["fontSizePt"]))
        face = next((item for item in inventory.get("faces", []) if item.get("faceId") == selected.get("faceId")), None)
        if face is None or not face.get("pathEvidence"):
            raise RuntimeError(f"representative face {selected.get('faceId', '')} is unavailable for deterministic layout")
        layout = _measure_font_layout(
            face["pathEvidence"],
            float(selected["fontSizePt"]),
            text,
            float(selected["charSpacingPt"]),
            reuse_line_height,
            max(1, int(round(float(target_box["w"]) * reuse_width_scale))),
        )
        reuse_line_count = int(layout["renderedLineCount"])
        reuse_box = {
            **target_box,
            "w": layout["textBoxWidthPx"],
            "h": max(1, int(round(max(float(target_box["h"]), reuse_line_count * reuse_line_height * PT_TO_PX + 8.0)))),
        }
        render_box = _render_box_from_metrics(image, reuse_box, {"width": reuse_box["w"], "height": reuse_box["h"]})
        style = {
            "fontFamily": selected["family"],
            "fontSizePt": selected["fontSizePt"],
            "fontWeight": selected["weight"],
            "color": line.get("color") or "#111111",
            "bold": selected["weight"] >= 600,
            "charSpacingPt": selected["charSpacingPt"],
            "lineHeightPt": reuse_line_height,
            "textBoxWidthScale": reuse_width_scale,
            "textBoxWidthPx": layout["textBoxWidthPx"],
            "lineCount": reuse_line_count,
            "wrap": True,
            "align": alignment,
        }
        evidence = {
            "version": SOLVER_VERSION,
            "metricVersion": METRIC_VERSION,
            "dpi": FONT_DPI,
            "ptToPx": round(PT_TO_PX, 8),
            "tier": tier,
            "tierEvidence": tier_evidence,
            "representativeReuse": True,
            "representativeTierRef": tier,
            "representativeObjectId": representative_object_id,
            "alignmentProxy": alignment,
            "alignmentSource": alignment_source,
            "alignmentEvidence": alignment_evidence,
            "candidateCaps": {"families": FONT_FAMILY_CAP, "sizes": FONT_SIZE_CAP, "weights": FONT_WEIGHT_CAP, "spacing": FONT_SPACING_CAP, "lineHeight": FONT_LINE_HEIGHT_CAP, "boxWidth": FONT_WIDTH_CAP, "layoutTuples": FONT_LAYOUT_TUPLE_CAP},
            "budget": {"pageLimit": state["limit"], "pageEvaluated": state["evaluated"], "lineLimit": FONT_LINE_BUDGET, "lineEvaluated": 0},
            "selected": {
                "family": selected["family"],
                "selectionFamily": selected.get("selectionFamily", selected["family"]),
                "actualFamily": selected.get("actualFamily", selected["family"]),
                "faceId": selected["faceId"],
                "faceDigest": selected["faceDigest"],
                "fontSizePt": selected["fontSizePt"],
                "requestedWeight": selected["requestedWeight"],
                "weight": selected["weight"],
                "actualWeightClass": selected["actualWeightClass"],
                "charSpacingPt": selected["charSpacingPt"],
                "lineHeightPt": selected["lineHeightPt"],
                "textBoxWidthScale": selected["textBoxWidthScale"],
                "textBoxWidthPx": selected["textBoxWidthPx"],
                "renderedLineCount": selected.get("renderMetrics", {}).get("renderedLineCount", 0),
                "lineBreaks": selected.get("renderMetrics", {}).get("lineBreaks", []),
                "score": selected["score"],
                "scoreDirection": "higher-is-better",
                "missingGlyphs": [],
                "metrics": selected["metrics"],
                "metricProvenance": "tier-representative",
            },
            "targetMetrics": {**target_ink, "provenance": "current-line-observation"},
            "layout": layout,
            "evaluatedCandidates": 0,
            "evaluatedFamilies": [],
            "evaluatedFaceIds": [],
            "evaluatedSizes": [],
            "evaluatedRequestedWeights": [],
            "evaluatedSpacings": [],
            "evaluatedLineHeights": [],
            "evaluatedTextBoxWidthScales": [],
            "deferredCandidates": 0,
            "deferredReason": "representative-reuse",
        }
        return style, render_box, evidence, tier
    line_budget = min(FONT_TIER_REPRESENTATIVE_BUDGET, FONT_LINE_BUDGET)
    available = int(state["limit"]) - int(state["evaluated"])
    if available <= 0 or available < len(families):
        raise RuntimeError(
            f"font solver page budget exhausted before evaluating tier {tier}; "
            f"requiredFamilies={len(families)} available={max(0, available)}"
        )
    line_budget = min(line_budget, available)
    # Use explicit five-dimensional tuples rather than a cartesian product.
    # Every family is measured in each tuple's first pass.
    layout_tuples = [
        (min(2, len(size_values) - 1), 0, 0, 0, min(1, len(width_scales) - 1)),
        (0, min(1, len(requested_weights) - 1), min(1, len(spacing_values) - 1), min(1, len(line_height_scales) - 1), 0),
        (len(size_values) - 1, min(2, len(requested_weights) - 1), min(2, len(spacing_values) - 1), min(2, len(line_height_scales) - 1), min(2, len(width_scales) - 1)),
        (min(1, len(size_values) - 1), 0, min(2, len(spacing_values) - 1), min(3, len(line_height_scales) - 1), min(3, len(width_scales) - 1)),
    ][:FONT_LAYOUT_TUPLE_CAP]
    layout_tuples = list(dict.fromkeys(layout_tuples))
    combinations: list[tuple[int, int, int, int, int, int]] = []
    seen_combinations: set[tuple[int, int, int, int, int, int]] = set()
    for size_index, weight_index, spacing_index, line_height_index, width_index in layout_tuples:
        for family_index in range(len(families)):
            combination = (
                family_index,
                size_index,
                weight_index,
                spacing_index,
                line_height_index,
                width_index,
            )
            if combination in seen_combinations:
                continue
            seen_combinations.add(combination)
            combinations.append(combination)
            if len(combinations) >= line_budget:
                break
        if len(combinations) >= line_budget:
            break
    candidates: list[dict[str, Any]] = []
    attempted = 0
    deferred = 0
    target_pixels = _binary_pixels(target_mask, target_mask.size)
    requirement = (tier_requirements or {}).get(tier, {})
    coverage_text = str(requirement.get("requiredText") or text)
    for family_index, size_index, weight_index, spacing_index, line_height_index, width_index in combinations:
        family = families[family_index]
        size = float(size_values[size_index])
        requested_weight = int(requested_weights[weight_index])
        spacing = float(spacing_values[spacing_index])
        line_height_pt = round(size * float(line_height_scales[line_height_index]), 2)
        width_scale = float(width_scales[width_index])
        box_width_px = max(1, int(round(float(target_box["w"]) * width_scale)))
        face = _face_for(inventory, family, requested_weight, coverage_text)
        if face is None:
            deferred += 1
            continue
        try:
            face, cmap = _ensure_face_truth(inventory, face)
        except RuntimeError:
            deferred += 1
            continue
        missing = sorted({ord(character) for character in coverage_text if ord(character) >= 0x20 and ord(character) not in cmap})
        if missing:
            # A candidate that cannot render the OCR text is evidence of a
            # deferred/missing-glyph branch, never an eligible final style.
            deferred += 1
            continue
        attempted += 1
        state["evaluated"] += 1
        try:
            rendered, render_metrics = _render_font_mask(face["pathEvidence"], size, text, spacing, line_height_pt, box_width_px)
        except (OSError, ValueError) as error:
            deferred += 1
            continue
        resized = _binary_pixels(rendered, target_mask.size)
        intersection = sum(1 for left, right in zip(resized, target_pixels) if left and right)
        union = sum(1 for left, right in zip(resized, target_pixels) if left or right)
        iou = intersection / union if union else 0.0
        actual_weight = int(face["os2WeightClass"])
        metrics = {
            "inkBboxIou": round(iou, 6),
            "localSsim": round(_ssim(resized, target_pixels), 6),
            "widthError": round(abs(render_metrics["width"] - max(1, target_bbox[2] - target_bbox[0])) / target_width, 6),
            "heightError": round(abs(render_metrics["height"] - max(1, target_bbox[3] - target_bbox[1])) / target_height, 6),
            "baselineError": round(abs(render_metrics["baseline"] - target_height * 0.8) / target_height, 6),
            "lineCountConsistency": 1.0 if int(render_metrics.get("renderedLineCount", render_metrics["lineCount"])) == len(text.splitlines() or [text]) else 0.0,
            "ocrContentConsistency": 1.0,
            "provenance": "line-measurement",
        }
        candidates.append(
            {
                "familyIndex": family_index,
                "sizeIndex": size_index,
                "weightIndex": weight_index,
                "spacingIndex": spacing_index,
            "family": face["family"],
                "selectionFamily": face.get("selectionFamily", family),
                "actualFamily": face.get("actualFamily", face["family"]),
                "faceId": face["faceId"],
                "faceDigest": face["pathDigest"],
                "fontSizePt": size,
                "requestedWeight": requested_weight,
                "weight": actual_weight,
            "actualWeightClass": actual_weight,
            "charSpacingPt": spacing,
                "lineHeightPt": line_height_pt,
                "textBoxWidthScale": width_scale,
                "textBoxWidthPx": box_width_px,
                "missingGlyphs": [],
            "metrics": metrics,
                "score": round(font_candidate_score(metrics), 6),
                "renderMetrics": render_metrics,
            }
        )
    if not candidates:
        raise RuntimeError(
            f"no local font candidate covers OCR text {text!r}; "
            f"evaluated={attempted} deferred={deferred} tier={tier}"
        )
    selected = max(candidates, key=lambda candidate: (candidate["score"], -candidate["familyIndex"], -candidate["sizeIndex"], -candidate["weightIndex"], -candidate["spacingIndex"]))
    render_metrics = selected["renderMetrics"]
    rendered_line_count = int(render_metrics.get("renderedLineCount", render_metrics.get("lineCount", 1)))
    line_breaks = [str(value) for value in render_metrics.get("lineBreaks", [])]
    if len(line_breaks) != rendered_line_count:
        line_breaks = (text.splitlines() or [text])[:rendered_line_count]
        if len(line_breaks) < rendered_line_count:
            line_breaks.extend([""] * (rendered_line_count - len(line_breaks)))
    layout = {
        "renderedLineCount": rendered_line_count,
        "lineBreaks": line_breaks,
        "textBoxWidthPx": int(selected["textBoxWidthPx"]),
        "lineHeightPt": round(float(selected["lineHeightPt"]), 4),
        "provenance": "selected-font-layout",
    }
    layout_height = max(float(target_box["h"]), rendered_line_count * float(selected["lineHeightPt"]) * PT_TO_PX + 8.0)
    render_box = _render_box_from_metrics(
        image,
        target_box,
        {"width": layout["textBoxWidthPx"], "height": layout_height},
    )
    if tier not in tier_representatives:
        tier_representatives[tier] = dict(selected)
        tier_representative_objects[tier] = object_ref
    style = {
        "fontFamily": selected["family"],
        "fontSizePt": selected["fontSizePt"],
        "fontWeight": selected["weight"],
        "color": line.get("color") or "#111111",
        "bold": selected["weight"] >= 600,
        "charSpacingPt": selected["charSpacingPt"],
        "lineHeightPt": selected["lineHeightPt"],
        "textBoxWidthScale": selected["textBoxWidthScale"],
        "textBoxWidthPx": selected["textBoxWidthPx"],
        "lineCount": layout["renderedLineCount"],
        "wrap": True,
        "align": alignment,
    }
    total_combinations = len(families) * len(size_values) * len(requested_weights) * len(spacing_values) * len(line_height_scales) * len(width_scales)
    evaluated_families = sorted({candidate["family"] for candidate in candidates}, key=str.casefold)
    evaluated_face_ids = sorted({candidate["faceId"] for candidate in candidates})
    if total_combinations > len(combinations):
        deferred_reason = (
            "page-budget-cap"
            if available < min(FONT_TIER_REPRESENTATIVE_BUDGET, FONT_LINE_BUDGET)
            else "tier-budget-cap"
        )
    elif deferred:
        deferred_reason = "missing-glyph-or-unreadable-face"
    else:
        deferred_reason = None
    evidence = {
        "version": SOLVER_VERSION,
        "metricVersion": METRIC_VERSION,
        "dpi": FONT_DPI,
        "ptToPx": round(PT_TO_PX, 8),
        "tier": tier,
        "tierEvidence": tier_evidence,
        "representativeReuse": bool(representative),
        "representativeTierRef": tier,
        "representativeObjectId": representative_object_id if representative else object_ref,
        "alignmentSource": alignment_source,
        "alignmentEvidence": alignment_evidence,
        "alignmentProxy": style["align"],
        "candidateCaps": {"families": FONT_FAMILY_CAP, "sizes": FONT_SIZE_CAP, "weights": FONT_WEIGHT_CAP, "spacing": FONT_SPACING_CAP, "lineHeight": FONT_LINE_HEIGHT_CAP, "boxWidth": FONT_WIDTH_CAP, "layoutTuples": FONT_LAYOUT_TUPLE_CAP},
        "budget": {"pageLimit": state["limit"], "pageEvaluated": state["evaluated"], "lineLimit": FONT_LINE_BUDGET, "lineEvaluated": attempted},
        "selected": {
            "family": selected["family"],
            "selectionFamily": selected.get("selectionFamily", families[selected["familyIndex"]]),
            "actualFamily": selected.get("actualFamily", selected["family"]),
            "faceId": selected["faceId"],
            "faceDigest": selected["faceDigest"],
            "fontSizePt": selected["fontSizePt"],
            "requestedWeight": selected["requestedWeight"],
            "weight": selected["weight"],
            "actualWeightClass": selected["actualWeightClass"],
            "charSpacingPt": selected["charSpacingPt"],
            "lineHeightPt": selected["lineHeightPt"],
            "textBoxWidthScale": selected["textBoxWidthScale"],
            "textBoxWidthPx": selected["textBoxWidthPx"],
            "renderedLineCount": selected["renderMetrics"].get("renderedLineCount", selected["renderMetrics"].get("lineCount", 0)),
            "lineBreaks": selected["renderMetrics"].get("lineBreaks", []),
            "score": selected["score"],
            "scoreDirection": "higher-is-better",
            "missingGlyphs": selected["missingGlyphs"],
            "metrics": selected["metrics"],
            "metricProvenance": "line-measurement",
        },
        "targetMetrics": {**target_ink, "provenance": "current-line-observation"},
        "layout": layout,
        "evaluatedCandidates": len(candidates),
        "evaluatedFamilies": evaluated_families,
        "evaluatedFaceIds": evaluated_face_ids,
        "evaluatedSizes": sorted({candidate["fontSizePt"] for candidate in candidates}),
        "evaluatedRequestedWeights": sorted({candidate["requestedWeight"] for candidate in candidates}),
        "evaluatedSpacings": sorted({candidate["charSpacingPt"] for candidate in candidates}),
        "evaluatedLineHeights": sorted({candidate["lineHeightPt"] for candidate in candidates}),
        "evaluatedTextBoxWidthScales": sorted({candidate["textBoxWidthScale"] for candidate in candidates}),
        "deferredCandidates": max(0, total_combinations - len(candidates)),
        "deferredReason": deferred_reason,
    }
    return style, render_box, evidence, tier


def apply_typography_tiers(
    objects: list[dict[str, Any]],
    lines: list[dict[str, Any]],
    page_size: tuple[int, int],
    inventory: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    line_by_id = {str(line.get("id")): line for line in lines}
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    reasons: dict[str, Counter[str]] = defaultdict(Counter)
    for obj in objects:
        if obj.get("type") != "text":
            continue
        line = line_by_id.get(str(obj.get("id")), {})
        tier, reason = classify_text_tier(line or {"pixelBox": obj.get("pixelBox", {})}, page_size[1])
        groups[tier].append(obj)
        reasons[tier][reason] += 1
    tiers = []
    for tier_name in TIER_ORDER:
        members = sorted(groups.get(tier_name, []), key=lambda item: str(item.get("id")))
        if not members:
            continue
        representatives = [
            item for item in members
            if not item.get("fontSolver", {}).get("representativeReuse", False)
        ]
        if len(representatives) != 1:
            raise RuntimeError(f"tier {tier_name} must have exactly one measured representative; got {len(representatives)}")
        representative = representatives[0]
        representative_solver = representative.get("fontSolver", {})
        representative_selected = representative_solver.get("selected", {})
        if not representative_selected:
            raise RuntimeError(f"tier {tier_name} representative has no selected font truth")
        family = str(representative_selected.get("family", ""))
        face_id = str(representative_selected.get("faceId", ""))
        weight = int(representative_selected.get("actualWeightClass", representative_selected.get("weight", 0)))
        base_size = float(representative_selected.get("fontSizePt", 0))
        spacing = float(representative_selected.get("charSpacingPt", 0))
        line_height = float(representative_selected.get("lineHeightPt", 0))
        width_scale = float(representative_selected.get("textBoxWidthScale", 0))
        if not family or not face_id or not (100 <= weight <= 900) or base_size <= 0 or line_height <= 0 or width_scale <= 0:
            raise RuntimeError(f"tier {tier_name} representative selected truth is incomplete")
        tier_face = None
        if inventory:
            tier_face = next((face for face in inventory.get("faces", []) if face.get("faceId") == face_id), None)
            if tier_face is None or tier_face.get("family") != family or tier_face.get("os2WeightClass") != weight:
                raise RuntimeError(f"tier {tier_name} representative face truth is inconsistent")
        tier_id = f"typography-tier-{tier_name.lower().replace(' ', '-') }"
        for member in members:
            member_solver = member.get("fontSolver", {})
            selected = member_solver.get("selected", {})
            style = member.get("style", {})
            expected = {
                "family": family,
                "faceId": face_id,
                "weight": weight,
                "actualWeightClass": weight,
                "fontSizePt": base_size,
                "charSpacingPt": spacing,
                "lineHeightPt": line_height,
                "textBoxWidthScale": width_scale,
            }
            actual = {
                "family": selected.get("family"),
                "faceId": selected.get("faceId"),
                "weight": selected.get("weight"),
                "actualWeightClass": selected.get("actualWeightClass"),
                "fontSizePt": selected.get("fontSizePt"),
                "charSpacingPt": selected.get("charSpacingPt"),
                "lineHeightPt": selected.get("lineHeightPt"),
                "textBoxWidthScale": selected.get("textBoxWidthScale"),
            }
            if actual != expected or style.get("fontFamily") != family or style.get("fontWeight") != weight or float(style.get("fontSizePt", 0)) != base_size or not isinstance(style.get("charSpacingPt"), (int, float)) or float(style["charSpacingPt"]) != spacing or float(style.get("lineHeightPt", 0)) != line_height or float(style.get("textBoxWidthScale", 0)) != width_scale:
                raise RuntimeError(f"tier {tier_name} member {member.get('id')} selected/style truth does not match representative")
            if member_solver.get("tier") != tier_name:
                raise RuntimeError(f"tier {tier_name} member {member.get('id')} solver tier mismatch")
            member["typographyTierRef"] = tier_id
        line_heights = [float(item.get("style", {}).get("lineHeightPt", base_size * 1.2)) for item in members]
        line_height = round(float(representative.get("style", {}).get("lineHeightPt", statistics.median(line_heights))), 2)
        alignments = Counter(str(item.get("style", {}).get("align", "left")) for item in members)
        align = alignments.most_common(1)[0][0]
        alignment_sources = Counter(str(item.get("fontSolver", {}).get("alignmentSource", "unknown")) for item in members)
        heights = sorted(float(item.get("pixelBox", {}).get("h", 0)) for item in members)
        fit_ink: list[float] = []
        fit_ssim: list[float] = []
        width_errors: list[float] = []
        target_density: list[float] = []
        target_bbox_ratio: list[float] = []
        colors = Counter()
        layout_refs: list[str] = []
        for item in members:
            style = item.get("style", {})
            color = str(style.get("color", ""))
            if color:
                colors[color] += 1
            layout_ref = item.get("layoutGroupRef") or item.get("layoutGroupRefs")
            if isinstance(layout_ref, list):
                layout_refs.extend(str(value) for value in layout_ref if value)
            elif layout_ref:
                layout_refs.append(str(layout_ref))
            metrics = item.get("fontSolver", {}).get("selected", {}).get("metrics", {})
            target_metrics = item.get("fontSolver", {}).get("targetMetrics", {})
            if isinstance(metrics, dict):
                if isinstance(metrics.get("inkBboxIou"), (int, float)):
                    fit_ink.append(float(metrics["inkBboxIou"]))
                if isinstance(metrics.get("localSsim"), (int, float)):
                    fit_ssim.append(float(metrics["localSsim"]))
                if isinstance(metrics.get("widthError"), (int, float)):
                    width_errors.append(float(metrics["widthError"]))
                if isinstance(target_metrics.get("targetInkDensity"), (int, float)):
                    target_density.append(float(target_metrics["targetInkDensity"]))
                if isinstance(target_metrics.get("targetInkBboxRatio"), (int, float)):
                    target_bbox_ratio.append(float(target_metrics["targetInkBboxRatio"]))
        repeated_refs = sorted({ref for ref in layout_refs if layout_refs.count(ref) > 1})
        tiers.append(
            {
                "id": tier_id,
                "name": tier_name,
                "memberRefs": [str(item.get("id")) for item in members],
                "fontFamily": family,
                "fontWeight": weight,
                "baseFontSizePt": round(base_size, 2),
                "lineHeightPt": line_height,
                "textBoxWidthScale": width_scale,
                "align": align,
                "faceId": face_id,
                "evidence": {
                    "signals": [{"name": name, "count": count} for name, count in sorted(reasons[tier_name].items())],
                    "memberCount": len(members),
                    "stableOrder": "object-id-ascending",
                    "heightDistribution": {"min": round(min(heights), 2), "median": round(statistics.median(heights), 2), "max": round(max(heights), 2)},
                    "inkStrokeProxy": {
                        "inkBboxIouMedian": round(statistics.median(fit_ink), 6) if fit_ink else None,
                        "localSsimMedian": round(statistics.median(fit_ssim), 6) if fit_ssim else None,
                        "widthErrorMedian": round(statistics.median(width_errors), 6) if width_errors else None,
                        "targetInkDensityMedian": round(statistics.median(target_density), 6) if target_density else None,
                        "targetInkBboxRatioMedian": round(statistics.median(target_bbox_ratio), 6) if target_bbox_ratio else None,
                    },
                    "styleColors": [{"value": value, "count": count} for value, count in sorted(colors.items())],
                    "alignmentProxy": [{"value": value, "count": count} for value, count in sorted(alignments.items())],
                    "alignmentSources": [{"value": value, "count": count} for value, count in sorted(alignment_sources.items())],
                    "layoutGroupRefs": sorted(set(layout_refs)),
                    "repeatedGroupRefs": repeated_refs,
                },
            }
        )
    return tiers
