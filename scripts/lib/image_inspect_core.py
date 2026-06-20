"""Deterministic image inspection helpers for host-agent manifest authoring."""

from __future__ import annotations

import json
import re
import shutil
import struct
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError:  # pragma: no cover - exercised when Pillow missing
    Image = None  # type: ignore[misc, assignment]


def load_design_tokens(design_md_path: Path) -> dict[str, Any]:
    """Parse the YAML frontmatter of a DESIGN.md file with stdlib only.

    Returns a dict-shaped token table mirroring what
    ``scripts/parse-design-md.mjs`` produces for the ``tokens`` field.
    Only the small subset used by the palette resolver — ``colors``,
    plus a few metadata keys (``name``, ``version``) — is extracted.

    The DESIGN.md format is simple key/value YAML with quoted string
    values, so a regex extractor is sufficient and avoids adding a new
    dependency. Malformed files return an empty dict so downstream code
    degrades to "no tokens available" rather than crashing.
    """
    try:
        text = design_md_path.read_text(encoding="utf-8")
    except OSError:
        return {}
    text = text.replace("\r\n", "\n")
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end < 0:
        return {}
    front = text[4:end]

    tokens: dict[str, Any] = {}
    colors: dict[str, str] = {}
    for line in front.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$", stripped)
        if not match:
            continue
        key, raw = match.group(1), match.group(2).strip()
        # Strip YAML comments and surrounding quotes.
        if "#" in raw:
            raw = raw.split("#", 1)[0].strip()
        if (raw.startswith('"') and raw.endswith('"')) or (
            raw.startswith("'") and raw.endswith("'")
        ):
            raw = raw[1:-1]
        if key == "colors":
            # Handled by indented children below.
            continue
        if key in {"name", "description", "version"}:
            tokens[key] = raw

    # Second pass: parse `colors:` block (indented two spaces in practice).
    in_colors = False
    for line in front.splitlines():
        stripped = line.strip()
        if stripped.startswith("colors:"):
            in_colors = True
            continue
        if in_colors:
            if not line.startswith((" ", "\t")):
                # End of the colors block when we see another top-level key.
                in_colors = False
                continue
            child = re.match(r"^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$", line)
            if not child:
                continue
            ckey, cval = child.group(1), child.group(2).strip()
            if cval.startswith('"') and cval.endswith('"'):
                cval = cval[1:-1]
            elif cval.startswith("'") and cval.endswith("'"):
                cval = cval[1:-1]
            if re.match(r"^#[0-9a-fA-F]{6}$", cval):
                colors[ckey] = cval.upper() if cval.startswith("#") else f"#{cval.upper()}"

    if colors:
        tokens["colors"] = colors
    return tokens

SLIDE_PRESETS: dict[str, dict[str, float | str]] = {
    "wide": {"width": 13.333, "height": 7.5, "unit": "in"},
}

HINTS_VERSION = "0.1.0"
REPLICA_VERSION = "0.2.0"
MANIFEST_VERSION = "0.1.1"


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    def as_dict(self) -> dict[str, float]:
        return {"x": round(self.x, 4), "y": round(self.y, 4), "w": round(self.w, 4), "h": round(self.h, 4)}


def _fail(message: str) -> None:
    raise ValueError(message)


def _require_pillow() -> None:
    if Image is None:
        _fail("Pillow is required. Install with: pip install -r requirements.txt")


