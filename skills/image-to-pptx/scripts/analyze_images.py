#!/usr/bin/env python3
"""Analyze slide images into a source-bound, native-first reconstruction plan."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import shutil
import sys
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable


def configure_ocr_runtime() -> None:
    """Keep Tesseract's OpenMP worker count bounded and deterministic.

    Callers may explicitly choose another value; the default only prevents
    oversubscription from making the OCR subprocess unbounded in constrained
    runtimes.
    """

    os.environ.setdefault("OMP_THREAD_LIMIT", "1")


configure_ocr_runtime()

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError as error:  # pragma: no cover - exercised by doctor/error tests
    raise SystemExit(
        json.dumps(
            {
                "status": "failed",
                "code": "E_OCR_RUNTIME",
                "message": f"Pillow is required: {error}",
            }
        )
    ) from error

try:
    import pytesseract
except ImportError:  # pragma: no cover - exercised by doctor/error tests
    pytesseract = None

from layer_recovery import analyze_layers, infer_layers
from font_solver import (
    apply_typography_tiers,
    build_tier_requirements,
    discover_font_inventory,
    refresh_font_inventory,
    serializable_inventory,
    solve_text_style,
)
from reconstruction_planner import ReconstructionPlanError, build_reconstruction_plan

VERSION = "1.0.0"
MAX_ENCODED_BYTES = 50 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_SIDE = 8192
CANONICAL_WIDTH_PX = 1280
SLIDE_WIDTH_IN = 13.333
COLOR_TOLERANCE = 10
LAYOUT_GROUP_GAP_PX = 18
MAX_REGION_OCR_CANDIDATES = 2
DEFAULT_REGION_OCR_CANDIDATES = 1
MAX_PAGE_REGION_OCR_CALLS = 24
OWNERSHIP_VERSION = "1.0.0"
OWNERSHIP_TOLERANCE_PX = 2
UNASSIGNED_PIXEL_BUDGET = 0.0

# PSM is selected from observed region roles only.  The mapping is deliberately
# small and stable so a caller can audit every regional OCR request without
# depending on a layout model or a network service.
ROLE_PSM = {
    "title": 7,
    "section-title": 7,
    "body": 6,
    "text": 6,
    "caption": 13,
    "footer": 8,
    "label": 8,
    "badge": 8,
    "number": 10,
    "image": 13,
    "shape": 13,
    "connector": 13,
    "unknown": 6,
}
OPTIONAL_PROVIDER_METADATA = [
    {
        "name": "paddle-layout",
        "contract": "LayoutProvider",
        "status": "not-installed",
        "network": False,
    }
]


class AnalysisError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    @property
    def area(self) -> int:
        return self.w * self.h

    def clamp(self, width: int, height: int) -> "Box":
        x = max(0, min(self.x, width - 1))
        y = max(0, min(self.y, height - 1))
        right = max(x + 1, min(self.right, width))
        bottom = max(y + 1, min(self.bottom, height))
        return Box(x, y, right - x, bottom - y)

    def expand(self, pixels: int, width: int, height: int) -> "Box":
        return Box(
            self.x - pixels,
            self.y - pixels,
            self.w + pixels * 2,
            self.h + pixels * 2,
        ).clamp(width, height)

    def as_dict(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


def box_polygon(box: Box) -> list[dict[str, int]]:
    """Return a clockwise quadrilateral for consumers that need precise bounds.

    Tesseract's data API exposes axis-aligned boxes only.  We retain the original
    rectangle and make that limitation explicit by emitting its four corners as a
    polygon instead of pretending to know a tighter glyph outline.
    """

    return [
        {"x": box.x, "y": box.y},
        {"x": box.right, "y": box.y},
        {"x": box.right, "y": box.bottom},
        {"x": box.x, "y": box.bottom},
    ]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(code: str, message: str) -> None:
    raise AnalysisError(code, message)


def command_languages() -> set[str]:
    binary = shutil.which("tesseract")
    if not binary:
        fail("E_OCR_RUNTIME", "Tesseract is not available on PATH")
    try:
        output = __import__("subprocess").run(
            [binary, "--list-langs"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, __import__("subprocess").TimeoutExpired) as error:
        fail("E_OCR_RUNTIME", f"cannot inspect Tesseract languages: {error}")
    if output.returncode != 0:
        fail("E_OCR_RUNTIME", output.stderr.strip() or "cannot inspect Tesseract languages")
    return {
        line.strip()
        for line in output.stdout.splitlines()
        if line.strip() and not line.lower().startswith("list of available")
    }


def requested_language_tokens(langs: str) -> list[str]:
    """Return a stable, duplicate-free language request in CLI order."""

    tokens = [item.strip() for item in str(langs).split("+") if item.strip()]
    if not tokens:
        fail("E_OCR_RUNTIME", "--langs must name at least one language or auto")
    if len(tokens) > 1 and "auto" in tokens:
        fail("E_OCR_RUNTIME", "--langs auto cannot be combined with explicit languages")
    result: list[str] = []
    for token in tokens:
        if token not in result:
            result.append(token)
    return result


def resolve_language_request(
    langs: str,
    available: set[str] | Iterable[str],
    orientation: dict[str, Any] | None = None,
) -> tuple[list[str], dict[str, Any]]:
    """Resolve explicit or ``auto`` language requests without substitution.

    Explicit requests are checked verbatim.  ``auto`` uses only Tesseract OSD
    script evidence and a deterministic mapping to the two supported baseline
    packs.  A missing mapped pack is a stable error rather than a silent
    replacement with another installed language.
    """

    requested = requested_language_tokens(langs)
    available_set = {str(item) for item in available}
    orientation = orientation or {}
    script = str(orientation.get("script") or "").strip()
    script_lower = script.lower()
    status = orientation.get("status", "unavailable")
    source = orientation.get("source") or "tesseract-osd"
    if requested == ["auto"]:
        if any(token in script_lower for token in ("han", "chinese", "cjk")):
            resolved = ["chi_sim", "eng"]
            mapping = "osd-script:han->chi_sim+eng"
        elif any(token in script_lower for token in ("latin", "english")):
            resolved = ["eng"]
            mapping = "osd-script:latin->eng"
        elif not script:
            fail(
                "E_OCR_RUNTIME",
                "Tesseract OSD provided no script evidence for --langs auto; "
                "use --langs eng or --langs chi_sim+eng",
            )
        else:
            fail(
                "E_OCR_RUNTIME",
                f"Tesseract OSD script is unsupported for --langs auto: {script}; "
                "use --langs eng or --langs chi_sim+eng",
            )
        missing = sorted(set(resolved) - available_set)
        if missing:
            fail(
                "E_OCR_RUNTIME",
                f"Tesseract language data missing for auto resolution: {', '.join(missing)}; "
                f"script={script or 'unavailable'}; available={', '.join(sorted(available_set))}",
            )
        evidence = {
            "mode": "auto",
            "detectedScript": script or None,
            "detectionStatus": str(status),
            "detectionSource": str(source),
            "mapping": mapping,
        }
        return resolved, evidence

    missing = sorted(set(requested) - available_set)
    if missing:
        fail(
            "E_OCR_RUNTIME",
            f"Tesseract language data missing: {', '.join(missing)}; "
            f"available={', '.join(sorted(available_set))}",
        )
    return requested, {
        "mode": "explicit",
        "detectedScript": script or None,
        "detectionStatus": str(status),
        "detectionSource": str(source),
        "mapping": "explicit-request",
    }


def validate_ocr_runtime(
    langs: str,
    orientation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if pytesseract is None:
        fail("E_OCR_RUNTIME", "pytesseract is required; install requirements.txt")
    available = command_languages()
    resolved, evidence = resolve_language_request(langs, available, orientation)
    requested = requested_language_tokens(langs)
    version = str(pytesseract.get_tesseract_version()).splitlines()[0]
    return {
        "engine": "tesseract",
        "version": version,
        "provider": {
            "name": "tesseract",
            "contract": "OcrProvider",
            "wholePagePsm": 11,
            "regionPsms": [6, 7, 8, 10, 13],
            "optionalProviders": OPTIONAL_PROVIDER_METADATA,
        },
        "langs": "+".join(resolved),
        "requestedLanguages": requested,
        "resolvedLanguages": resolved,
        "resolutionEvidence": evidence,
        "availableLanguages": sorted(available),
        "languagePacks": sorted(available),
    }


def parse_osd(payload: str) -> dict[str, Any]:
    values: dict[str, str] = {}
    for line in payload.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.strip().lower().replace(" ", "_")] = value.strip()

    def integer(name: str, default: int = 0) -> int:
        try:
            return int(float(values.get(name, default)))
        except (TypeError, ValueError):
            return default

    def number(name: str) -> float | None:
        try:
            return round(float(values[name]), 4)
        except (KeyError, TypeError, ValueError):
            return None

    orientation = integer("orientation_in_degrees") % 360
    rotate = integer("rotate") % 360
    return {
        "status": "ok",
        "engine": "tesseract-osd",
        "orientationDegrees": orientation,
        "rotateDegrees": rotate,
        "orientationConfidence": number("orientation_confidence"),
        "script": values.get("script") or None,
        "scriptConfidence": number("script_confidence"),
        "source": "pytesseract.image_to_osd",
    }


def orientation_metadata(image: Image.Image) -> dict[str, Any]:
    """Read orientation/script evidence without making an irreversible correction.

    OSD is advisory: coordinates and pixels stay in the normalized source frame,
    while the detected correction angle is recorded for downstream consumers.
    A missing or low-text OSD result is reported as unavailable rather than
    treated as a confident default.
    """

    assert pytesseract is not None
    try:
        payload = pytesseract.image_to_osd(image, config="--psm 0")
    except Exception as error:  # pragma: no cover - depends on local OSD data
        return {
            "status": "unavailable",
            "engine": "tesseract-osd",
            "orientationDegrees": None,
            "rotateDegrees": None,
            "orientationConfidence": None,
            "script": None,
            "scriptConfidence": None,
            "source": "pytesseract.image_to_osd",
            "reason": str(error),
        }
    try:
        return parse_osd(payload)
    except Exception as error:  # pragma: no cover - defensive parser boundary
        return {
            "status": "unavailable",
            "engine": "tesseract-osd",
            "orientationDegrees": None,
            "rotateDegrees": None,
            "orientationConfidence": None,
            "script": None,
            "scriptConfidence": None,
            "source": "pytesseract.image_to_osd",
            "reason": f"invalid OSD payload: {error}",
        }


def language_metadata(
    requested_langs: str | Iterable[str],
    orientation: dict[str, Any],
    resolved_langs: str | Iterable[str] | None = None,
    resolution_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if isinstance(requested_langs, str):
        requested = requested_language_tokens(requested_langs)
    else:
        requested = [str(item) for item in requested_langs]
    if resolved_langs is None:
        resolved = requested
    elif isinstance(resolved_langs, str):
        resolved = requested_language_tokens(resolved_langs)
    else:
        resolved = [str(item) for item in resolved_langs]
    return {
        "requested": requested,
        "resolved": resolved,
        "ocrLanguageString": "+".join(resolved),
        "detectedScript": orientation.get("script"),
        "detectedScriptConfidence": orientation.get("scriptConfidence"),
        "detectionStatus": orientation.get("status", "unavailable"),
        "detectionSource": orientation.get("source"),
        "resolutionEvidence": resolution_evidence
        or {
            "mode": "explicit",
            "detectedScript": orientation.get("script"),
            "detectionStatus": orientation.get("status", "unavailable"),
            "detectionSource": orientation.get("source") or "tesseract-osd",
            "mapping": "explicit-request",
        },
    }


def load_source(path: Path) -> Image.Image:
    if not path.is_file():
        fail("E_INPUT_FORMAT", f"image not found: {path}")
    size = path.stat().st_size
    if size > MAX_ENCODED_BYTES:
        fail("E_INPUT_LIMIT", f"image exceeds 50 MiB encoded limit: {path}")
    try:
        with Image.open(path) as opened:
            opened.verify()
        with Image.open(path) as opened:
            width, height = opened.size
            if (
                width <= 0
                or height <= 0
                or width > MAX_SIDE
                or height > MAX_SIDE
                or width * height > MAX_PIXELS
            ):
                fail(
                    "E_INPUT_LIMIT",
                    f"image exceeds decoded limit (8192px/side, 16MP): {path}",
                )
            return opened.convert("RGB")
    except AnalysisError:
        raise
    except Exception as error:
        fail("E_INPUT_FORMAT", f"unsupported or corrupt image {path}: {error}")


def rgb_hex(color: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*color)


def color_distance(left: tuple[int, int, int], right: tuple[int, int, int]) -> float:
    return math.sqrt(sum((left[index] - right[index]) ** 2 for index in range(3)))


def dominant_palette(image: Image.Image, count: int = 10) -> list[dict[str, Any]]:
    sample = image.resize((160, max(1, round(160 * image.height / image.width))))
    quantized = sample.quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette() or []
    pixels = list(quantized.getdata())
    total = max(1, len(pixels))
    result = []
    for index, frequency in Counter(pixels).most_common(count):
        offset = index * 3
        color = tuple(palette[offset : offset + 3])
        if len(color) != 3:
            continue
        result.append(
            {
                "hex": rgb_hex(color),  # type: ignore[arg-type]
                "share": round(frequency / total, 6),
            }
        )
    return result


def edge_background(image: Image.Image) -> tuple[int, int, int]:
    rgb = image.load()
    width, height = image.size
    points: list[tuple[int, int, int]] = []
    step_x = max(1, width // 80)
    step_y = max(1, height // 45)
    for x in range(0, width, step_x):
        points.append(rgb[x, 0])
        points.append(rgb[x, height - 1])
    for y in range(0, height, step_y):
        points.append(rgb[0, y])
        points.append(rgb[width - 1, y])
    return Counter(points).most_common(1)[0][0]


def foreground_color(image: Image.Image, box: Box) -> str:
    crop = image.crop((box.x, box.y, box.right, box.bottom))
    colors = crop.getcolors(maxcolors=max(1, box.area)) or []
    if not colors:
        return "#172033"
    ordered = sorted(colors, reverse=True)
    background = ordered[0][1]
    candidates = [
        (frequency, color)
        for frequency, color in ordered[1:]
        if color_distance(color, background) >= 55
    ]
    selected = max(candidates, default=(0, (23, 32, 51)))[1]
    return rgb_hex(selected)


class OcrProvider:
    """Minimal deterministic OCR provider contract.

    Providers receive a bounded image crop, the already-resolved language
    string, and an explicit Tesseract page segmentation mode.  They return the
    provider's data payload; no provider may invent text outside that payload.
    """

    name = "ocr-provider"

    def recognize(self, image: Image.Image, langs: str, psm: int) -> Any:
        raise NotImplementedError


class TesseractProvider(OcrProvider):
    name = "tesseract"

    def __init__(self, backend: Any | None = None):
        self.backend = backend or pytesseract
        if self.backend is None:
            fail("E_OCR_RUNTIME", "pytesseract is required; install requirements.txt")

    def recognize(self, image: Image.Image, langs: str, psm: int) -> Any:
        return self.backend.image_to_data(
            image,
            lang=langs,
            config=f"--psm {int(psm)}",
            output_type=self.backend.Output.DICT,
        )


def psm_for_role(role: str) -> int:
    return int(ROLE_PSM.get(str(role).strip().lower(), ROLE_PSM["unknown"]))


def classify_line_role(line: dict[str, Any], image_size: tuple[int, int]) -> str:
    """Classify an OCR line from its observed geometry and text only."""

    _, height = image_size
    box = line.get("pixelBox") or {}
    y = float(box.get("y", 0))
    line_height = float(box.get("h", 0))
    text = str(line.get("text", ""))
    alnum = sum(character.isalnum() for character in text)
    if y >= height * 0.88 and alnum >= 2:
        return "footer"
    if y <= height * 0.18 and alnum >= 4:
        return "title"
    if text.strip().isdigit() and alnum <= 8:
        return "number"
    if alnum <= 12 and line_height <= max(18, height * 0.045):
        return "label"
    if line_height <= max(14, height * 0.028):
        return "caption"
    return "body"


def preprocessing_candidates(
    image: Image.Image,
    role: str,
    max_candidates: int = DEFAULT_REGION_OCR_CANDIDATES,
) -> list[tuple[str, Image.Image]]:
    """Return at most the explicitly bounded regional preprocessing candidates."""

    limit = max(1, min(int(max_candidates), MAX_REGION_OCR_CANDIDATES))
    candidates: list[tuple[str, Image.Image]] = [("original", image.convert("RGB"))]
    if limit > 1:
        # Grayscale is a deterministic second candidate that preserves pixels
        # and avoids threshold values that could erase small colored glyphs.
        candidates.append(("grayscale", image.convert("L")))
    return candidates[:limit]


def _candidate_text_similarity(candidate: str, expected: str) -> float:
    left = "".join(character.lower() for character in candidate if character.isalnum())
    right = "".join(character.lower() for character in expected if character.isalnum())
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left, right, autojunk=False).ratio()


def _box_stability(candidate: dict[str, Any], expected_box: dict[str, Any] | None) -> float:
    if not expected_box:
        return 0.0
    try:
        left = Box(**{key: int(round(float(expected_box[key]))) for key in ("x", "y", "w", "h")})
        right = Box(**{key: int(round(float(candidate["pixelBox"][key]))) for key in ("x", "y", "w", "h")})
    except (KeyError, TypeError, ValueError):
        return 0.0
    intersection = max(0, min(left.right, right.right) - max(left.x, right.x)) * max(
        0, min(left.bottom, right.bottom) - max(left.y, right.y)
    )
    union = max(1, left.area + right.area - intersection)
    return intersection / union


def select_ocr_candidate(
    candidates: Iterable[dict[str, Any]],
    expected_text: str = "",
    expected_box: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Select one candidate using content, confidence, and box stability.

    Sorting all terms explicitly makes ties independent of dictionary order or
    provider iteration order.  The returned mapping is a copy of the selected
    candidate and records the score components for the OCR report.
    """

    scored: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates):
        text = str(candidate.get("text", "")).strip()
        if not text:
            continue
        try:
            confidence = max(0.0, min(1.0, float(candidate.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0
        content = _candidate_text_similarity(text, expected_text)
        stability = _box_stability(candidate, expected_box)
        score = 0.50 * content + 0.35 * confidence + 0.15 * stability
        scored.append(
            {
                **candidate,
                "confidence": round(confidence, 4),
                "selectionScore": round(score, 6),
                "contentSimilarity": round(content, 6),
                "boxStability": round(stability, 6),
                "candidateOrder": int(candidate.get("candidateOrder", index)),
            }
        )
    if not scored:
        return None
    scored.sort(
        key=lambda item: (
            -float(item["selectionScore"]),
            -float(item["contentSimilarity"]),
            -float(item["confidence"]),
            -float(item["boxStability"]),
            int(item.get("candidateOrder", 0)),
            str(item.get("preprocess", "")),
            str(item.get("text", "")),
        )
    )
    return scored[0]


def _region_candidate_from_payload(
    payload: Any,
    crop_box: Box,
    preprocess: str,
    psm: int,
    provider: OcrProvider,
) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    values = payload.get("text", [])
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple)):
        return None
    words: list[tuple[str, float, Box]] = []
    count = len(values)
    for index, raw in enumerate(values):
        text = str(raw).strip()
        if not text:
            continue
        try:
            confidence = max(0.0, min(1.0, float(payload.get("conf", [0])[index]) / 100.0))
            box = Box(
                int(payload.get("left", [0])[index]) + crop_box.x,
                int(payload.get("top", [0])[index]) + crop_box.y,
                int(payload.get("width", [0])[index]),
                int(payload.get("height", [0])[index]),
            )
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if box.w > 0 and box.h > 0:
            words.append((text, confidence, box))
    if not words:
        return None
    x = min(item[2].x for item in words)
    y = min(item[2].y for item in words)
    right = max(item[2].right for item in words)
    bottom = max(item[2].bottom for item in words)
    weight = sum(max(1, len(item[0])) for item in words)
    confidence = sum(item[1] * max(1, len(item[0])) for item in words) / weight
    return {
        "text": " ".join(item[0] for item in words),
        "confidence": round(confidence, 4),
        "pixelBox": Box(x, y, right - x, bottom - y).as_dict(),
        "preprocess": preprocess,
        "psm": int(psm),
        "provider": provider.name,
        "wordCount": len(words),
    }


def regional_ocr(
    image: Image.Image,
    lines: list[dict[str, Any]],
    langs: str,
    provider: OcrProvider | None = None,
    max_candidates: int = DEFAULT_REGION_OCR_CANDIDATES,
    page_budget: int = MAX_PAGE_REGION_OCR_CALLS,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Run bounded role-routed OCR under a deterministic page call budget."""

    provider = provider or TesseractProvider()
    selected_lines: list[dict[str, Any]] = [dict(line) for line in lines]
    report_by_index: dict[int, dict[str, Any]] = {}
    width, height = image.size
    budget = max(0, min(int(page_budget), MAX_PAGE_REGION_OCR_CALLS))
    calls_used = 0
    role_priority = {"title": 0, "section-title": 1, "body": 2, "label": 3, "badge": 3, "number": 3, "footer": 3, "caption": 4, "unknown": 5}
    prioritized = []
    for index, line in enumerate(lines):
        role = classify_line_role(line, image.size)
        box = line.get("pixelBox") or {}
        area = float(box.get("w", 0)) * float(box.get("h", 0))
        prioritized.append(
            (
                role_priority.get(role, role_priority["unknown"]),
                float(line.get("confidence", 0.0)),
                -area,
                int(box.get("y", 0)),
                int(box.get("x", 0)),
                index,
                role,
            )
        )
    prioritized.sort()
    for _, _, _, _, _, index, role in prioritized:
        line = lines[index]
        psm = psm_for_role(role)
        source_box = Box(**line["pixelBox"]).expand(4, width, height)
        candidates: list[dict[str, Any]] = []
        candidate_images = preprocessing_candidates(
            image.crop((source_box.x, source_box.y, source_box.right, source_box.bottom)),
            role,
            max_candidates,
        )
        for candidate_order, (preprocess, crop) in enumerate(candidate_images):
            if calls_used >= budget:
                break
            calls_used += 1
            payload = provider.recognize(crop, langs, psm)
            candidate = _region_candidate_from_payload(payload, source_box, preprocess, psm, provider)
            if candidate is not None:
                candidate["candidateOrder"] = candidate_order
                candidates.append(candidate)
                # A strong first result is already unique enough for this
                # bounded region; avoid an unnecessary second OCR call while
                # retaining the explicit two-candidate ceiling.
                if (
                    candidate_order == 0
                    and float(candidate.get("confidence", 0.0)) >= 0.90
                    and _candidate_text_similarity(str(candidate.get("text", "")), str(line.get("text", ""))) >= 0.90
                ):
                    break
        selected = select_ocr_candidate(
            candidates,
            expected_text=str(line.get("text", "")),
            expected_box=line.get("pixelBox"),
        )
        updated = dict(line)
        status = "selected" if selected is not None else "no-result"
        reason = "selected-by-content-confidence-box" if selected is not None else "no-regional-candidate"
        if calls_used >= budget and selected is None:
            status = "budget-deferred"
            reason = "page-region-call-budget"
        if selected is not None:
            updated.update(
                {
                    "text": selected["text"],
                    "confidence": selected["confidence"],
                    "pixelBox": selected["pixelBox"],
                    "polygon": box_polygon(Box(**selected["pixelBox"])),
                    "recognitionPass": f"region-psm-{psm}-{selected['preprocess']}",
                }
            )
            updated["evidenceStage"] = "region-selected"
        else:
            updated["evidenceStage"] = "page-detection"
        updated["regionRole"] = role
        updated["regionPsm"] = psm
        updated["regionCandidateCount"] = len(candidates)
        updated["regionSelection"] = selected
        updated["regionOcrStatus"] = status
        updated["regionOcrReason"] = reason
        selected_lines[index] = updated
        report_by_index[index] = {
                "lineOrder": index + 1,
                "role": role,
                "psm": psm,
                "sourceBox": source_box.as_dict(),
                "candidateCount": len(candidates),
                "candidates": candidates,
                "selected": selected,
                "status": status,
                "reason": reason,
                "provider": provider.name,
                "callsUsed": calls_used,
                "budgetLimit": budget,
            }
    for index, line in enumerate(selected_lines):
        if index not in report_by_index:
            role = classify_line_role(line, image.size)
            selected_lines[index]["regionRole"] = role
            selected_lines[index]["regionPsm"] = psm_for_role(role)
            selected_lines[index]["regionCandidateCount"] = 0
            selected_lines[index]["regionSelection"] = None
            selected_lines[index]["regionOcrStatus"] = "budget-deferred"
            selected_lines[index]["regionOcrReason"] = "page-region-call-budget"
            selected_lines[index]["evidenceStage"] = "page-detection"
            report_by_index[index] = {
                "lineOrder": index + 1,
                "role": role,
                "psm": psm_for_role(role),
                "sourceBox": line["pixelBox"],
                "candidateCount": 0,
                "candidates": [],
                "selected": None,
                "status": "budget-deferred",
                "reason": "page-region-call-budget",
                "provider": provider.name,
                "callsUsed": calls_used,
                "budgetLimit": budget,
            }
    selected_lines.sort(key=lambda item: (item["pixelBox"]["y"], item["pixelBox"]["x"], item.get("readingOrder", 0)))
    for order, line in enumerate(selected_lines, 1):
        line["readingOrder"] = order
        line["lineBreakAfter"] = order < len(selected_lines)
        line["multiline"] = len(selected_lines) > 1
    report = [report_by_index[index] for index in sorted(report_by_index)]
    report.append(
            {
                "kind": "summary",
                "budgetLimit": budget,
                "callsUsed": calls_used,
                "lineCount": len(lines),
                "deferredCount": sum(item.get("status") == "budget-deferred" for item in report),
            }
        )
    return selected_lines, report


def _box_area_share(box_value: dict[str, Any], page_area: float) -> float:
    try:
        area = max(0.0, float(box_value.get("w", 0)) * float(box_value.get("h", 0)))
    except (AttributeError, TypeError, ValueError):
        return 0.0
    return min(1.0, area / max(1.0, page_area))


def build_page_profile(
    image: Image.Image,
    objects: list[dict[str, Any]],
    lines: list[dict[str, Any]],
    residuals: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    groups: list[dict[str, Any]] | None = None,
    source_size: tuple[int, int] | None = None,
) -> dict[str, Any]:
    """Build an auditable page profile from observable analyzer outputs."""

    width, height = image.size
    page_area = float(max(1, width * height))
    text_area = sum(_box_area_share(line.get("pixelBox", {}), page_area) for line in lines)
    object_area = min(1.0, sum(_box_area_share(item.get("pixelBox", {}), page_area) for item in objects))
    raster_area = min(1.0, sum(_box_area_share(item.get("pixelBox", {}), page_area) for item in residuals))
    shape_count = sum(item.get("type") == "shape" for item in objects)
    connector_count = sum(item.get("type") == "connector" for item in objects)
    text_count = sum(item.get("type") == "text" for item in objects)
    image_count = sum(item.get("type") == "image" and item.get("reason") != "low-confidence-ocr" for item in objects)
    chart_count = sum(item.get("type") == "chart" or item.get("type") == "table" for item in objects)
    candidate_count = len(candidates)
    flat_area = min(1.0, sum(_box_area_share(item.get("pixelBox", {}), page_area) for item in objects if item.get("type") == "shape"))
    photo_area = min(1.0, raster_area + sum(_box_area_share(item.get("pixelBox", {}), page_area) for item in objects if item.get("type") == "image" and item.get("reason") != "low-confidence-ocr"))
    signatures = Counter(
        (
            item.get("type"),
            round(float(item.get("pixelBox", {}).get("w", 0)) / max(1, width) * 20),
            round(float(item.get("pixelBox", {}).get("h", 0)) / max(1, height) * 20),
            item.get("color") or item.get("fillColor"),
        )
        for item in objects
        if item.get("type") in {"shape", "image", "text"}
    )
    repeated_count = sum(count for count in signatures.values() if count > 1)
    repeated_score = repeated_count / max(1, sum(signatures.values()))
    group_count = len(groups or [])
    layout_complexity = min(
        1.0,
        0.30 * min(1.0, len(objects) / 24.0)
        + 0.22 * min(1.0, len(lines) / 18.0)
        + 0.20 * min(1.0, group_count / 12.0)
        + 0.18 * min(1.0, raster_area * 3.0)
        + 0.10 * min(1.0, candidate_count / 4.0),
    )
    low_resolution = bool(source_size and min(source_size) < 400)
    # Structural signals take precedence over text density, preventing a dense
    # flowchart from being mislabeled as a report.
    if chart_count or candidate_count:
        page_type, strategies, type_signal = "data-report", ["native-all", "native-text-shapes-plus-asset", "bounded-raster"], "table-chart-evidence"
    elif shape_count >= 3 and connector_count >= 1:
        page_type, strategies, type_signal = "flowchart", ["native-shapes-connectors", "native-text-shapes-plus-asset"], "shape-connector-structure"
    elif low_resolution:
        page_type, strategies, type_signal = "low-resolution-screenshot", ["native-text-shapes-plus-asset", "bounded-raster"], "source-resolution"
    elif photo_area >= 0.38 and text_count:
        page_type, strategies, type_signal = "photography-poster", ["bounded-raster", "native-text-shapes-plus-asset"], "photo-area-with-text"
    elif photo_area >= 0.50:
        page_type, strategies, type_signal = "illustration-page", ["bounded-raster", "native-text-shapes-plus-asset"], "photo-or-illustration-area"
    elif flat_area >= 0.18 and repeated_score >= 0.20:
        page_type, strategies, type_signal = "flat-infographic", ["native-all", "native-text-shapes-plus-asset"], "flat-color-and-repetition"
    else:
        page_type, strategies, type_signal = "mixed-complex", ["native-text-shapes-plus-asset", "bounded-raster"], "insufficient-specialized-evidence"
    confidence = min(1.0, 0.45 + 0.20 * min(1.0, len(objects) / 8.0) + 0.20 * min(1.0, len(lines) / 8.0) + 0.15 * (1.0 if type_signal != "insufficient-specialized-evidence" else 0.0))
    complexity_score = layout_complexity
    complexity_level = "high" if complexity_score >= 0.66 else "medium" if complexity_score >= 0.32 else "low"
    evidence = [
        {"signal": "textDensity", "value": round(text_area, 6), "source": "ocr-line-boxes"},
        {"signal": "flatColorRatio", "value": round(flat_area, 6), "source": "flat-shape-boxes"},
        {"signal": "photoRatio", "value": round(photo_area, 6), "source": "bounded-raster-and-image-boxes"},
        {"signal": "repeatedComponentScore", "value": round(repeated_score, 6), "source": "stable-object-signatures"},
        {"signal": "layoutComplexity", "value": round(layout_complexity, 6), "source": "objects-lines-layout-groups"},
        {"signal": "objectCount", "value": len(objects), "source": "observed-objects"},
        {"signal": "candidateCount", "value": candidate_count, "source": "geometry-candidates"},
        {"signal": "classification", "value": type_signal, "source": "deterministic-rule"},
    ]
    return {
        "version": "1.0.0",
        "pageType": page_type,
        "confidence": round(confidence, 4),
        "textDensity": round(text_area, 6),
        "flatColorRatio": round(flat_area, 6),
        "photoRatio": round(photo_area, 6),
        "repeatedComponentScore": round(repeated_score, 6),
        "layoutComplexity": round(layout_complexity, 6),
        "metricEvidence": evidence,
        "density": {
            "score": round(min(1.0, object_area + raster_area), 6),
            "textAreaShare": round(text_area, 6),
            "objectAreaShare": round(object_area, 6),
            "boundedRasterAreaShare": round(raster_area, 6),
            "objectCount": len(objects),
            "textLineCount": len(lines),
        },
        "complexity": {
            "score": round(complexity_score, 6),
            "level": complexity_level,
            "evidence": evidence,
        },
        "evidence": evidence,
        "recommendedStrategies": strategies,
        "factStatus": "inferred",
        "provenance": "deterministic-observed-objects-and-ocr",
    }


def build_region_profiles(
    slide_id: str,
    source_ref: str,
    objects: list[dict[str, Any]],
    lines: list[dict[str, Any]],
    groups: list[dict[str, Any]] | tuple[int, int],
    page_size: tuple[int, int] | None = None,
) -> list[dict[str, Any]]:
    """Bind stable region profiles to observed layout groups and object boxes."""

    if page_size is None:
        page_size = groups  # type: ignore[assignment]
        groups = []
    width, height = page_size
    page_area = float(max(1, width * height))
    line_roles = {
        str(line.get("id")): str(line.get("regionRole"))
        for line in lines
        if line.get("id") and line.get("regionRole")
    }
    object_by_id = {str(item.get("id")): item for item in objects}
    grouped_ids: set[str] = set()
    observed_groups: list[tuple[str, list[dict[str, Any]], str]] = []
    for group in sorted(groups, key=lambda item: str(item.get("id", ""))):
        member_ids = [str(item) for item in group.get("memberIds", [])]
        members = [object_by_id[item] for item in member_ids if item in object_by_id]
        if members:
            observed_groups.append((str(group.get("id")), members, str(group.get("role", ""))))
            grouped_ids.update(str(item.get("id")) for item in members)
    for item in sorted(objects, key=lambda value: (int(value.get("z", 0)), str(value.get("id", "")))):
        object_id = str(item.get("id"))
        if object_id not in grouped_ids:
            observed_groups.append((f"singleton-{object_id}", [item], ""))

    profiles: list[dict[str, Any]] = []
    for index, (group_id, members, group_role) in enumerate(observed_groups, 1):
        member_ids = [str(item.get("id")) for item in members]
        boxes = [Box(**item["pixelBox"]) for item in members]
        union = _union_box(members)
        object_types = {str(item.get("type", "unknown")) for item in members}
        text_roles = [line_roles[item_id] for item_id in member_ids if item_id in line_roles]
        if "chart" in group_role or "chart" in object_types:
            role = "chart"
        elif "table" in group_role or "table" in object_types:
            role = "table"
        elif "image" in object_types and len(object_types) == 1:
            role = "image"
        elif any(text_role == "title" for text_role in text_roles):
            role = "title"
        elif any(text_role == "footer" for text_role in text_roles):
            role = "footer"
        elif "text" in object_types:
            role = "text-block"
        elif len(members) > 1:
            role = "card-or-native-group"
        elif "shape" in object_types or "connector" in object_types:
            role = "background" if union.area >= width * height * 0.60 else "decor"
        else:
            role = group_role or "decor"

        area_share = _box_area_share(union.as_dict(), page_area)
        member_area = sum(_box_area_share(item.get("pixelBox", {}), page_area) for item in members)
        overlap_factor = min(1.0, member_area / max(area_share, 1e-6))
        confidence = min(
            [max(0.0, min(1.0, float(item.get("confidence", 0.0)))) for item in members]
            + [float(next((group["confidence"] for group in groups if str(group.get("id")) == group_id), 1.0))]
        )
        complexity_score = min(
            1.0,
            0.20
            + 0.18 * min(1.0, len(members) / 4.0)
            + 0.24 * min(1.0, len(object_types) / 3.0)
            + 0.20 * min(1.0, overlap_factor)
            + (0.18 if role in {"chart", "table", "image", "card-or-native-group"} else 0.0),
        )
        level = "high" if complexity_score >= 0.66 else "medium" if complexity_score >= 0.36 else "low"
        if role in {"title", "text-block", "footer"}:
            strategies = ["native-text"] if confidence >= 0.70 else ["native-text", "bounded-raster"]
        elif role == "table":
            strategies = ["native-table", "bounded-raster"]
        elif role == "chart":
            strategies = ["native-shapes", "bounded-raster"]
        elif role == "image":
            strategies = ["bounded-raster"]
        elif role == "background":
            strategies = ["native-background"]
        elif role == "card-or-native-group":
            strategies = ["native-all", "bounded-raster"]
        else:
            strategies = ["native-shape"]
        evidence = [
            {"signal": "memberIds", "value": member_ids, "source": "layout-group-or-singleton"},
            {"signal": "memberTypes", "value": sorted(object_types), "source": "observed-objects"},
            {"signal": "areaShare", "value": round(area_share, 6), "source": "union-pixelBox"},
        ]
        profiles.append(
            {
                "id": f"{slide_id}-region-{index:03d}",
                "role": role,
                "box": union.as_dict(),
                "pixelBox": union.as_dict(),
                "memberIds": member_ids,
                "objectRefs": member_ids,
                "layoutGroupRef": None if group_id.startswith("singleton-") else group_id,
                "objectCount": len(member_ids),
                "density": {
                    "score": round(min(1.0, area_share + member_area), 6),
                    "areaShare": round(area_share, 6),
                    "objectCount": len(member_ids),
                    "memberAreaShare": round(member_area, 6),
                },
                "complexity": {
                    "score": round(complexity_score, 6),
                    "level": level,
                    "evidence": evidence,
                },
                "confidence": round(confidence, 4),
                "candidateStrategies": strategies,
                "sourceRef": source_ref,
                "factStatus": "inferred",
                "provenance": "deterministic-layout-group-or-singleton",
            }
        )
    return profiles


def ocr_lines(
    image: Image.Image,
    langs: str,
    threshold: float,
    orientation: dict[str, Any] | None = None,
    language_info: dict[str, Any] | None = None,
    provider: OcrProvider | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    assert pytesseract is not None
    provider = provider or TesseractProvider()
    orientation = orientation or {
        "status": "unavailable",
        "orientationDegrees": None,
        "rotateDegrees": None,
        "script": None,
        "scriptConfidence": None,
    }
    language_info = language_info or language_metadata(langs, orientation)
    requested_languages = list(
        language_info.get("resolved", language_info.get("requested", []))
    )

    def recognize_pass(
        source: Image.Image,
        pass_name: str,
    ) -> tuple[list[dict[str, Any]], list[tuple[dict[str, Any], list[dict[str, Any]]]]]:
        payload = provider.recognize(source, langs, 11)
        pass_words: list[dict[str, Any]] = []
        grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = defaultdict(list)
        count = len(payload.get("text", []))
        for index in range(count):
            text = str(payload["text"][index]).strip()
            if not text:
                continue
            try:
                confidence = max(0.0, min(1.0, float(payload["conf"][index]) / 100.0))
                box = Box(
                    int(payload["left"][index]),
                    int(payload["top"][index]),
                    int(payload["width"][index]),
                    int(payload["height"][index]),
                )
            except (KeyError, TypeError, ValueError):
                continue
            if box.w <= 0 or box.h <= 0:
                continue
            block = int(payload.get("block_num", [0] * count)[index])
            paragraph = int(payload.get("par_num", [0] * count)[index])
            line_number = int(payload.get("line_num", [0] * count)[index])
            word = {
                "text": text,
                "evidenceStage": "page-detection",
                "provenance": "whole-page-psm-11-preliminary",
                "confidence": round(confidence, 4),
                "pixelBox": box.as_dict(),
                "polygon": box_polygon(box),
                "block": block,
                "paragraph": paragraph,
                "line": line_number,
                "paragraphId": f"{block}:{paragraph}",
                "languages": requested_languages,
                "languageSource": "requested-tesseract-language-packs",
                "orientation": orientation,
                "recognitionPass": pass_name,
            }
            pass_words.append(word)
            grouped[(word["block"], word["paragraph"], word["line"])].append(word)

        pass_lines: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for values in grouped.values():
            values.sort(key=lambda item: item["pixelBox"]["x"])
            boxes = [item["pixelBox"] for item in values]
            x = min(item["x"] for item in boxes)
            y = min(item["y"] for item in boxes)
            right = max(item["x"] + item["w"] for item in boxes)
            bottom = max(item["y"] + item["h"] for item in boxes)
            total_weight = sum(max(1, len(item["text"])) for item in values)
            confidence = sum(
                item["confidence"] * max(1, len(item["text"])) for item in values
            ) / total_weight
            text = " ".join(item["text"] for item in values)
            box = Box(x, y, right - x, bottom - y)
            first = values[0]
            pass_lines.append(
                (
                    {
                        "text": text,
                        "evidenceStage": "page-detection",
                        "provenance": "whole-page-psm-11-preliminary",
                        "confidence": round(confidence, 4),
                        "pixelBox": box.as_dict(),
                        "polygon": box_polygon(box),
                        "block": first["block"],
                        "paragraph": first["paragraph"],
                        "line": first["line"],
                        "paragraphId": first["paragraphId"],
                        "wordCount": len(values),
                        "multiline": False,
                        "languages": requested_languages,
                        "languageSource": "requested-tesseract-language-packs",
                        "orientation": orientation,
                        "disposition": (
                            "editable-text" if confidence >= threshold else "local-crop"
                        ),
                        "recognitionPass": pass_name,
                    },
                    values,
                )
            )
        return pass_words, pass_lines

    words, primary_pairs = recognize_pass(image, "primary")
    lines = [line for line, _ in primary_pairs]

    # A second, deliberately narrow pass recovers small light/red labels that can
    # disappear into dark or saturated regions in the primary RGB OCR pass. Only
    # high-confidence, spatially new lines are admitted, so this cannot silently
    # replace primary text or invent overlapping alternatives.
    red_channel = image.convert("RGB").getchannel("R")
    red_binary = red_channel.point(lambda value: 255 if value > 130 else 0)
    _, secondary_pairs = recognize_pass(red_binary, "red-threshold-130")
    accepted_boxes = [
        Box(**line["pixelBox"])
        for line in lines
    ]
    secondary_threshold = max(threshold, 0.85)
    for line, line_words in secondary_pairs:
        box = Box(**line["pixelBox"])
        if line["confidence"] < secondary_threshold:
            continue
        if any(overlaps(box, existing, 0.35) for existing in accepted_boxes):
            continue
        line["disposition"] = "editable-text"
        lines.append(line)
        words.extend(line_words)
        accepted_boxes.append(box)

    lines.sort(key=lambda item: (item["pixelBox"]["y"], item["pixelBox"]["x"]))
    for order, line in enumerate(lines, 1):
        line["readingOrder"] = order
        line["lineBreakAfter"] = order < len(lines)
        line["multiline"] = len(lines) > 1
        line["readingOrderSource"] = "tesseract-block-paragraph-line-yx"
        bounds = Box(**line["pixelBox"])
        # Keep a polygon on every line even when a caller supplies synthetic OCR
        # data.  It is an axis-aligned evidence polygon, not a guessed glyph hull.
        line["polygon"] = box_polygon(bounds)
    words.sort(
        key=lambda item: (
            item["pixelBox"]["y"],
            item["pixelBox"]["x"],
            item.get("block", 0),
            item.get("paragraph", 0),
            item.get("line", 0),
        )
    )
    for order, word in enumerate(words, 1):
        word["readingOrder"] = order
        word["readingOrderSource"] = "tesseract-word-yx"
    return words, lines


def exact_color_components(
    image: Image.Image,
    background: tuple[int, int, int],
    tolerance: int = COLOR_TOLERANCE,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract flat components while joining anti-aliased near-colors.

    The old exact-RGB flood fill fragmented screenshots at every antialiased
    edge.  A bounded seed-color tolerance keeps this deterministic and avoids a
    transitive color chain that could swallow an entire gradient or photo.
    """

    tolerance = max(0, int(tolerance))
    width, height = image.size
    pixels = image.load()
    seen = bytearray(width * height)
    shapes: list[dict[str, Any]] = []
    connectors: list[dict[str, Any]] = []
    minimum = max(80, round(width * height * 0.00008))

    for y in range(height):
        for x in range(width):
            start = y * width + x
            if seen[start]:
                continue
            color = pixels[x, y]
            stack = [start]
            seen[start] = 1
            count = 0
            min_x = max_x = x
            min_y = max_y = y
            sample_colors: Counter[tuple[int, int, int]] = Counter()
            while stack:
                current = stack.pop()
                px = current % width
                py = current // width
                count += 1
                pixel_color = pixels[px, py]
                # Keep the color summary bounded for high-entropy photos while
                # preserving a useful dominant fill for native reconstruction.
                if len(sample_colors) < 512 or pixel_color in sample_colors:
                    sample_colors[pixel_color] += 1
                min_x = min(min_x, px)
                max_x = max(max_x, px)
                min_y = min(min_y, py)
                max_y = max(max_y, py)
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    neighbor = ny * width + nx
                    neighbor_color = pixels[nx, ny]
                    close = (
                        neighbor_color == color
                        if tolerance == 0
                        else color_distance(neighbor_color, color) <= tolerance
                    )
                    if not seen[neighbor] and close:
                        seen[neighbor] = 1
                        stack.append(neighbor)
            if count < minimum:
                continue
            box = Box(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
            fill_ratio = count / max(1, box.area)
            representative = sample_colors.most_common(1)[0][0] if sample_colors else color
            spans_page = (
                (box.w >= width * 0.90 and box.h >= height * 0.90)
                or box.area >= width * height * 0.80
            )
            if spans_page or (
                color_distance(representative, background) <= max(1, tolerance)
                and box.area >= width * height * 0.70
            ):
                continue
            base = {
                "pixelBox": box.as_dict(),
                "polygon": box_polygon(box),
                "color": rgb_hex(representative),
                "confidence": round(fill_ratio, 4),
                "colorTolerancePx": tolerance,
                "colorDistance": "rgb-euclidean-seed",
            }
            if (box.w >= width * 0.20 and box.h <= 6) or (
                box.h >= height * 0.20 and box.w <= 6
            ):
                connectors.append(
                    {
                        **base,
                        "type": "connector",
                        "widthPx": max(1, min(box.w, box.h)),
                        "direction": "horizontal" if box.w >= box.h else "vertical",
                    }
                )
                continue
            if box.w < 8 or box.h < 8:
                continue
            if (
                (box.w >= width * 0.04 and box.h >= height * 0.02)
                or (box.w <= 16 and box.h >= height * 0.12)
                or (box.h <= 16 and box.w >= width * 0.12)
            ) and fill_ratio >= 0.90:
                shapes.append(
                    {
                        **base,
                        "type": "shape",
                        "shape": "rect",
                        "fill": True,
                        "borderWidthPx": 0,
                    }
                )
            elif (
                box.w >= width * 0.08
                and box.h >= height * 0.025
                and 0.004 <= fill_ratio <= 0.24
            ):
                ratio = box.w / max(1, box.h)
                shape = "ellipse" if 0.85 <= ratio <= 1.15 and fill_ratio >= 0.06 else "rect"
                perimeter = max(1, 2 * (box.w + box.h))
                shapes.append(
                    {
                        **base,
                        "type": "shape",
                        "shape": shape,
                        "fill": False,
                        "borderWidthPx": max(1, round(count / perimeter)),
                    }
                )
    return shapes, connectors


def _coerce_box(raw: dict[str, Any], image: Image.Image, expand: int = 0) -> Box | None:
    width, height = image.size
    try:
        box = Box(
            **{
                key: int(round(float(raw[key])))
                for key in ("x", "y", "w", "h")
            }
        ).clamp(width, height)
    except (KeyError, TypeError, ValueError):
        return None
    return box.expand(max(0, int(expand)), width, height)


def _local_background(image: Image.Image, box: Box, margin: int = 3) -> tuple[int, int, int]:
    """Estimate a crop-local background from its expanded border colors."""

    expanded = box.expand(max(1, margin), image.width, image.height)
    pixels = image.load()
    border: list[tuple[int, int, int]] = []
    for x in range(expanded.x, expanded.right):
        border.append(tuple(pixels[x, expanded.y]))
        border.append(tuple(pixels[x, expanded.bottom - 1]))
    for y in range(expanded.y + 1, max(expanded.y + 1, expanded.bottom - 1)):
        border.append(tuple(pixels[expanded.x, y]))
        border.append(tuple(pixels[expanded.right - 1, y]))
    if not border:
        return tuple(pixels[box.x, box.y])
    buckets = Counter((color[0] // 8, color[1] // 8, color[2] // 8) for color in border)
    selected = buckets.most_common(1)[0][0]
    selected_pixels = [
        color
        for color in border
        if (color[0] // 8, color[1] // 8, color[2] // 8) == selected
    ]
    return tuple(round(sum(color[index] for color in selected_pixels) / len(selected_pixels)) for index in range(3))


def measure_ink(
    image: Image.Image,
    raw_box: dict[str, Any],
    tolerance: int = OWNERSHIP_TOLERANCE_PX,
    ink_threshold: int = 18,
) -> Image.Image:
    """Measure local foreground ink, independent of page-edge background."""

    box = _coerce_box(raw_box, image, expand=max(1, tolerance))
    mask = Image.new("L", image.size, 0)
    if box is None:
        return mask
    source = image.load()
    local_background = _local_background(image, box, margin=max(2, tolerance + 1))
    output = mask.load()
    for y in range(box.y, box.bottom):
        for x in range(box.x, box.right):
            if color_distance(tuple(source[x, y]), local_background) >= max(8, ink_threshold):
                output[x, y] = 255
    return mask


def _parse_hex_color(value: Any) -> tuple[int, int, int] | None:
    text = str(value or "").strip().lstrip("#")
    if len(text) != 6:
        return None
    try:
        return tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))
    except ValueError:
        return None


def _observed_component_color(
    image: Image.Image,
    box: Box,
    item: dict[str, Any],
    page_background: tuple[int, int, int],
    tolerance: int,
) -> tuple[int, int, int]:
    explicit = _parse_hex_color(
        item.get("borderColor") if item.get("fill") is False else item.get("color")
    ) or _parse_hex_color(item.get("color"))
    if explicit is not None:
        return explicit
    pixels = image.load()
    candidates: Counter[tuple[int, int, int]] = Counter()
    for y in range(box.y, box.bottom):
        for x in range(box.x, box.right):
            color = tuple(pixels[x, y])
            if color_distance(color, page_background) > max(8, tolerance):
                candidates[color] += 1
    if candidates:
        return candidates.most_common(1)[0][0]
    return page_background


def _observed_component_mask(
    image: Image.Image,
    item: dict[str, Any],
    page_background: tuple[int, int, int],
    tolerance: int,
) -> Image.Image:
    """Claim observed component-color pixels, never a whole bbox."""

    box = _coerce_box(item.get("pixelBox", {}), image, expand=max(1, tolerance))
    mask = Image.new("L", image.size, 0)
    if box is None:
        return mask
    observed = _observed_component_color(image, box, item, page_background, tolerance)
    claim_tolerance = max(
        int(item.get("colorTolerancePx", tolerance) or tolerance),
        tolerance,
    ) + 4
    source = image.load()
    output = mask.load()
    for y in range(box.y, box.bottom):
        for x in range(box.x, box.right):
            if color_distance(tuple(source[x, y]), observed) <= claim_tolerance:
                output[x, y] = 255
    return mask


def _background_mask(image: Image.Image, background: tuple[int, int, int], tolerance: int) -> Image.Image:
    source = image.load()
    width, height = image.size
    data = bytearray(width * height)
    index = 0
    for y in range(height):
        for x in range(width):
            if color_distance(source[x, y], background) <= tolerance:
                data[index] = 255
            index += 1
    return Image.frombytes("L", image.size, bytes(data))


def _binary_union(*masks: Image.Image) -> Image.Image:
    output = Image.new("L", masks[0].size if masks else (1, 1), 0)
    for mask in masks:
        output = ImageChops.lighter(output, mask.convert("L"))
    return output


def _binary_subtract(left: Image.Image, *right: Image.Image) -> Image.Image:
    output = left.convert("L")
    for mask in right:
        output = ImageChops.subtract(output, mask.convert("L"))
    return output.point(lambda value: 255 if value >= 128 else 0, mode="L")


def _mask_count(mask: Image.Image) -> int:
    return int(sum(mask.convert("L").histogram()[128:]))


def _mask_digest(mask: Image.Image) -> str:
    # Hash the deterministic PNG representation so a report digest can be
    # checked against the persisted mask without requiring a second pixel
    # decoder in downstream validators.
    encoded = io.BytesIO()
    mask.convert("L").save(encoded, format="PNG")
    return hashlib.sha256(encoded.getvalue()).hexdigest()


def _residual_components(
    image: Image.Image,
    residual_mask: Image.Image,
    background: tuple[int, int, int],
    min_area: int,
) -> tuple[list[dict[str, Any]], Image.Image]:
    """Label residual pixels after native claims, preserving each component mask."""

    width, height = image.size
    active = residual_mask.load()
    visited = bytearray(width * height)
    union = Image.new("L", image.size, 0)
    union_pixels = union.load()
    records: list[dict[str, Any]] = []
    for y in range(height):
        for x in range(width):
            start = y * width + x
            if visited[start] or active[x, y] < 128:
                continue
            visited[start] = 1
            queue: deque[int] = deque([start])
            points: list[tuple[int, int]] = []
            while queue:
                current = queue.popleft()
                px, py = current % width, current // width
                points.append((px, py))
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
                    nx, ny = px + dx, py + dy
                    if 0 <= nx < width and 0 <= ny < height:
                        index = ny * width + nx
                        if not visited[index] and active[nx, ny] >= 128:
                            visited[index] = 1
                            queue.append(index)
            if len(points) < min_area:
                continue
            min_x = min(px for px, _ in points)
            max_x = max(px for px, _ in points)
            min_y = min(py for _, py in points)
            max_y = max(py for _, py in points)
            component_mask = Image.new("L", image.size, 0)
            component_pixels = component_mask.load()
            for px, py in points:
                component_pixels[px, py] = 255
                union_pixels[px, py] = 255
            box = Box(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
            records.append(
                {
                    "type": "image",
                    "pixelBox": box.as_dict(),
                    "reason": "claimed-pixel-residual",
                    "confidence": 1.0,
                    "_mask": component_mask,
                    "maskDigest": _mask_digest(component_mask),
                    "source": "post-claim-connected-component",
                }
            )
    records.sort(key=lambda item: (item["pixelBox"]["y"], item["pixelBox"]["x"], item["pixelBox"]["w"], item["pixelBox"]["h"]))
    return records, union


def validate_ownership_masks(
    masks: dict[str, Image.Image],
    *,
    unassigned_budget: float = UNASSIGNED_PIXEL_BUDGET,
) -> dict[str, Any]:
    """Validate five mutually exclusive page ownership masks."""

    required = ("background", "native_text", "native_shape", "raster_asset", "unresolved")
    if any(name not in masks for name in required):
        fail("E_PIXEL_OWNERSHIP_CONFLICT", "ownership masks are incomplete")
    size = masks[required[0]].size
    if any(masks[name].size != size for name in required):
        fail("E_PIXEL_OWNERSHIP_CONFLICT", "ownership masks use inconsistent pixel dimensions")
    total = size[0] * size[1]
    binary = {name: masks[name].convert("L").point(lambda value: 255 if value >= 128 else 0, mode="L") for name in required}
    counts = {name: _mask_count(mask) for name, mask in binary.items()}
    overlap = Image.new("L", size, 0)
    overlap_pixels = overlap.load()
    unassigned = 0
    for y in range(size[1]):
        for x in range(size[0]):
            owners = sum(1 for name in required if binary[name].getpixel((x, y)) >= 128)
            if owners > 1:
                overlap_pixels[x, y] = 255
            if owners == 0:
                unassigned += 1
    native_union = _binary_union(binary["native_text"], binary["native_shape"])
    if ImageChops.multiply(binary["raster_asset"], native_union).getbbox():
        fail("E_RASTER_NATIVE_TEXT_OVERLAP", "raster asset mask overlaps native text or shape ownership")
    if overlap.getbbox():
        fail("E_PIXEL_OWNERSHIP_CONFLICT", "ownership masks overlap on visible pixels")
    unassigned_share = unassigned / max(1, total)
    if unassigned_share > float(unassigned_budget):
        fail("E_UNASSIGNED_PIXEL_BUDGET", f"unassigned ownership pixels exceed budget: {unassigned_share:.6f}")
    return {
        "status": "passed",
        "sizePx": {"width": size[0], "height": size[1]},
        "totalPixels": total,
        "classes": {
            name: {
                "pixelCount": counts[name],
                "share": round(counts[name] / max(1, total), 6),
                "maskDigest": _mask_digest(binary[name]),
            }
            for name in required
        },
        "conflictPixels": 0,
        "rasterNativeOverlapPixels": 0,
        "duplicateVisibleContent": 0,
        "unassignedPixels": unassigned,
        "unassignedShare": round(unassigned_share, 6),
        "unassignedBudget": float(unassigned_budget),
        "unionPixels": total - unassigned,
    }


def build_ownership_masks(
    image: Image.Image,
    text_lines: Iterable[dict[str, Any]],
    shapes: Iterable[dict[str, Any]],
    connectors: Iterable[dict[str, Any]],
    candidates: Iterable[dict[str, Any]] = (),
    raster_boxes: Iterable[dict[str, Any]] = (),
    *,
    tolerance_px: int = OWNERSHIP_TOLERANCE_PX,
    min_residual_area: int = 4,
) -> tuple[dict[str, Image.Image], dict[str, Any], list[dict[str, Any]]]:
    """Claim native pixels first, then label residual connected components."""

    background = edge_background(image)
    background_mask = _background_mask(image, background, COLOR_TOLERANCE + tolerance_px)
    text_masks = [measure_ink(image, line.get("pixelBox", {}), tolerance_px) for line in text_lines]
    native_text = _binary_union(*text_masks) if text_masks else Image.new("L", image.size, 0)
    native_items = list(shapes) + list(connectors)
    component_masks: dict[str, Image.Image] = {}
    shape_masks: list[Image.Image] = []
    for index, item in enumerate(native_items):
        component = _observed_component_mask(image, item, background, tolerance_px)
        shape_masks.append(component)
        if item.get("id"):
            component_masks[str(item["id"])] = component
        else:
            component_masks[f"component-{index:04d}"] = component
    # Candidate boxes are evidence summaries only. Their native pixels are the
    # union of their observed member shape/connector masks, never the candidate
    # bounding rectangle itself.
    for candidate in candidates:
        member_masks = [
            component_masks[str(member_id)]
            for member_id in candidate.get("memberIds", [])
            if str(member_id) in component_masks
        ]
        if member_masks:
            shape_masks.append(_binary_union(*member_masks))
    shape_mask = _binary_union(*shape_masks) if shape_masks else Image.new("L", image.size, 0)
    native_shape = _binary_subtract(shape_mask, native_text)
    non_background = _binary_subtract(Image.new("L", image.size, 255), background_mask)
    claimed = _binary_union(native_text, native_shape)
    # Low-confidence OCR crops are raster claims too, but are made only after
    # native claims. This keeps their alpha mutually exclusive with editable
    # text/shapes while preserving their source line identity.
    raster_records: list[dict[str, Any]] = []
    raster_box_masks: list[Image.Image] = []
    for raw in raster_boxes:
        claim = measure_ink(image, raw.get("pixelBox", {}), tolerance_px)
        claim = _binary_subtract(claim, claimed)
        bbox = claim.getbbox()
        if bbox is None:
            continue
        left, top, right, bottom = bbox
        tight = Box(left, top, right - left, bottom - top)
        raster_box_masks.append(claim)
        raster_records.append(
            {
                "type": "image",
                "pixelBox": tight.as_dict(),
                "reason": str(raw.get("reason", "low-confidence-ocr")),
                "confidence": float(raw.get("confidence", 0.0)),
                "_mask": claim,
                "maskDigest": _mask_digest(claim),
                "source": "post-native-claim-raster-box",
                "objectRef": raw.get("id"),
            }
        )
    raster_box_union = _binary_union(*raster_box_masks) if raster_box_masks else Image.new("L", image.size, 0)
    residual_raw = _binary_subtract(non_background, claimed, raster_box_union)
    residuals, residual_mask = _residual_components(image, residual_raw, background, min_residual_area)
    raster_mask = _binary_union(raster_box_union, residual_mask)
    unresolved = _binary_subtract(Image.new("L", image.size, 255), background_mask, claimed, raster_mask)
    background_owner = _binary_subtract(background_mask, claimed, raster_mask)
    masks = {
        "background": background_owner,
        "native_text": native_text,
        "native_shape": native_shape,
        "raster_asset": raster_mask,
        "unresolved": unresolved,
    }
    report = validate_ownership_masks(masks)
    report.update(
        {
            "version": OWNERSHIP_VERSION,
            "coordinateSpace": "normalized-page-px",
            "tolerancePx": tolerance_px,
            "algorithm": "native-claims-then-residual-components",
            "backgroundColor": rgb_hex(background),
            "source": "observed-ocr-lines-shapes-connectors-candidates",
        }
    )
    all_residuals = raster_records + residuals
    all_residuals.sort(
        key=lambda item: (
            item["pixelBox"]["y"],
            item["pixelBox"]["x"],
            item["pixelBox"]["w"],
            item["pixelBox"]["h"],
            item["reason"],
            str(item.get("objectRef", "")),
        )
    )
    return masks, report, all_residuals


def write_transparent_crop(
    image: Image.Image,
    mask: Image.Image,
    box: Box,
    path: Path,
) -> tuple[str, str]:
    """Write a tight RGBA residual crop and return asset/mask digests."""

    path.parent.mkdir(parents=True, exist_ok=True)
    cropped = image.convert("RGBA").crop((box.x, box.y, box.right, box.bottom))
    alpha = mask.convert("L").crop((box.x, box.y, box.right, box.bottom))
    cropped.putalpha(alpha)
    cropped.save(path, format="PNG")
    return sha256(path), _mask_digest(alpha)


def write_mask(mask: Image.Image, path: Path) -> str:
    """Persist one canonical ownership mask and return its digest."""

    path.parent.mkdir(parents=True, exist_ok=True)
    mask.convert("L").save(path, format="PNG")
    return _mask_digest(mask)


def validate_duplicate_visible_content(assets: Iterable[dict[str, Any]]) -> None:
    """Reject duplicate page claims, allowing repeated image bytes elsewhere."""

    seen: set[str] = set()
    for asset in assets:
        box = asset.get("pagePixelBox", {})
        claim = json.dumps(
            {
                "pagePixelBox": {
                    key: box.get(key)
                    for key in ("x", "y", "w", "h")
                },
                "maskDigest": str(asset.get("maskDigest", "")),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        if claim in seen:
            fail("E_DUPLICATE_VISIBLE_CONTENT", f"duplicate page ownership claim: {claim}")
        seen.add(claim)


def overlaps(left: Box, right: Box, threshold: float = 0.5) -> bool:
    intersection = max(0, min(left.right, right.right) - max(left.x, right.x)) * max(
        0, min(left.bottom, right.bottom) - max(left.y, right.y)
    )
    return intersection / max(1, min(left.area, right.area)) >= threshold


def component_inferences(
    shapes: list[dict[str, Any]],
    connectors: list[dict[str, Any]],
    candidates: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    candidates = candidates or []
    table_candidate = next((item for item in candidates if item.get("type") == "table"), None)
    chart_candidate = next((item for item in candidates if item.get("type") == "chart"), None)
    horizontal = [
        item
        for item in connectors
        if item["direction"] == "horizontal"
    ]
    vertical = [
        item
        for item in connectors
        if item["direction"] == "vertical"
    ]
    if len(horizontal) >= 2 and len(vertical) >= 2:
        result.append(
            {
                "role": "table-grid",
                "confidence": 0.82,
                "renderedAs": "native-shapes-and-connectors",
                "factStatus": "inferred",
                **({"candidateRef": table_candidate["id"]} if table_candidate else {}),
            }
        )
    by_color: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in shapes:
        if item.get("fill"):
            by_color[item["color"]].append(item)
    for color, values in by_color.items():
        candidates = [
            item
            for item in values
            if item["pixelBox"]["h"] >= 20 and item["pixelBox"]["w"] >= 8
        ]
        if len(candidates) < 3:
            continue
        bottoms = [item["pixelBox"]["y"] + item["pixelBox"]["h"] for item in candidates]
        if max(bottoms) - min(bottoms) <= 5:
            result.append(
                {
                    "role": "bar-chart",
                    "confidence": 0.76,
                    "renderedAs": "native-shapes",
                    "factStatus": "inferred",
                    "note": "No synthetic chart data was created; visible bars remain editable shapes.",
                    "color": color,
                    **({"candidateRef": chart_candidate["id"]} if chart_candidate else {}),
                }
            )
            break
    if chart_candidate and not any(item.get("role") == "bar-chart" for item in result):
        result.append(
            {
                "role": "bar-chart",
                "confidence": chart_candidate["confidence"],
                "renderedAs": "native-shapes",
                "factStatus": "inferred",
                "candidateRef": chart_candidate["id"],
                "dataStatus": "geometry-only",
                "note": "No synthetic chart data was created; visible bars remain editable shapes.",
            }
        )
    if table_candidate and not any(item.get("role") == "table-grid" for item in result):
        result.append(
            {
                "role": "table-grid",
                "confidence": table_candidate["confidence"],
                "renderedAs": "native-shapes-and-connectors",
                "factStatus": "inferred",
                "candidateRef": table_candidate["id"],
                "dataStatus": "not-recovered",
            }
        )
    return result


def _box_from_item(item: dict[str, Any]) -> Box:
    return Box(**item["pixelBox"])


def _interval_overlap(left: int, right: int, other_left: int, other_right: int) -> int:
    return max(0, min(right, other_right) - max(left, other_left))


def _union_box(items: Iterable[dict[str, Any]]) -> Box:
    boxes = [_box_from_item(item) for item in items]
    if not boxes:
        return Box(0, 0, 1, 1)
    left = min(item.x for item in boxes)
    top = min(item.y for item in boxes)
    right = max(item.right for item in boxes)
    bottom = max(item.bottom for item in boxes)
    return Box(left, top, right - left, bottom - top)


def _boxes_close(left: Box, right: Box, gap: int) -> bool:
    if overlaps(left, right, 0.01):
        return True
    return not (
        left.right + gap < right.x
        or right.right + gap < left.x
        or left.bottom + gap < right.y
        or right.bottom + gap < left.y
    )


def _group_positions(values: list[int], tolerance: int = 2) -> list[int]:
    if not values:
        return []
    groups: list[list[int]] = [[values[0]]]
    for value in values[1:]:
        if value - groups[-1][-1] <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [round(sum(group) / len(group)) for group in groups]


def _longest_true_run(values: list[bool]) -> int:
    longest = current = 0
    for value in values:
        current = current + 1 if value else 0
        longest = max(longest, current)
    return longest


def _pixel_grid_positions(
    image: Image.Image,
    background: tuple[int, int, int],
) -> tuple[list[int], list[int], tuple[int, int, int, int] | None]:
    """Find repeated long dark runs for grids that merged at intersections."""

    width, height = image.size
    pixels = image.load()
    threshold = 28
    horizontal_rows: list[int] = []
    horizontal_bounds: list[tuple[int, int]] = []
    for y in range(height):
        mask = [color_distance(pixels[x, y], background) > threshold for x in range(width)]
        if _longest_true_run(mask) < max(20, round(width * 0.25)):
            continue
        runs: list[tuple[int, int]] = []
        start: int | None = None
        for x, active in enumerate(mask + [False]):
            if active and start is None:
                start = x
            elif not active and start is not None:
                runs.append((start, x))
                start = None
        longest = max(runs, key=lambda value: value[1] - value[0], default=(0, 0))
        if longest[1] - longest[0] >= width * 0.25:
            horizontal_rows.append(y)
            horizontal_bounds.append(longest)
    vertical_columns: list[int] = []
    vertical_bounds: list[tuple[int, int]] = []
    for x in range(width):
        mask = [color_distance(pixels[x, y], background) > threshold for y in range(height)]
        if _longest_true_run(mask) < max(20, round(height * 0.25)):
            continue
        runs = []
        start = None
        for y, active in enumerate(mask + [False]):
            if active and start is None:
                start = y
            elif not active and start is not None:
                runs.append((start, y))
                start = None
        longest = max(runs, key=lambda value: value[1] - value[0], default=(0, 0))
        if longest[1] - longest[0] >= height * 0.25:
            vertical_columns.append(x)
            vertical_bounds.append(longest)
    rows = _group_positions(horizontal_rows)
    columns = _group_positions(vertical_columns)
    if len(rows) < 2 or len(columns) < 2:
        return [], [], None
    # Use the grouped line centers for the outer edge.  Run bounds can stop at
    # an intersection, especially when a grid was split into many components.
    left = columns[0]
    right = columns[-1] + 2
    top = rows[0]
    bottom = rows[-1] + 2
    bounds = (left, top, max(1, right - left), max(1, bottom - top))
    return rows, columns, bounds


def component_candidates(
    objects: list[dict[str, Any]],
    width: int,
    height: int,
    image: Image.Image | None = None,
    background: tuple[int, int, int] | None = None,
) -> list[dict[str, Any]]:
    """Emit conservative table/chart candidates without fabricating datasets."""

    candidates: list[dict[str, Any]] = []
    connectors = [item for item in objects if item.get("type") == "connector"]
    horizontal = [
        item
        for item in connectors
        if item.get("direction") == "horizontal" and item["pixelBox"]["w"] >= width * 0.08
    ]
    vertical = [
        item
        for item in connectors
        if item.get("direction") == "vertical" and item["pixelBox"]["h"] >= height * 0.08
    ]
    if len(horizontal) >= 2 and len(vertical) >= 2:
        h_sorted = sorted(horizontal, key=lambda item: item["pixelBox"]["y"])
        v_sorted = sorted(vertical, key=lambda item: item["pixelBox"]["x"])
        grid_left = min(item["pixelBox"]["x"] for item in v_sorted)
        grid_right = max(item["pixelBox"]["x"] + item["pixelBox"]["w"] for item in v_sorted)
        grid_top = min(item["pixelBox"]["y"] for item in h_sorted)
        grid_bottom = max(item["pixelBox"]["y"] + item["pixelBox"]["h"] for item in h_sorted)
        grid_width = max(1, grid_right - grid_left)
        grid_height = max(1, grid_bottom - grid_top)
        horizontal_coverage = min(
            _interval_overlap(
                item["pixelBox"]["x"],
                item["pixelBox"]["x"] + item["pixelBox"]["w"],
                grid_left,
                grid_right,
            )
            / grid_width
            for item in h_sorted
        )
        vertical_coverage = min(
            _interval_overlap(
                item["pixelBox"]["y"],
                item["pixelBox"]["y"] + item["pixelBox"]["h"],
                grid_top,
                grid_bottom,
            )
            / grid_height
            for item in v_sorted
        )
        if horizontal_coverage >= 0.75 and vertical_coverage >= 0.75:
            grid_items = h_sorted + v_sorted
            confidence = round(0.65 + 0.2 * min(horizontal_coverage, vertical_coverage), 4)
            candidates.append(
                {
                    "id": "table-candidate-001",
                    "type": "table",
                    "objectType": "table",
                    "pixelBox": Box(grid_left, grid_top, grid_width, grid_height).as_dict(),
                    "memberIds": [item["id"] for item in grid_items],
                    "rows": max(1, len(h_sorted) - 1),
                    "columns": max(1, len(v_sorted) - 1),
                    "closedGrid": True,
                    "cellAssignment": "unresolved",
                    "dataStatus": "not-recovered",
                    "data": None,
                    "nativeObjectType": "table",
                    "nativeEligible": False,
                    "renderedAs": "native-shapes-and-connectors",
                    "confidence": confidence,
                    "factStatus": "inferred",
                    "provenance": "visible-grid-geometry-only",
                }
            )
    if not any(item.get("type") == "table" for item in candidates) and image is not None:
        rows, columns, bounds = _pixel_grid_positions(
            image,
            background or edge_background(image),
        )
        if bounds is not None:
            left, top, grid_width, grid_height = bounds
            # A page frame alone is not a useful table candidate; require at
            # least one interior row and column and keep the region bounded.
            if (
                len(rows) >= 3
                and len(columns) >= 3
                and grid_width * grid_height < width * height * 0.85
            ):
                nearby = [
                    item
                    for item in connectors
                    if item["pixelBox"]["x"] <= left + 4
                    or item["pixelBox"]["y"] <= top + 4
                ]
                candidates.append(
                    {
                        "id": "table-candidate-001",
                        "type": "table",
                        "objectType": "table",
                        "pixelBox": {
                            "x": left,
                            "y": top,
                            "w": grid_width,
                            "h": grid_height,
                        },
                        "memberIds": [item["id"] for item in nearby],
                        "rows": max(1, len(rows) - 1),
                        "columns": max(1, len(columns) - 1),
                        "closedGrid": True,
                        "cellAssignment": "unresolved",
                        "dataStatus": "not-recovered",
                        "data": None,
                        "nativeObjectType": "table",
                        "nativeEligible": False,
                        "renderedAs": "native-shapes-and-connectors",
                        "confidence": 0.76,
                        "factStatus": "inferred",
                        "provenance": "pixel-grid-scan",
                    }
                )

    # A chart candidate is geometry-only unless visible labels or a supplied
    # source establish actual values.  The output deliberately keeps data null.
    table_boxes = [
        _box_from_item(item)
        for item in candidates
        if item.get("type") == "table"
    ]
    filled = [
        item
        for item in objects
        if item.get("type") == "shape"
        and item.get("fill")
        and item["pixelBox"]["w"] >= max(8, round(width * 0.018))
        and item["pixelBox"]["h"] >= max(16, round(height * 0.05))
        and item["pixelBox"]["w"] <= width * 0.25
        and item["pixelBox"]["h"] <= height * 0.85
        and not any(overlaps(_box_from_item(item), table, 0.60) for table in table_boxes)
    ]
    chart_groups: list[list[dict[str, Any]]] = []
    baseline_tolerance = max(5, round(height * 0.02))
    # Bars often use a different fill per series/category.  Group by shared
    # baseline and spacing rather than exact RGB so palette variation does not
    # hide an otherwise visible chart.
    for item in sorted(filled, key=lambda value: value["pixelBox"]["x"]):
        bottom = item["pixelBox"]["y"] + item["pixelBox"]["h"]
        target_group = next(
            (
                values
                for values in chart_groups
                if abs(
                    bottom
                    - sum(
                        value["pixelBox"]["y"] + value["pixelBox"]["h"] for value in values
                    )
                    / len(values)
                )
                <= baseline_tolerance
            ),
            None,
        )
        if target_group is None:
            chart_groups.append([item])
        else:
            target_group.append(item)
    chart_groups = [values for values in chart_groups if len(values) >= 3]
    chart_groups = [
        values
        for values in chart_groups
        if len(
            {
                round(item["pixelBox"]["x"] + item["pixelBox"]["w"] / 2)
                for item in values
            }
        )
        >= 3
    ]
    if chart_groups:
        bars = max(chart_groups, key=len)
        box = _union_box(bars)
        candidates.append(
            {
                "id": f"chart-candidate-{len([item for item in candidates if item['type'] == 'chart']) + 1:03d}",
                "type": "chart",
                "objectType": "chart",
                "chartKind": "bar",
                "pixelBox": box.as_dict(),
                "memberIds": [item["id"] for item in bars],
                "series": None,
                "values": None,
                "data": None,
                "dataStatus": "geometry-only",
                "nativeObjectType": "shape",
                "nativeEligible": False,
                "renderedAs": "native-shapes",
                "confidence": round(min(0.9, 0.55 + len(bars) * 0.06), 4),
                "factStatus": "inferred",
                "provenance": "visible-bar-geometry-only",
                "note": "No synthetic chart data was created; visible bars remain editable shapes.",
            }
        )
    return candidates


def layout_groups(
    objects: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    width: int,
    height: int,
    gap: int = LAYOUT_GROUP_GAP_PX,
) -> list[dict[str, Any]]:
    """Group nearby native objects for downstream layout-aware consumers."""

    eligible = [
        item
        for item in objects
        if item.get("type") in {"shape", "connector", "text", "table"}
        and not (
            item.get("type") == "shape"
            and _box_from_item(item).area >= width * height * 0.60
        )
    ]
    if not eligible:
        return []
    parent = list(range(len(eligible)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        root_left, root_right = find(left), find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for index, left in enumerate(eligible):
        for other_index in range(index + 1, len(eligible)):
            right = eligible[other_index]
            if _boxes_close(_box_from_item(left), _box_from_item(right), gap):
                union(index, other_index)

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for index, item in enumerate(eligible):
        grouped[find(index)].append(item)
    candidate_roles = {
        member_id: candidate["type"]
        for candidate in candidates
        for member_id in candidate.get("memberIds", [])
    }
    result: list[dict[str, Any]] = []
    ordered_groups = sorted(
        grouped.values(),
        key=lambda values: (
            min(item["pixelBox"]["y"] for item in values),
            min(item["pixelBox"]["x"] for item in values),
        ),
    )
    for number, values in enumerate(ordered_groups, 1):
        box = _union_box(values)
        roles = [candidate_roles.get(item["id"]) for item in values if item["id"] in candidate_roles]
        role = roles[0] if roles else (
            "text-block" if any(item.get("type") == "text" for item in values) else "native-group"
        )
        member_ids = [item["id"] for item in sorted(values, key=lambda item: item.get("z", 0))]
        confidence = round(min(float(item.get("confidence", 1.0)) for item in values), 4)
        group_id = f"layout-group-{number:03d}"
        for item in values:
            item["layoutGroupRef"] = group_id
        result.append(
            {
                "id": group_id,
                "role": role,
                "pixelBox": box.as_dict(),
                "memberIds": member_ids,
                "readingOrder": number,
                "confidence": confidence,
                "factStatus": "inferred",
                "provenance": "deterministic-box-proximity",
            }
        )
    return result


def write_crop(
    image: Image.Image, box: Box, path: Path
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.crop((box.x, box.y, box.right, box.bottom)).save(path)


def relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def analyze_slide(
    source: Path,
    normalized_path: Path,
    slide_index: int,
    root: Path,
    assets_dir: Path,
    annotations_dir: Path,
    langs: str,
    threshold: float,
    target_size: tuple[int, int],
    runtime: dict[str, Any] | None = None,
    provider: OcrProvider | None = None,
    font_inventory: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    original = load_source(source)
    target_width, target_height = target_size
    normalized = original.resize(target_size, Image.Resampling.LANCZOS)
    if font_inventory is None:
        try:
            font_inventory = discover_font_inventory()
        except RuntimeError as error:
            fail("E_FONT_RUNTIME", str(error))
    if font_inventory.get("runtime", {}).get("fontTools", {}).get("status") != "available":
        fail(
            "E_FONT_RUNTIME",
            "fontTools is required for deterministic font inventory; install the pinned requirements",
        )
    normalized_path.parent.mkdir(parents=True, exist_ok=True)
    normalized.save(normalized_path)
    normalized_source_digest = sha256(normalized_path)
    background = edge_background(normalized)
    palette = dominant_palette(normalized)
    orientation = orientation_metadata(normalized)
    slide_runtime = runtime or validate_ocr_runtime(langs, orientation)
    resolved_langs = str(slide_runtime["langs"])
    language_info = language_metadata(
        slide_runtime["requestedLanguages"],
        orientation,
        slide_runtime["resolvedLanguages"],
        slide_runtime["resolutionEvidence"],
    )
    words, lines = ocr_lines(
        normalized,
        resolved_langs,
        threshold,
        orientation,
        language_info,
        provider,
    )
    lines, region_ocr_report = regional_ocr(
        normalized,
        lines,
        resolved_langs,
        provider,
    )
    shapes, connectors = exact_color_components(normalized, background, COLOR_TOLERANCE)
    slide_id = f"slide-{slide_index:03d}"
    source_id = f"source-{slide_index:03d}"
    source_digest = sha256(source)
    objects: list[dict[str, Any]] = []
    degradations: list[dict[str, Any]] = []
    z = 0

    for number, item in enumerate(shapes, 1):
        objects.append(
            {
                **item,
                "id": f"{slide_id}-shape-{number:03d}",
                "z": z,
                "factStatus": "observed",
            }
        )
        z += 1
    for number, item in enumerate(connectors, 1):
        objects.append(
            {
                **item,
                "id": f"{slide_id}-connector-{number:03d}",
                "z": z,
                "factStatus": "observed",
            }
        )
        z += 1

    # Structured candidates are native claims as well: residual extraction
    # must see them before it is allowed to create an image asset.
    candidates = component_candidates(
        objects,
        target_width,
        target_height,
        normalized,
        background,
    )
    for candidate in candidates:
        candidate["id"] = f"{slide_id}-{candidate['id']}"

    # Determine final OCR disposition before ownership claims are built. Only
    # lines that will become editable text may claim native_text pixels;
    # low-confidence lines are explicit raster claims instead.
    raster_line_boxes: list[dict[str, Any]] = []
    for number, line in enumerate(lines, 1):
        target_box = Box(**line["pixelBox"])
        object_id = f"{slide_id}-text-{number:03d}"
        line["id"] = object_id
        line["objectRef"] = object_id
        if sum(character.isalnum() for character in line["text"]) < 2:
            line["disposition"] = "ignored-nonsemantic-glyph"
            continue
        compact_label = sum(character.isalnum() for character in line["text"]) <= 4
        effective_threshold = max(threshold, 0.80) if compact_label else threshold
        line["disposition"] = (
            "editable-text" if line["confidence"] >= effective_threshold else "local-crop"
        )
        if line["disposition"] == "local-crop":
            raster_line_boxes.append(
                {
                    "id": object_id,
                    "pixelBox": target_box.as_dict(),
                    "reason": "low-confidence-ocr",
                    "confidence": line["confidence"],
                }
            )

    ownership_masks, ownership_report, residuals = build_ownership_masks(
        normalized,
        [line for line in lines if line.get("disposition") == "editable-text"],
        [item for item in objects if item.get("type") == "shape"],
        [item for item in objects if item.get("type") == "connector"],
        candidates,
        raster_boxes=raster_line_boxes,
        tolerance_px=OWNERSHIP_TOLERANCE_PX,
    )
    ownership_report["sourceRef"] = source_id
    ownership_dir = root / "reports" / "ownership"
    for class_name, mask in ownership_masks.items():
        mask_path = ownership_dir / f"{slide_id}-{class_name}.png"
        mask_digest = write_mask(mask, mask_path)
        ownership_report["classes"][class_name]["maskDigest"] = mask_digest
        ownership_report["classes"][class_name]["path"] = relative(mask_path, root)

    ownership_report["assets"] = []
    complex_residuals = [item for item in residuals if item.get("reason") != "low-confidence-ocr"]
    for number, item in enumerate(complex_residuals, 1):
        box = Box(**item["pixelBox"])
        if (
            (box.w >= target_width * 0.90 and box.h >= target_height * 0.90)
            or box.area >= target_width * target_height * 0.80
        ):
            fail(
                "E_WHOLE_SLIDE_FALLBACK",
                f"{slide_id} is globally complex; a prohibited whole-slide raster would be required",
            )
        crop_path = assets_dir / slide_id / f"complex-{number:03d}.png"
        component_mask = item.pop("_mask")
        mask_crop = component_mask.crop((box.x, box.y, box.right, box.bottom))
        mask_path = ownership_dir / slide_id / f"complex-{number:03d}.png"
        mask_digest = write_mask(mask_crop, mask_path)
        asset_digest, _ = write_transparent_crop(normalized, component_mask, box, crop_path)
        object_id = f"{slide_id}-complex-{number:03d}"
        ownership_report["assets"].append(
            {
                "objectId": object_id,
                "asset": relative(crop_path, root),
                "mask": relative(mask_path, root),
                "pagePixelBox": box.as_dict(),
                "originPagePixelBox": box.as_dict(),
                "sourceRef": source_id,
                "sourceDigest": normalized_source_digest,
                "normalizedSourceDigest": normalized_source_digest,
                "maskDigest": mask_digest,
                "assetDigest": asset_digest,
                "provenance": "claimed-pixel-residual; alpha=ownership-mask",
            }
        )
        objects.append(
            {
                **{key: value for key, value in item.items() if key not in {"maskDigest", "source"}},
                "id": object_id,
                "polygon": box_polygon(box),
                "asset": relative(crop_path, root),
                "sourceDigest": normalized_source_digest,
                "normalizedSourceDigest": normalized_source_digest,
                "sourceRef": source_id,
                "maskDigest": mask_digest,
                "assetDigest": asset_digest,
                "provenance": "claimed-pixel-residual; alpha=ownership-mask",
                "z": z,
                "factStatus": "observed",
            }
        )
        degradations.append(
            {
                "id": f"degradation-{object_id}",
                "slideId": slide_id,
                "componentId": object_id,
                "reason": item["reason"],
                "editabilityImpact": "non-editable-region",
                "nativeAlternativesAttempted": [
                    "editable-text",
                    "native-shape",
                    "native-table",
                    "native-chart",
                    "connector",
                ],
            }
        )
        z += 1

    low_lines = []
    font_page_budget = {"evaluated": 0, "limit": 180}
    low_residuals = {
        str(item.get("objectRef")): item
        for item in residuals
        if item.get("reason") == "low-confidence-ocr" and item.get("objectRef")
    }
    tier_requirements = build_tier_requirements(lines, normalized.height)
    font_page_budget["tierRequirements"] = tier_requirements
    for number, line in enumerate(lines, 1):
        target_box = Box(**line["pixelBox"])
        object_id = f"{slide_id}-text-{number:03d}"
        line["id"] = object_id
        line["objectRef"] = object_id
        if sum(character.isalnum() for character in line["text"]) < 2:
            line["disposition"] = "ignored-nonsemantic-glyph"
            continue
        compact_label = sum(character.isalnum() for character in line["text"]) <= 4
        effective_threshold = max(threshold, 0.80) if compact_label else threshold
        line["disposition"] = (
            "editable-text" if line["confidence"] >= effective_threshold else "local-crop"
        )
        if line["confidence"] >= effective_threshold:
            foreground = foreground_color(normalized, target_box)
            solver_line = {**line, "color": foreground}
            try:
                style, render_box_data, font_evidence, tier_hint = solve_text_style(
                    normalized,
                    target_box.as_dict(),
                    line["text"],
                    solver_line,
                    font_inventory,
                    page_budget=font_page_budget,
                    object_id=object_id,
                    tier_requirements=tier_requirements,
                )
            except RuntimeError as error:
                fail("E_FONT_RUNTIME", str(error))
            render_box = Box(**{key: int(value) for key, value in render_box_data.items()})
            objects.append(
                {
                    "id": object_id,
                    "type": "text",
                    "text": line["text"],
                    "confidence": line["confidence"],
                    "recognitionPass": line.get("recognitionPass", "primary"),
                    "pixelBox": target_box.as_dict(),
                    "polygon": box_polygon(target_box),
                    "renderBox": render_box.as_dict(),
                    "readingOrder": line.get("readingOrder", number),
                    "languages": line.get("languages", language_info["requested"]),
                    "orientation": orientation,
                    "style": style,
                    "fontSolver": font_evidence,
                    "typographyTierHint": tier_hint,
                    "fontInventoryRef": "reports/font-inventory.json",
                    "z": z,
                    "factStatus": "recognized",
                }
            )
            z += 1
        else:
            raster_item = low_residuals.get(object_id)
            asset = None
            if raster_item is not None:
                crop_box = Box(**raster_item["pixelBox"])
                component_mask = raster_item.pop("_mask")
                crop_path = assets_dir / slide_id / f"low-confidence-{number:03d}.png"
                mask_crop = component_mask.crop((crop_box.x, crop_box.y, crop_box.right, crop_box.bottom))
                mask_path = ownership_dir / slide_id / f"low-confidence-{number:03d}.png"
                mask_digest = write_mask(mask_crop, mask_path)
                asset_digest, _ = write_transparent_crop(normalized, component_mask, crop_box, crop_path)
                asset = relative(crop_path, root)
                ownership_report["assets"].append(
                    {
                        "objectId": object_id,
                        "asset": asset,
                        "mask": relative(mask_path, root),
                        "pagePixelBox": crop_box.as_dict(),
                        "originPagePixelBox": crop_box.as_dict(),
                        "sourceRef": source_id,
                        "sourceDigest": normalized_source_digest,
                        "normalizedSourceDigest": normalized_source_digest,
                        "maskDigest": mask_digest,
                        "assetDigest": asset_digest,
                        "provenance": "low-confidence-ocr; alpha=ownership-mask",
                    }
                )
                objects.append(
                    {
                        "id": object_id,
                        "type": "image",
                        "asset": asset,
                        "pixelBox": crop_box.as_dict(),
                        "polygon": box_polygon(crop_box),
                        "confidence": line["confidence"],
                        "sourceRef": source_id,
                        "sourceDigest": normalized_source_digest,
                        "normalizedSourceDigest": normalized_source_digest,
                        "maskDigest": mask_digest,
                        "assetDigest": asset_digest,
                        "provenance": "low-confidence-ocr; alpha=ownership-mask",
                        "readingOrder": line.get("readingOrder", number),
                        "languages": line.get("languages", language_info["requested"]),
                        "orientation": orientation,
                        "reason": "low-confidence-ocr",
                        "z": z,
                        "factStatus": "recognized",
                    }
                )
                z += 1
            low_lines.append({**line, "id": object_id, "asset": asset})
            degradations.append(
                {
                    "id": f"degradation-{object_id}",
                    "slideId": slide_id,
                    "componentId": object_id,
                    "reason": "low-confidence-ocr",
                    "editabilityImpact": "non-editable-region",
                    "nativeAlternativesAttempted": ["editable-text"],
                    "confidence": line["confidence"],
                }
            )

    validate_duplicate_visible_content(ownership_report["assets"])

    inferences = component_inferences(shapes, connectors, candidates)
    groups = layout_groups(objects, candidates, target_width, target_height)
    page_profile = build_page_profile(
        normalized,
        objects,
        lines,
        residuals,
        candidates,
        groups=groups,
        source_size=(original.width, original.height),
    )
    region_profiles = build_region_profiles(
        slide_id,
        source_id,
        objects,
        lines,
        groups,
        target_size,
    )
    scene_layers = infer_layers(objects, image_size=target_size)
    stable_z = {
        object_id: index
        for index, object_id in enumerate(scene_layers["stableOrder"])
    }
    for object_record in objects:
        if object_record["id"] in stable_z:
            object_record["z"] = stable_z[object_record["id"]]
    objects.sort(key=lambda item: (item["z"], item["id"]))
    try:
        typography_tiers = apply_typography_tiers(objects, lines, target_size, inventory=font_inventory)
    except RuntimeError as error:
        fail("E_FONT_RUNTIME", str(error))
    try:
        reconstruction_plan = build_reconstruction_plan(
            slide_id,
            target_size,
            region_profiles,
            objects,
            ownership_report,
            [{
                "id": source_id,
                "sha256": source_digest,
                "normalizedSha256": sha256(normalized_path),
            }],
            package_root=root,
        )
    except ReconstructionPlanError as error:
        fail(error.code, str(error))
    pixel_layers = analyze_layers(
        normalized,
        text_boxes=[line["pixelBox"] for line in lines],
        background=background,
        tolerance=COLOR_TOLERANCE,
        min_component_area=max(4, round(target_width * target_height * 0.00002)),
        repair=False,
        source_ref=source_id,
        source_sha256=source_digest,
    )

    annotated = normalized.copy()
    draw = ImageDraw.Draw(annotated)
    for line in low_lines:
        box = Box(**line["pixelBox"])
        draw.rectangle((box.x - 2, box.y - 2, box.right + 2, box.bottom + 2), outline="#E53935", width=3)
    annotation_path = annotations_dir / f"{slide_id}.png"
    annotation_path.parent.mkdir(parents=True, exist_ok=True)
    annotated.save(annotation_path)

    source_record = {
        "id": source_id,
        "kind": "user-image",
        "label": source.name,
        "factStatus": "provided",
        "path": relative(source, root),
        "sha256": source_digest,
        "bytes": source.stat().st_size,
        "originalSize": {"width": original.width, "height": original.height},
        "normalizedPath": relative(normalized_path, root),
        "normalizedSha256": sha256(normalized_path),
        "normalizedSize": {"width": target_width, "height": target_height},
    }
    title = next(
        (
            line["text"]
            for line in lines
            if line["confidence"] >= threshold
        ),
        f"Reconstructed slide {slide_index}",
    )
    slide = {
        "id": slide_id,
        "order": slide_index,
        "title": title,
        "sourceRef": source_record["id"],
        "background": rgb_hex(background),
        "palette": palette,
        "colorAnalysis": {
            "method": "tolerant-connected-components",
            "tolerancePx": COLOR_TOLERANCE,
            "distance": "rgb-euclidean-seed",
        },
        "orientation": orientation,
        "languageMetadata": language_info,
        "pageProfile": page_profile,
        "regionProfiles": region_profiles,
        "reconstructionPlan": reconstruction_plan,
        "sizePx": {"width": target_width, "height": target_height},
        "ownershipReport": ownership_report,
        "typographyTiers": typography_tiers,
        "fontInventoryRef": "reports/font-inventory.json",
        "objects": objects,
        "componentInferences": inferences,
        "componentCandidates": candidates,
        "layoutGroups": groups,
        "layerAnalysis": pixel_layers,
        "sceneLayerGraph": scene_layers,
        "annotation": relative(annotation_path, root),
        "degradations": degradations,
    }
    ocr = {
        "slideId": slide_id,
        "sourceRef": source_record["id"],
        "status": "ok",
        "threshold": threshold,
        "langs": resolved_langs,
        "languages": language_info["resolved"],
        "requestedLanguages": slide_runtime["requestedLanguages"],
        "resolvedLanguages": slide_runtime["resolvedLanguages"],
        "resolutionEvidence": slide_runtime["resolutionEvidence"],
        "languageMetadata": language_info,
        "orientation": orientation,
        "pageDetectionWords": words,
        "words": words,
        "wordEvidenceStage": "page-detection",
        "wordProvenance": "whole-page-psm-11-preliminary; compatibility alias only",
        "finalLines": lines,
        "lines": lines,
        "lineEvidenceStage": "region-selected-or-page-detection-budget-deferred",
        "lowConfidenceCount": len(low_lines),
        "regionOcr": region_ocr_report,
        "regionOcrBudget": region_ocr_report[-1] if region_ocr_report else {
            "kind": "summary",
            "budgetLimit": MAX_PAGE_REGION_OCR_CALLS,
            "callsUsed": 0,
            "lineCount": 0,
            "deferredCount": 0,
        },
        "pageProfile": page_profile,
        "regionProfiles": region_profiles,
        "annotation": relative(annotation_path, root),
    }
    return slide, ocr, [source_record], slide_runtime


def build_analysis(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    if not args.images:
        fail("E_INPUT_REQUIRED", "at least one image is required")
    if not 0 <= args.ocr_threshold <= 1:
        fail("E_CONTRACT", "--ocr-threshold must be in [0,1]")
    root = args.package_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    loaded = [(path, load_source(path)) for path in args.images]
    ratios = [image.width / image.height for _, image in loaded]
    if max(ratios) / min(ratios) > 1.01:
        fail(
            "E_PAGE_RATIO_MISMATCH",
            "all pages must share one aspect ratio within one percent",
        )
    ratio = ratios[0]
    target_height = round(CANONICAL_WIDTH_PX / ratio)
    target_size = (CANONICAL_WIDTH_PX, target_height)
    slide_height_in = SLIDE_WIDTH_IN / ratio
    try:
        font_inventory = discover_font_inventory()
    except RuntimeError as error:
        fail("E_FONT_RUNTIME", str(error))
    if font_inventory.get("runtime", {}).get("fontTools", {}).get("status") != "available":
        fail(
            "E_FONT_RUNTIME",
            "fontTools is required for deterministic font inventory; install the pinned requirements",
        )
    slides: list[dict[str, Any]] = []
    ocr_slides: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    runtime: dict[str, Any] | None = None
    for index, (source, _) in enumerate(loaded, 1):
        normalized = root / "evidence" / "reference" / f"slide-{index:03d}.png"
        slide, ocr, source_records, slide_runtime = analyze_slide(
            source.resolve(),
            normalized,
            index,
            root,
            args.assets_dir.resolve(),
            args.annotations_dir.resolve(),
            args.langs,
            args.ocr_threshold,
            target_size,
            runtime=None,
            font_inventory=font_inventory,
        )
        if runtime is None:
            runtime = dict(slide_runtime)
        elif runtime.get("resolvedLanguages") != slide_runtime.get("resolvedLanguages"):
            merged = sorted(
                set(runtime.get("resolvedLanguages", []))
                | set(slide_runtime.get("resolvedLanguages", []))
            )
            runtime["resolvedLanguages"] = merged
            runtime["langs"] = "+".join(merged)
            runtime["resolutionEvidence"] = {
                "mode": "multi-slide",
                "detectedScript": None,
                "detectionStatus": "mixed",
                "detectionSource": "tesseract-osd",
                "mapping": "per-slide-resolution",
                "slides": [
                    item.get("resolutionEvidence")
                    for item in (runtime, slide_runtime)
                ],
            }
        slides.append(slide)
        ocr_slides.append(ocr)
        sources.extend(source_records)
    refresh_font_inventory(
        font_inventory,
        [
            line.get("text", "")
            for slide_ocr in ocr_slides
            for line in slide_ocr.get("lines", [])
            if line.get("text")
        ],
    )
    inventory_path = root / "reports" / "font-inventory.json"
    inventory_path.parent.mkdir(parents=True, exist_ok=True)
    inventory_path.write_text(
        json.dumps(serializable_inventory(font_inventory), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    font_inventory_ref = {
        "path": relative(inventory_path, root),
        "sha256": sha256(inventory_path),
    }
    for slide in slides:
        slide["fontInventoryRef"] = font_inventory_ref
    reconstruction_report = {
        "version": "1.0.0",
        "kind": "image-reconstruction-plan",
        "pages": [slide["reconstructionPlan"] for slide in slides],
        "lossConfig": {
            "version": "1.0.0",
            "estimatedFrom": "analysis",
        },
        "provenance": {
            "sourceRefs": sorted({source["id"] for source in sources}),
            "planner": "deterministic-region-candidate-selector",
        },
    }
    reconstruction_report_path = root / "reports" / "reconstruction-plan.json"
    reconstruction_report_path.write_text(
        json.dumps(reconstruction_report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    reconstruction_report_ref = {
        "path": relative(reconstruction_report_path, root),
        "sha256": sha256(reconstruction_report_path),
    }
    all_palette = Counter(
        color["hex"] for slide in slides for color in slide["palette"][:5]
    )
    common = [item for item, _ in all_palette.most_common(6)]
    tokens = {
        "version": "1.0.0",
        "source": "extracted-from-reference-images",
        "colors": {
            "background": slides[0]["background"],
            "primary": next(
                (color for color in common if color != slides[0]["background"]),
                "#172033",
            ),
            "palette": common,
        },
        "typography": {
            "primary": next(
                (
                    item.get("style", {}).get("fontFamily")
                    for slide in slides
                    for item in slide.get("objects", [])
                    if item.get("type") == "text" and item.get("style", {}).get("fontFamily")
                ),
                font_inventory.get("candidateFamilies", ["Noto Sans"])[0],
            ),
            "fallbacks": font_inventory.get("candidateFamilies", [])[:6],
            "solver": font_inventory.get("solver", {}),
        },
        "page": {
            "widthPx": target_size[0],
            "heightPx": target_size[1],
            "widthIn": round(SLIDE_WIDTH_IN, 4),
            "heightIn": round(slide_height_in, 4),
        },
    }
    degradations = [item for slide in slides for item in slide["degradations"]]
    assert runtime is not None
    analysis = {
        "version": VERSION,
        "kind": "image-reconstruction-analysis",
        "generator": "image-to-pptx",
        "deck": {
            "id": "image-reconstruction",
            "title": args.title,
            "size": {
                "widthPx": target_size[0],
                "heightPx": target_size[1],
                "widthIn": round(SLIDE_WIDTH_IN, 4),
                "heightIn": round(slide_height_in, 4),
            },
        },
        "ocr": {
            **runtime,
            "threshold": args.ocr_threshold,
            "languages": runtime["resolvedLanguages"],
            "policy": "visible text only; below-threshold text remains a local crop",
        },
        "sources": sources,
        "slides": slides,
        "reconstructionPlan": reconstruction_report,
        "reconstructionPlanRef": reconstruction_report_ref,
        "fontInventoryRef": font_inventory_ref,
        "designTokens": tokens,
        "degradations": degradations,
        "editabilityTarget": {"minimumLevel": 3, "wholeSlideRasterAllowed": False},
    }
    ocr_report = {
        "version": VERSION,
        "engine": runtime,
        "threshold": args.ocr_threshold,
        "slides": ocr_slides,
        "summary": {
            "lineCount": sum(len(item["lines"]) for item in ocr_slides),
            "lowConfidenceCount": sum(item["lowConfidenceCount"] for item in ocr_slides),
            "unverifiedTextCount": sum(item["lowConfidenceCount"] for item in ocr_slides),
            "orientationStatus": Counter(
                item["orientation"].get("status", "unavailable") for item in ocr_slides
            ),
            "scripts": sorted(
                {
                    item["orientation"].get("script")
                    for item in ocr_slides
                    if item["orientation"].get("script")
                }
            ),
        },
    }
    return analysis, ocr_report


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ocr-report", required=True, type=Path)
    parser.add_argument("--assets-dir", required=True, type=Path)
    parser.add_argument("--annotations-dir", required=True, type=Path)
    parser.add_argument("--title", default="Image reconstruction")
    parser.add_argument("--langs", default="eng")
    parser.add_argument("--ocr-threshold", type=float, default=0.70)
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    try:
        analysis, ocr_report = build_analysis(args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.ocr_report.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(analysis, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        args.ocr_report.write_text(
            json.dumps(ocr_report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "status": "ok",
                    "analysis": str(args.output.resolve()),
                    "ocrReport": str(args.ocr_report.resolve()),
                    "slideCount": len(analysis["slides"]),
                }
            )
        )
    except AnalysisError as error:
        print(
            json.dumps(
                {"status": "failed", "code": error.code, "message": str(error)}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
