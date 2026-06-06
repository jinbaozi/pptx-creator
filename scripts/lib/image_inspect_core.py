"""Deterministic image inspection helpers for host-agent manifest authoring."""

from __future__ import annotations

import json
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

SLIDE_PRESETS: dict[str, dict[str, float | str]] = {
    "wide": {"width": 13.333, "height": 7.5, "unit": "in"},
}

HINTS_VERSION = "0.1.0"
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
    }


def build_manifest_hints(
    image_path: Path,
    *,
    preset: str = "wide",
    palette_count: int = 6,
    deck_title: str | None = None,
) -> dict[str, Any]:
    image_path = image_path.resolve()
    img = load_image(image_path)
    meta = image_metadata(image_path, img, relative_to=image_path.parent)
    mapping = slide_mapping(preset, meta)
    palette = extract_palette(img, palette_count)
    regions = detect_layout_bands(img, mapping)
    design = suggest_design_system(palette)
    title = deck_title or image_path.stem.replace("-", " ").title()
    skeleton = build_manifest_skeleton(image_path, mapping, regions, design, title)
    return {
        "version": HINTS_VERSION,
        "sourceImage": image_path.name,
        "image": meta,
        "slideMapping": mapping,
        "palette": palette,
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