def png_dimensions_stdlib(path: Path) -> tuple[int, int]:
    """Read PNG width/height from IHDR without Pillow."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        _fail(f"not a PNG file: {path}")
    # IHDR chunk starts at byte 8; width/height are big-endian uint32 at 16 and 20
    if len(data) < 24:
        _fail(f"truncated PNG: {path}")
    width, height = struct.unpack(">II", data[16:24])
    return int(width), int(height)


def load_image(path: Path) -> Any:
    _require_pillow()
    if not path.exists():
        _fail(f"image not found: {path}")
    with Image.open(path) as img:
        return img.copy()


def image_metadata(path: Path, image: Any | None = None, *, relative_to: Path | None = None) -> dict[str, Any]:
    _require_pillow()
    img = image if image is not None else load_image(path)
    width, height = img.size
    has_alpha = img.mode in {"RGBA", "LA", "PA"} or "transparency" in getattr(img, "info", {})
    ratio = width / height if height else 0.0
    orientation = "landscape" if width >= height else "portrait"
    display_path = path.name
    if relative_to:
        try:
            display_path = str(path.resolve().relative_to(relative_to.resolve()))
        except ValueError:
            display_path = str(path)
    return {
        "path": display_path,
        "widthPx": width,
        "heightPx": height,
        "format": (img.format or path.suffix.lstrip(".").upper() or "UNKNOWN"),
        "mode": img.mode,
        "hasAlpha": bool(has_alpha),
        "aspectRatio": round(ratio, 4),
        "orientation": orientation,
    }


def slide_mapping(preset: str, image_meta: dict[str, Any]) -> dict[str, Any]:
    size = SLIDE_PRESETS.get(preset)
    if not size:
        _fail(f"unknown slide preset: {preset}")
    width_in = float(size["width"])
    height_in = float(size["height"])
    width_px = float(image_meta["widthPx"])
    height_px = float(image_meta["heightPx"])
    return {
        "preset": preset,
        "widthIn": width_in,
        "heightIn": height_in,
        "unit": size["unit"],
        "pxPerInX": round(width_px / width_in, 4) if width_in else 0.0,
        "pxPerInY": round(height_px / height_in, 4) if height_in else 0.0,
    }


def px_to_inch(box: Box, mapping: dict[str, Any]) -> Box:
    px_per_in_x = mapping["pxPerInX"] or 1.0
    px_per_in_y = mapping["pxPerInY"] or 1.0
    return Box(
        x=box.x / px_per_in_x,
        y=box.y / px_per_in_y,
        w=box.w / px_per_in_x,
        h=box.h / px_per_in_y,
    )


def _rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def extract_palette(image: Any, count: int = 6) -> list[dict[str, Any]]:
    _require_pillow()
    count = max(1, min(count, 12))
    rgb = image.convert("RGB")
    sample = rgb.resize((160, 90))
    quantized = sample.quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()
    if hasattr(quantized, "get_flattened_data"):
        pixels = quantized.get_flattened_data()
    else:
        pixels = quantized.getdata()
    color_counts = Counter(pixels)
    total = sum(color_counts.values()) or 1
    entries: list[dict[str, Any]] = []
    for color_index, pixel_count in color_counts.most_common(count):
        if palette is None:
            continue
        base = color_index * 3
        rgb_tuple = (palette[base], palette[base + 1], palette[base + 2])
        entries.append(
            {
                "hex": _rgb_to_hex(rgb_tuple),
                "rgb": list(rgb_tuple),
                "share": round(pixel_count / total, 4),
            }
        )
    return entries


# -- U9 palette -> DESIGN.md token resolution --------------------------------
#
# Pure-Python mirror of scripts/lib/color-tokens.mjs (CIE76 ΔE in CIELAB
# space). Kept in sync deliberately so the image adapter can resolve the
# extracted palette to tokens without spawning a subprocess. Both code
# paths share the same math contract:
#
#   - sRGB → linear RGB → XYZ (D65) → LAB
#   - ΔE76 = sqrt((L1-L2)² + (a1-a2)² + (b1-b2)²)
#   - threshold default 8 (same as the JS module)
#
# Strict replica mode short-circuits resolution (skipped=True, paletteMatch=0).

_D65 = {"xn": 95.047, "yn": 100.0, "zn": 108.883}
_PALETTE_RESOLVER_THRESHOLD = 8.0


def _srgb_channel_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _pivot_xyz(t: float) -> float:
    return t ** (1.0 / 3.0) if t > 0.008856 else 7.787 * t + 16.0 / 116.0


def _rgb_to_lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    rl = _srgb_channel_to_linear(rgb[0] / 255.0)
    gl = _srgb_channel_to_linear(rgb[1] / 255.0)
    bl = _srgb_channel_to_linear(rgb[2] / 255.0)
    x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
    y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
    z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
    fx = _pivot_xyz(x / (_D65["xn"] / 100.0))
    fy = _pivot_xyz(y / (_D65["yn"] / 100.0))
    fz = _pivot_xyz(z / (_D65["zn"] / 100.0))
    return (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))


def _delta_e76(rgb_a: tuple[int, int, int], rgb_b: tuple[int, int, int]) -> float:
    l1, a1, b1 = _rgb_to_lab(rgb_a)
    l2, a2, b2 = _rgb_to_lab(rgb_b)
    return ((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) ** 0.5


def _normalize_hex(hex_value: str) -> str | None:
    if not isinstance(hex_value, str):
        return None
    trimmed = hex_value.strip().lstrip("#")
    if len(trimmed) != 6:
        return None
    try:
        int(trimmed, 16)
    except ValueError:
        return None
    return f"#{trimmed.upper()}"


def _extract_design_colors(design_tokens: dict[str, Any] | None) -> list[dict[str, str]]:
    if not isinstance(design_tokens, dict):
        return []
    colors = design_tokens.get("colors") or {}
    out: list[dict[str, str]] = []
    for name, value in colors.items():
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if not (len(trimmed) == 7 and trimmed.startswith("#")) and not (len(trimmed) == 6):
            continue
        normalized = _normalize_hex(trimmed)
        if normalized is None:
            continue
        out.append({"name": name, "hex": normalized})
    return out


def resolve_palette_to_tokens(
    palette: list[dict[str, Any]],
    design_tokens: dict[str, Any] | None,
    *,
    threshold: float = _PALETTE_RESOLVER_THRESHOLD,
    is_replica: bool = False,
    origin_prefix: str = "palette",
) -> dict[str, Any]:
    """Resolve an extracted palette to DESIGN.md tokens via CIE76 ΔE.

    Pure function — no side effects, no I/O. Mirrors the contract of
    `resolveTokens` in `scripts/lib/color-tokens.mjs` so the image and
    HTML adapters report consistent paletteMatch values.

    Returns a dict with `matches`, `unmapped`, `paletteMatch`, and
    `skipped` (True when `is_replica=True`). When `palette` is empty,
    `paletteMatch` is 1 (no mismatch to measure). When `design_tokens` is
    empty or has no literal hex colors, every palette entry is unmapped
    and `paletteMatch` is 0.

    Each input palette entry is converted to `{hex, origin}` for the
    resolver; `origin` defaults to `<origin_prefix>-<index>`. Entries
    that already provide a string `origin` keep it verbatim.
    """
    if is_replica:
        return {"matches": [], "unmapped": [], "paletteMatch": 0, "skipped": True}

    extracted: list[dict[str, str]] = []
    for index, entry in enumerate(palette or []):
        if isinstance(entry, str):
            extracted.append({"hex": entry, "origin": f"{origin_prefix}-{index}"})
            continue
        if not isinstance(entry, dict):
            continue
        hex_value = entry.get("hex") or entry.get("value")
        if not isinstance(hex_value, str):
            continue
        origin = entry.get("origin") or f"{origin_prefix}-{index}"
        extracted.append({"hex": hex_value, "origin": str(origin)})

    if not extracted:
        return {"matches": [], "unmapped": [], "paletteMatch": 1, "skipped": False}

    design_colors = _extract_design_colors(design_tokens)
    if not design_colors:
        return {
            "matches": [],
            "unmapped": [
                {
                    "extractedHex": (_normalize_hex(item["hex"]) or item["hex"]),
                    "origin": item["origin"],
                }
                for item in extracted
            ],
            "paletteMatch": 0,
            "skipped": False,
        }

    matches: list[dict[str, Any]] = []
    unmapped: list[dict[str, Any]] = []
    weighted_match_sum = 0.0
    total_weight = 0.0
    threshold = float(threshold)

    for item in extracted:
        normalized = _normalize_hex(item["hex"])
        if normalized is None:
            unmapped.append({"extractedHex": item["hex"], "origin": item["origin"]})
            total_weight += 1.0
            continue
        try:
            rgb = (
                int(normalized[1:3], 16),
                int(normalized[3:5], 16),
                int(normalized[5:7], 16),
            )
        except ValueError:
            unmapped.append({"extractedHex": item["hex"], "origin": item["origin"]})
            total_weight += 1.0
            continue

        nearest_name: str | None = None
        nearest_hex: str | None = None
        nearest_delta = float("inf")
        for token in design_colors:
            token_rgb = (
                int(token["hex"][1:3], 16),
                int(token["hex"][3:5], 16),
                int(token["hex"][5:7], 16),
            )
            delta = _delta_e76(rgb, token_rgb)
            if delta < nearest_delta:
                nearest_delta = delta
                nearest_name = token["name"]
                nearest_hex = token["hex"]

        weight = 1.0
        total_weight += weight
        if nearest_delta <= threshold:
            confidence = max(0.0, min(1.0, 1.0 - nearest_delta / threshold))
            matches.append(
                {
                    "extractedHex": normalized,
                    "tokenName": nearest_name,
                    "deltaE": round(nearest_delta, 4),
                    "confidence": round(confidence, 4),
                    "origin": item["origin"],
                    "tokenHex": nearest_hex,
                }
            )
            weighted_match_sum += weight * confidence
        else:
            unmapped.append({"extractedHex": normalized, "origin": item["origin"]})

    palette_match = 1.0 if total_weight == 0 else round(weighted_match_sum / total_weight, 4)
    return {
        "matches": matches,
        "unmapped": unmapped,
        "paletteMatch": palette_match,
        "skipped": False,
    }


def _dominant_row_color(row_pixels: list[tuple[int, int, int]], buckets: int = 24) -> tuple[int, int, int]:
    def bucket(value: int) -> int:
        return min(buckets - 1, value * buckets // 256)

    counter: Counter[tuple[int, int, int]] = Counter()
    for r, g, b in row_pixels:
        counter[(bucket(r), bucket(g), bucket(b))] += 1
    br, bg, bb = counter.most_common(1)[0][0]
    return (
        min(255, int((br + 0.5) * 256 / buckets)),
        min(255, int((bg + 0.5) * 256 / buckets)),
        min(255, int((bb + 0.5) * 256 / buckets)),
    )


def detect_layout_bands(image: Any, mapping: dict[str, Any]) -> list[dict[str, Any]]:
    _require_pillow()
    rgb = image.convert("RGB")
    width_px, height_px = rgb.size
    row_colors: list[tuple[int, int, int]] = []
    pixels = rgb.load()
    for y in range(height_px):
        row = [pixels[x, y] for x in range(width_px)]
        row_colors.append(_dominant_row_color(row))

    def color_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> int:
        return sum(abs(a[i] - b[i]) for i in range(3))

    threshold = 36
    bands: list[tuple[int, int, tuple[int, int, int]]] = []
    start = 0
    current = row_colors[0]
    for y in range(1, height_px):
        if color_distance(row_colors[y], current) > threshold:
            bands.append((start, y - 1, current))
            start = y
            current = row_colors[y]
    bands.append((start, height_px - 1, current))

    merged: list[tuple[int, int, tuple[int, int, int]]] = []
    min_band_px = max(12, height_px // 30)
    for start_y, end_y, color in bands:
        if merged and (end_y - start_y + 1) < min_band_px:
            prev_start, prev_end, prev_color = merged[-1]
            merged[-1] = (prev_start, end_y, prev_color)
        else:
            merged.append((start_y, end_y, color))

    labels = ["header", "content", "footer", "section", "section"]
    regions: list[dict[str, Any]] = []
    for index, (start_y, end_y, color) in enumerate(merged[:5]):
        px_box = Box(x=0.0, y=float(start_y), w=float(width_px), h=float(end_y - start_y + 1))
        inch_box = px_to_inch(px_box, mapping)
        label = labels[min(index, len(labels) - 1)]
        regions.append(
            {
                "id": f"band-{index + 1}",
                "label": label,
                "dominantColor": _rgb_to_hex(color),
                "pixelBox": px_box.as_dict(),
                "inchBox": inch_box.as_dict(),
                "suggestedElements": _suggest_elements(label, index),
            }
        )
    return regions


def _suggest_elements(label: str, index: int) -> list[str]:
    if label == "header" or index == 0:
        return ["text:title", "shape:background"]
    if label == "footer":
        return ["text:caption"]
    return ["shape:card", "text:body", "table"]


def ocr_status() -> dict[str, Any]:
    tesseract = shutil.which("tesseract")
    if not tesseract:
        return {
            "status": "deferred",
            "engine": None,
            "note": (
                "Tesseract not found on PATH. Host agent should use vision capabilities to "
                "extract text and coordinates, or install Tesseract for M1.4+ local OCR."
            ),
            "textBlocks": [],
        }
    try:
        result = subprocess.run(
            [tesseract, "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        version_line = (result.stdout or result.stderr).splitlines()[0] if (result.stdout or result.stderr) else ""
    except (OSError, subprocess.TimeoutExpired):
        version_line = ""
    return {
        "status": "available",
        "engine": "tesseract",
        "binary": tesseract,
        "version": version_line,
        "note": (
            "Tesseract is installed but M1.3 does not run OCR automatically. "
            "Host agent may invoke tesseract manually or wait for M1.4 ocr-image.py."
        ),
        "textBlocks": [],
    }


def suggest_design_system(palette: list[dict[str, Any]]) -> dict[str, str]:
    hexes = {entry["hex"].upper() for entry in palette}
    if any(h in hexes for h in ("#2563EB", "#1D4ED8", "#3B82F6")):
        return {"id": "business-neutral", "reason": "dominant blue tones match business-neutral"}
    if any(h in hexes for h in ("#0F172A", "#111827", "#1E293B")):
        return {"id": "dark-tech", "reason": "dark background tones match dark-tech"}
    return {"id": "business-neutral", "reason": "default fallback for generic business slides"}


def _coord(value: float) -> float:
    return round(float(value), 4)


def build_manifest_skeleton(
    image_path: Path,
    mapping: dict[str, Any],
    regions: list[dict[str, Any]],
    design_system: dict[str, str],
    deck_title: str = "Image Replication Draft",
    palette_resolution: dict[str, Any] | None = None,
) -> dict[str, Any]:
    design_id = design_system["id"]
    elements: list[dict[str, Any]] = []
    for region in regions:
        inch = region["inchBox"]
        label = region["label"]
        if label == "header":
            elements.append(
                {
                    "type": "text",
                    "id": "title-placeholder",
                    "text": "<HOST_AGENT: extract title text>",
                    "x": _coord(max(0.7, inch["x"] + 0.05)),
                    "y": _coord(inch["y"] + 0.05),
                    "w": _coord(min(mapping["widthIn"] - 1.4, inch["w"] - 0.1)),
                    "h": _coord(min(0.9, inch["h"] - 0.1)),
                    "style": {"typography": "{typography.title}", "color": "{colors.text}", "align": "left"},
                    "editability": "native-text",
                    "sourceRegion": region["id"],
                }
            )
        elif label in {"content", "section"} and region["id"] == "band-2":
            elements.append(
                {
                    "type": "shape",
                    "id": "card-left-placeholder",
                    "shape": "roundRect",
                    "x": 0.7,
                    "y": _coord(inch["y"] + 0.1),
                    "w": _coord((mapping["widthIn"] - 1.6) / 2),
                    "h": _coord(min(2.2, inch["h"] - 0.2)),
                    "style": {"component": "{components.content-card}"},
                    "editability": "native-shape",
                    "sourceRegion": region["id"],
                }
            )
            elements.append(
                {
                    "type": "text",
                    "id": "card-left-text-placeholder",
                    "text": "<HOST_AGENT: extract card text>",
                    "x": 0.95,
                    "y": _coord(inch["y"] + 0.25),
                    "w": _coord((mapping["widthIn"] - 1.6) / 2 - 0.4),
                    "h": 0.5,
                    "style": {"typography": "{typography.body}", "color": "{colors.text}", "align": "left"},
                    "editability": "native-text",
                    "sourceRegion": region["id"],
                }
            )
    if not elements:
        elements.append(
            {
                "type": "text",
                "id": "title-placeholder",
                "text": "<HOST_AGENT: extract title text>",
                "x": 0.7,
                "y": 0.6,
                "w": 11.8,
                "h": 0.8,
                "style": {"typography": "{typography.title}", "color": "{colors.text}", "align": "left"},
                "editability": "native-text",
            }
        )
    return {
        "version": MANIFEST_VERSION,
        "designSystem": {
            "source": f"../../design-systems/{design_id}/DESIGN.md",
            "name": design_id,
            "mode": "balanced",
        },
        "deck": {
            "title": deck_title,
            "language": "zh-CN",
            "size": {
                "preset": mapping["preset"],
                "width": mapping["widthIn"],
                "height": mapping["heightIn"],
                "unit": mapping["unit"],
            },
        },
        "assets": [
            {
                "id": "source-slide",
                "src": image_path.name,
                "role": "reference",
                "note": "Reference screenshot; remove from final manifest unless needed as cropped asset.",
            }
        ],
        "slides": [
            {
                "id": "slide-001",
                "type": "content",
                "title": deck_title,
                "notes": "Skeleton from image hints — host agent must replace placeholders and add missing objects.",
                "background": {"type": "solid", "color": "{colors.background}"},
                "elements": elements,
            }
        ],
        "_skeleton": True,
        "paletteMatch": (palette_resolution or {}).get("paletteMatch", 0),
        "inlineColors": [
            {
                "slideId": "slide-001",
                "hex": entry.get("extractedHex"),
                "origin": entry.get("origin"),
            }
            for entry in (palette_resolution or {}).get("unmapped", [])
        ],
    }


def build_manifest_hints(
    image_path: Path,
    *,
    preset: str = "wide",
    palette_count: int = 6,
    deck_title: str | None = None,
    design_tokens: dict[str, Any] | None = None,
    mode: str = "balanced",
) -> dict[str, Any]:
    image_path = image_path.resolve()
    img = load_image(image_path)
    meta = image_metadata(image_path, img, relative_to=image_path.parent)
    mapping = slide_mapping(preset, meta)
    palette = extract_palette(img, palette_count)
    regions = detect_layout_bands(img, mapping)
    design = suggest_design_system(palette)
    title = deck_title or image_path.stem.replace("-", " ").title()
    palette_resolution = resolve_palette_to_tokens(
        palette,
        design_tokens,
        is_replica=(mode == "replica"),
        origin_prefix=f"{image_path.stem}-palette",
    )
    skeleton = build_manifest_skeleton(
        image_path,
        mapping,
        regions,
        design,
        title,
        palette_resolution=palette_resolution,
    )
    return {
        "version": HINTS_VERSION,
        "sourceImage": image_path.name,
        "image": meta,
        "slideMapping": mapping,
        "palette": palette,
        "paletteResolution": palette_resolution,
        "layoutHints": {
            "regions": regions,
            "coordinateRule": "inch = pixel / pxPerIn; origin top-left; slide size from slideMapping",
        },
        "ocr": ocr_status(),
        "designSystemSuggestion": design,
        "manifestSkeleton": skeleton,
        "hostAgentTasks": [
            "Inventory visible objects (text, cards, tables, lines, icons, photos).",
            "Replace manifestSkeleton placeholder text with extracted content.",
            "Assign editability class per object (native-text, native-shape, cropped-image).",
            "Refine inch coordinates using layoutHints.regions as starting points.",
            "Remove reference asset from manifest unless a region is rasterized.",
            "Validate with python scripts/validate-manifest.py and render.",
        ],
    }


def _candidate(
    *,
    candidate_id: str,
    candidate_type: str,
    region: dict[str, Any],
    editable_as: str,
    confidence: float,
    reason: str,
) -> dict[str, Any]:
    return {
        "id": candidate_id,
        "type": candidate_type,
        "sourceRegion": region["id"],
        "pixelBox": region["pixelBox"],
        "inchBox": region["inchBox"],
        "editableAs": editable_as,
        "confidence": round(confidence, 3),
        "reason": reason,
    }


def build_object_candidates(regions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Create deterministic first-pass editable object candidates from layout bands."""
    candidates: list[dict[str, Any]] = []
    for region in regions:
        label = region["label"]
        candidates.append(
            _candidate(
                candidate_id=f"{region['id']}-background",
                candidate_type="background-band",
                region=region,
                editable_as="native-shape",
                confidence=0.72,
                reason="Detected as a dominant-color horizontal band; rebuild as a native filled shape.",
            )
        )
        if label == "header":
            candidates.append(
                _candidate(
                    candidate_id=f"{region['id']}-title-text",
                    candidate_type="title-text",
                    region=region,
                    editable_as="native-text",
                    confidence=0.58,
                    reason="Header band usually contains title text; confirm with OCR or vision review.",
                )
            )
        elif label in {"content", "section"}:
            candidates.append(
                _candidate(
                    candidate_id=f"{region['id']}-content-group",
                    candidate_type="content-group",
                    region=region,
                    editable_as="native-shape",
                    confidence=0.52,
                    reason="Content band may contain cards, tables, diagrams, or body text; split in the next pass.",
                )
            )
    return candidates


def build_replica_analysis(
    image_path: Path,
    *,
    preset: str = "wide",
    palette_count: int = 8,
    deck_title: str | None = None,
    design_tokens: dict[str, Any] | None = None,
    mode: str = "balanced",
) -> dict[str, Any]:
    image_path = image_path.resolve()
    img = load_image(image_path)
    meta = image_metadata(image_path, img, relative_to=image_path.parent)
    mapping = slide_mapping(preset, meta)
    palette = extract_palette(img, palette_count)
    regions = detect_layout_bands(img, mapping)
    palette_resolution = resolve_palette_to_tokens(
        palette,
        design_tokens,
        is_replica=(mode == "replica"),
        origin_prefix=f"{image_path.stem}-palette",
    )
    # In strict replica mode the resolver is bypassed — surface that
    # explicitly by emitting no `paletteMatches` rows (the consistency
    # report will record paletteMatch: 0 without contributing a per-slide
    # entry that would otherwise skew the batch average).
    palette_matches = (
        []
        if palette_resolution["skipped"]
        else [{"slideId": "image", "score": palette_resolution["paletteMatch"]}]
    )
    return {
        "version": REPLICA_VERSION,
        "kind": "image-replica-analysis",
        "sourceImage": image_path.name,
        "deckTitle": deck_title or image_path.stem.replace("-", " ").title(),
        "image": meta,
        "slideMapping": mapping,
        "palette": palette,
        "paletteResolution": palette_resolution,
        "paletteMatch": palette_resolution["paletteMatch"],
        "paletteMatches": palette_matches,
        "paletteUnmapped": palette_resolution["unmapped"],
        "regions": regions,
        "objectCandidates": build_object_candidates(regions),
        "detectors": {
            "imageMetadata": {"status": "ok", "engine": "pillow"},
            "colorPalette": {"status": "ok", "engine": "pillow-mediancut", "count": len(palette)},
            "layoutBands": {"status": "ok", "engine": "dominant-row-color", "count": len(regions)},
            "ocr": ocr_status(),
            "geometryPrimitives": {
                "status": "planned",
                "engine": "opencv-or-vision-provider",
                "targets": ["rect", "roundRect", "line", "arrow", "ellipse", "table-grid"],
            },
        },
        "qualityTargets": {
            "textBoxMaxOffsetPx": 4,
            "shapeMaxOffsetPx": 6,
            "colorDeltaEMax": 3,
            "minStructuralCoverage": 0.9,
            "minVisualSimilarity": 0.96,
        },
        "nextPasses": [
            "Run OCR or a vision model to replace text candidates with exact text blocks.",
            "Detect primitive geometry for cards, dividers, arrows, and diagram connectors.",
            "Render PPTX preview and compare against source image before final delivery.",
        ],
    }


# Default OCR confidence threshold for editable-text gating (U5).
# Tuned during U10 Calibration; 0.7 is the conservative baseline.
DEFAULT_OCR_CONFIDENCE_THRESHOLD = 0.7


def _match_ocr_to_candidate(
    ocr_block: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return the candidate whose inchBox contains the OCR pixel box center.

    Falls back to the candidate whose inchBox center is closest to the OCR
    center when no candidate fully contains it (handles OCR drift)."""
    ocr_pixel = ocr_block.get("pixelBox") or {}
    try:
        cx = float(ocr_pixel.get("x", 0)) + float(ocr_pixel.get("w", 0)) / 2.0
        cy = float(ocr_pixel.get("y", 0)) + float(ocr_pixel.get("h", 0)) / 2.0
    except (TypeError, ValueError):
        return None
    px_per_in_x = (ocr_block.get("_pxPerInX") or 1.0) or 1.0
    px_per_in_y = (ocr_block.get("_pxPerInY") or 1.0) or 1.0
    cx_in = cx / px_per_in_x
    cy_in = cy / px_per_in_y
    containing: dict[str, Any] | None = None
    best_distance = float("inf")
    best_candidate: dict[str, Any] | None = None
    for cand in candidates:
        box = cand.get("inchBox") or {}
        try:
            x = float(box.get("x", 0))
            y = float(box.get("y", 0))
            w = float(box.get("w", 0))
            h = float(box.get("h", 0))
        except (TypeError, ValueError):
            continue
        if x <= cx_in <= x + w and y <= cy_in <= y + h:
            containing = cand
            break
        cand_cx = x + w / 2.0
        cand_cy = y + h / 2.0
        distance = (cand_cx - cx_in) ** 2 + (cand_cy - cy_in) ** 2
        if distance < best_distance:
            best_distance = distance
            best_candidate = cand
    return containing or best_candidate


def _decide_kind(
    confidence_01: float | None,
    threshold: float,
) -> str:
    """Assign per-element kind based on normalized OCR confidence vs threshold.

    confidence_01 == None means OCR did not provide a usable value for this
    block. In that case we are conservative and fall back to cropped-asset so
    downstream renderers do not silently treat unknown text as editable.
    """
    if confidence_01 is None:
        return "cropped-asset"
    if confidence_01 >= threshold:
        return "editable-text"
    return "cropped-asset"


def build_replica_layer_plan(
    analysis: dict[str, Any],
    ocr_blocks: list[dict[str, Any]] | None = None,
    *,
    threshold: float = DEFAULT_OCR_CONFIDENCE_THRESHOLD,
) -> dict[str, Any]:
    """Build the per-layer plan from a replica analysis, optionally gated by OCR.

    When ``ocr_blocks`` is None or empty (the conservative default — e.g.
    Tesseract missing and ``ocr_image`` returned ``status: "deferred"``) all
    text-region objects are emitted with ``kind: "cropped-asset"`` so they are
    not silently treated as editable. The behavior is documented here so
    downstream tooling can rely on it.

    ``ocr_blocks`` entries must already be normalized to a 0-1 confidence
    scale (see ``image-replica-plan.py``); this function does not rescale.
    """
    if analysis.get("kind") != "image-replica-analysis":
        _fail("expected image-replica-analysis input")
    candidates = analysis.get("objectCandidates", [])
    native_text = [item["id"] for item in candidates if item.get("editableAs") == "native-text"]
    native_shapes = [item["id"] for item in candidates if item.get("editableAs") == "native-shape"]

    # Build per-candidate decisions when OCR data is provided. We attach the
    # ``kind`` field at the candidate level (rather than the layer level) so
    # downstream consumers — e.g. U6's cropped-asset promotion — can read a
    # single source of truth for what each object should become.
    #
    # ocr_conservative_default applies whenever OCR is unavailable — either
    # the caller passed None explicitly (deferred from ocr_image) or the list
    # is empty. In both cases every text-region candidate falls back to
    # ``cropped-asset`` so we never silently treat unknown text as editable.
    decisions: list[dict[str, Any]] = []
    candidate_kind_overrides: dict[str, str] = {}
    ocr_conservative_default = not ocr_blocks

    if not ocr_conservative_default:
        mapping = analysis.get("slideMapping") or {}
        try:
            px_per_in_x = float(mapping.get("pxPerInX") or 0.0) or 0.0
        except (TypeError, ValueError):
            px_per_in_x = 0.0
        try:
            px_per_in_y = float(mapping.get("pxPerInY") or 0.0) or 0.0
        except (TypeError, ValueError):
            px_per_in_y = 0.0
        # Restrict OCR matching to candidates that expect text content.
        # Background / shape candidates have the same boxes but should not
        # receive an editable-text kind from OCR alone.
        text_candidates = [c for c in candidates if c.get("editableAs") == "native-text"]
        for block in ocr_blocks or []:
            enriched = dict(block)
            if px_per_in_x:
                enriched["_pxPerInX"] = px_per_in_x
            if px_per_in_y:
                enriched["_pxPerInY"] = px_per_in_y
            confidence_raw = enriched.get("confidence01")
            if confidence_raw is None and "confidence" in enriched:
                confidence_raw = enriched.get("confidence")
            try:
                confidence_01 = float(confidence_raw) if confidence_raw is not None else None
            except (TypeError, ValueError):
                confidence_01 = None
            matched = _match_ocr_to_candidate(enriched, text_candidates)
            kind = _decide_kind(confidence_01, threshold)
            decisions.append(
                {
                    "ocrText": enriched.get("text", ""),
                    "candidateId": matched["id"] if matched else None,
                    "kind": kind,
                    "confidence01": round(confidence_01, 4) if confidence_01 is not None else None,
                    "threshold": round(float(threshold), 4),
                    "passes": (
                        confidence_01 is not None and confidence_01 >= float(threshold)
                    ),
                }
            )
            if matched is not None:
                # First OCR match wins for a given candidate; later matches are
                # still recorded as decisions but do not overwrite the kind.
                candidate_kind_overrides.setdefault(matched["id"], kind)

    # Annotate candidates with their per-element ``kind`` for downstream use.
    # When OCR is in conservative-default mode (deferred or missing) every
    # text-region candidate is explicitly tagged ``cropped-asset`` so the
    # downstream renderer does not silently mark unknown text as editable.
    annotated_candidates: list[dict[str, Any]] = []
    for cand in candidates:
        new_cand = dict(cand)
        if candidate_kind_overrides and cand["id"] in candidate_kind_overrides:
            new_cand["kind"] = candidate_kind_overrides[cand["id"]]
        elif ocr_conservative_default and cand.get("editableAs") == "native-text":
            new_cand["kind"] = "cropped-asset"
        elif not ocr_conservative_default and cand.get("editableAs") == "native-text":
            # OCR was provided but no OCR block matched this candidate — be
            # conservative and treat unmatched text regions as cropped.
            new_cand["kind"] = "cropped-asset"
        annotated_candidates.append(new_cand)

    plan: dict[str, Any] = {
        "version": REPLICA_VERSION,
        "kind": "replica-layer-plan",
        "sourceImage": analysis["sourceImage"],
        "deckTitle": analysis.get("deckTitle", "Image Replica"),
        "slideMapping": analysis["slideMapping"],
        "editabilityTarget": {
            "level": 4,
            "summary": "Native text and common geometric shapes should be editable; complex photos and textured regions may remain cropped images.",
        },
        "layers": [
            {
                "id": "source-reference",
                "role": "visual-reference",
                "visibility": "hidden-or-removed-before-final",
                "objects": [analysis["sourceImage"]],
                "policy": "Use for alignment, diffing, and emergency crop fallback; do not deliver as the only visible layer.",
            },
            {
                "id": "background-repair",
                "role": "clean-background",
                "visibility": "visible",
                "objects": native_shapes,
                "policy": "Rebuild flat bands and simple panels as native shapes; use cropped/inpainted assets for complex texture only.",
            },
            {
                "id": "editable-shapes",
                "role": "native-geometry",
                "visibility": "visible",
                "objects": native_shapes,
                "policy": "Map rectangles, rounded rectangles, lines, arrows, and table grids to native PPTX elements.",
            },
            {
                "id": "editable-text",
                "role": "native-text",
                "visibility": "visible",
                "objects": native_text,
                "policy": "OCR-confirmed text must be rebuilt as PowerPoint text boxes with inferred font, color, and alignment.",
            },
            {
                "id": "cropped-assets",
                "role": "raster-fallback",
                "visibility": "visible-when-needed",
                "objects": [],
                "policy": "Use only for photos, logos, dense icons, decorations, or unsupported effects; report every rasterized region.",
            },
        ],
        "repairLoop": {
            "maxIterations": 3,
            "compare": ["pixel-diff", "text-bbox-offset", "color-delta", "element-coverage"],
            "patchTargets": ["x", "y", "w", "h", "fontSize", "color", "zOrder", "arrowhead", "crop"],
        },
        "handoff": {
            "manifestInput": "Use objectCandidates as the source for deck.manifest.json elements.",
            "reviewOutput": "Write replica-visual-report.json after rendering and comparison.",
        },
    }

    # Surface per-block decisions and candidate annotations so callers can
    # audit why a given block landed in editable-text vs cropped-asset.
    plan["decisions"] = decisions
    plan["threshold"] = round(float(threshold), 4)
    plan["objectCandidates"] = annotated_candidates

    # U9: surface the palette->token resolution carried by the upstream
    # analysis. Callers (image-replica-plan.py, downstream reports) can
    # read a single source of truth for `paletteMatch`, the per-color
    # matches, and any unmapped colors that should appear in the
    # consistency report's inlineColor entries (U2/U3).
    palette_resolution = analysis.get("paletteResolution")
    if palette_resolution is None and "paletteMatch" in analysis:
        # Back-compat: rebuild a minimal resolution shape if only the
        # numeric score was carried over from a prior call.
        palette_resolution = {
            "matches": [],
            "unmapped": [],
            "paletteMatch": analysis.get("paletteMatch", 0),
            "skipped": False,
        }
    if palette_resolution is not None:
        plan["paletteResolution"] = palette_resolution
        plan["paletteMatch"] = palette_resolution.get("paletteMatch", 0)
        plan["paletteMatches"] = palette_resolution.get("matches", [])
        plan["paletteUnmapped"] = palette_resolution.get("unmapped", [])

    return plan


def inspect_image(path: Path, *, palette_count: int = 6) -> dict[str, Any]:
    image_path = path.resolve()
    img = load_image(image_path)
    meta = image_metadata(image_path, img, relative_to=image_path.parent)
    return {
        "version": HINTS_VERSION,
        "image": meta,
        "palette": extract_palette(img, palette_count),
        "ocr": ocr_status(),
    }


def write_json(data: dict[str, Any], output_path: Path | None = None) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text + "\n", encoding="utf-8")
    return text
