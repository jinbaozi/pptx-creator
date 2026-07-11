"""Deterministic image inspection helpers for host-agent manifest authoring."""

from __future__ import annotations

import json
import hashlib
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

def _box_payload(box: "Box", mapping: dict[str, Any]) -> dict[str, Any]:
    return {"pixelBox": box.as_dict(), "inchBox": px_to_inch(box, mapping).as_dict()}

def detect_replica_objects(img: Any, mapping: dict[str, Any], image_path: Path) -> dict[str, Any]:
    """Detect reproducible native primitives and complex residuals from pixels."""
    rgb = img.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    seen = bytearray(width * height)
    components: list[dict[str, Any]] = []
    # Exact-color components recover flat fills/borders without pretending that
    # text glyphs or photographs are editable geometry.
    for y in range(height):
        for x in range(width):
            start=y*width+x
            if seen[start]: continue
            color = pixels[x, y]
            stack = [start]; seen[start]=1; count=0; min_x=max_x=x; min_y=max_y=y
            while stack:
                index=stack.pop(); px=index%width; py=index//width; count+=1
                min_x=min(min_x,px);max_x=max(max_x,px);min_y=min(min_y,py);max_y=max(max_y,py)
                for nx, ny in ((px-1,py),(px+1,py),(px,py-1),(px,py+1)):
                    neighbor=ny*width+nx
                    if 0 <= nx < width and 0 <= ny < height and not seen[neighbor] and pixels[nx,ny] == color:
                        seen[neighbor]=1; stack.append(neighbor)
            if count < 120: continue
            box = Box(min_x, min_y, max_x-min_x+1, max_y-min_y+1)
            fill = count/(box.w*box.h)
            if box.w >= 8 and box.h >= 2:
                components.append({"id": f"cc-{len(components)+1}", **_box_payload(box,mapping), "color": "#%02X%02X%02X"%color, "pixelCount": count, "fillRatio": round(fill,4)})
    rectangles, lines = [], []
    for comp in components:
        b = comp["pixelBox"]
        if (b["w"] >= width*.25 and b["h"] <= 5) or (b["h"] >= height*.25 and b["w"] <= 5):
            lines.append({**comp, "id": f"line-{len(lines)+1}"})
        elif (b["w"] >= width*.12 and b["h"] >= height*.04 and comp["fillRatio"] >= .92) or (b["w"] <= 12 and b["h"] >= height*.15 and comp["fillRatio"] >= .9):
            rectangles.append({**comp, "id": f"rect-{len(rectangles)+1}", "shape": "rect", "fill": True})
        elif b["w"] >= width*.12 and b["h"] >= height*.04 and .005 <= comp["fillRatio"] <= .2:
            perimeter=max(1,2*(b["w"]+b["h"])); thickness=max(1,round(comp["pixelCount"]/perimeter))
            rectangles.append({**comp, "id": f"rect-{len(rectangles)+1}", "shape": "rect", "fill": False, "borderWidthPx": thickness})
    # High-color-density tiles become bounded local raster fallbacks.
    hot = []
    for top in range(0, height, 32):
        for left in range(0, width, 32):
            crop = rgb.crop((left, top, min(left+32,width), min(top+32,height)))
            if len(crop.getcolors(maxcolors=1025) or []) > 180: hot.append((left,top,min(left+32,width),min(top+32,height)))
    residuals = []
    if hot:
        box = Box(min(x[0] for x in hot), min(x[1] for x in hot), max(x[2] for x in hot)-min(x[0] for x in hot), max(x[3] for x in hot)-min(x[1] for x in hot))
        residuals.append({"id":"residual-1", **_box_payload(box,mapping), "reason":"high-local-color-complexity", "kind":"local-crop"})
    try:
        from ocr_core import ocr_image
        payload = ocr_image(image_path, langs="eng", min_confidence=0)
    except (ValueError, OSError):
        payload = {"status":"deferred", "textBlocks":[]}
    ocr_blocks = []
    for i, raw in enumerate(payload.get("textBlocks", [])):
        b = raw["pixelBox"]; box = Box(float(b["x"]),float(b["y"]),float(b["w"]),float(b["h"]))
        confidence = max(0.0,min(1.0,float(raw.get("confidence",0))/100))
        crop=rgb.crop((int(box.x),int(box.y),int(box.x+box.w),int(box.y+box.h)))
        colors=sorted(crop.getcolors(maxcolors=max(1,int(box.w*box.h))) or [],reverse=True)
        background=colors[0][1] if colors else (255,255,255)
        candidates=[(count,color) for count,color in colors[1:] if sum(abs(color[channel]-background[channel]) for channel in range(3))>=90]
        foreground=max(candidates,key=lambda item:item[0])[1] if candidates else (16,42,67)
        render_box=Box(max(0,box.x-1),max(0,box.y-box.h*.25),min(width-max(0,box.x-1),box.w+4),min(height-max(0,box.y-box.h*.25),box.h*1.5))
        payload_box=_box_payload(box,mapping); payload_box["inchBox"]=px_to_inch(render_box,mapping).as_dict()
        ocr_blocks.append({"id":f"text-{i+1}","text":raw["text"],"confidence":round(confidence,4),**payload_box,"styleHints":{"fontFamily":"Arial","fontSize":round(max(8,box.h*1.05),2),"color":"#%02X%02X%02X"%foreground,"bold":raw["text"].isupper() and box.h>=18}})
    return {"ocrBlocks":ocr_blocks,"rectangles":rectangles,"lines":lines,"bands":detect_layout_bands(img,mapping),"connectedComponents":components,"residualRegions":residuals,"ocrStatus":payload.get("status","deferred")}


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
MANIFEST_VERSION = "0.2.0"


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
    if path.stat().st_size > 50 * 1024 * 1024:
        _fail("image exceeds replica safety limit (50MB encoded)")
    with Image.open(path) as img:
        width,height=img.size
        if width > 8192 or height > 8192 or width*height > 4_000_000:
            _fail("image exceeds replica safety limit (8192px per side, 4MP decoded)")
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
    mode: str = "creative",
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
        "metadata": {
            "mode": "replica" if mode == "replica" else "creative",
            "inputType": "image",
            "qualityProfile": "replica" if mode == "replica" else "creative",
            **({"replicaSource": {"type": "image", "path": image_path.name}} if mode == "replica" else {}),
            "generator": {"name": "image_inspect_core.py", "skeleton": True},
        },
        "designSystem": {
            "source": f"../../design-systems/{design_id}/DESIGN.md",
            "name": design_id,
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
    if meta["widthPx"] > 8192 or meta["heightPx"] > 8192 or meta["widthPx"] * meta["heightPx"] > 4_000_000:
        _fail("image exceeds replica safety limit (8192px per side, 4MP decoded)")
    source_bytes = image_path.read_bytes()
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
        mode=mode,
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
    if meta["widthPx"] > 8192 or meta["heightPx"] > 8192 or meta["widthPx"] * meta["heightPx"] > 4_000_000:
        _fail("image exceeds replica safety limit (8192px per side, 4MP decoded)")
    source_bytes = image_path.read_bytes()
    mapping = slide_mapping(preset, meta)
    palette = extract_palette(img, palette_count)
    regions = detect_layout_bands(img, mapping)
    detected = detect_replica_objects(img, mapping, image_path)
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
        "sourcePath": str(image_path),
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "sourceBytes": len(source_bytes),
        "deckTitle": deck_title or image_path.stem.replace("-", " ").title(),
        "image": meta,
        "slideMapping": mapping,
        "palette": palette,
        "paletteResolution": palette_resolution,
        "paletteMatch": palette_resolution["paletteMatch"],
        "paletteMatches": palette_matches,
        "paletteUnmapped": palette_resolution["unmapped"],
        "regions": regions,
        **{key: detected[key] for key in ("ocrBlocks", "rectangles", "lines", "bands", "connectedComponents", "residualRegions")},
        "detectors": {
            "imageMetadata": {"status": "ok", "engine": "pillow"},
            "colorPalette": {"status": "ok", "engine": "pillow-mediancut", "count": len(palette)},
            "layoutBands": {"status": "ok", "engine": "dominant-row-color", "count": len(regions)},
            "ocr": {"status": detected["ocrStatus"], "engine": "tesseract", "count": len(detected["ocrBlocks"])},
            "geometryPrimitives": {
                "status": "ok",
                "engine": "pillow-connected-components",
                "counts": {"rectangles": len(detected["rectangles"]), "lines": len(detected["lines"]), "components": len(detected["connectedComponents"]), "residuals": len(detected["residualRegions"])},
            },
        },
        "qualityTargets": {
            "textBoxMaxOffsetPx": 4,
            "shapeMaxOffsetPx": 6,
            "colorDeltaEMax": 3,
            "minStructuralCoverage": 0.9,
            "minVisualSimilarity": 0.96,
        },
    }


# Default OCR confidence threshold for editable-text gating (U5).
# Tuned during U10 Calibration; 0.7 is the conservative baseline.
DEFAULT_OCR_CONFIDENCE_THRESHOLD = 0.7


def build_replica_layer_plan(
    analysis: dict[str, Any],
    ocr_blocks: list[dict[str, Any]] | None = None,
    *,
    threshold: float = DEFAULT_OCR_CONFIDENCE_THRESHOLD,
) -> dict[str, Any]:
    """Build a measured native/crop layer plan from detector output.

    The analysis already owns OCR facts. ``ocr_blocks`` remains accepted only
    for CLI compatibility and is intentionally not a second source of truth.
    """
    if analysis.get("kind") != "image-replica-analysis":
        _fail("expected image-replica-analysis input")
    if any(key in analysis for key in ("ocrBlocks", "rectangles", "residualRegions")):
        objects: list[dict[str, Any]] = []
        z = 0
        for item in analysis.get("rectangles", []):
            objects.append({"id": item["id"], "kind": "native-shape", "shape": item.get("shape", "rect"), "pixelBox": item["pixelBox"], "inchBox": item["inchBox"], "color": item["color"], "fill": item.get("fill", True), "borderWidthPx": item.get("borderWidthPx", 0), "confidence": item.get("fillRatio", 1), "zOrder": z}); z += 1
        for item in analysis.get("lines", []):
            objects.append({"id": item["id"], "kind": "native-line", "pixelBox": item["pixelBox"], "inchBox": item["inchBox"], "color": item["color"], "confidence": item.get("fillRatio", 1), "zOrder": z}); z += 1
        words=sorted(analysis.get("ocrBlocks", []),key=lambda item:(item["pixelBox"]["y"]+item["pixelBox"]["h"]/2,item["pixelBox"]["x"]))
        lines: list[list[dict[str,Any]]] = []
        for word in words:
            center=word["pixelBox"]["y"]+word["pixelBox"]["h"]/2
            def belongs(line: list[dict[str,Any]]) -> bool:
                average=sum(item["pixelBox"]["y"]+item["pixelBox"]["h"]/2 for item in line)/len(line)
                return abs(center-average) <= max(word["pixelBox"]["h"],max(item["pixelBox"]["h"] for item in line))*.65
            match=next((line for line in lines if belongs(line)),None)
            if match is None: lines.append([word])
            else: match.append(word)
        split_lines: list[list[dict[str,Any]]] = []
        for line in lines:
            current: list[dict[str,Any]] = []
            for word in sorted(line,key=lambda item:item["pixelBox"]["x"]):
                if current:
                    previous=current[-1]["pixelBox"]
                    gap=word["pixelBox"]["x"]-(previous["x"]+previous["w"])
                    if gap > max(80,word["pixelBox"]["h"]*5):
                        split_lines.append(current); current=[]
                current.append(word)
            if current: split_lines.append(current)
        lines=split_lines
        merged=[]
        for index,line in enumerate(lines):
            line=sorted(line,key=lambda item:item["pixelBox"]["x"]); boxes=[item["pixelBox"] for item in line]
            x=min(box["x"] for box in boxes); y=min(box["y"] for box in boxes); right=max(box["x"]+box["w"] for box in boxes); bottom=max(box["y"]+box["h"] for box in boxes)
            pixel=Box(x,y,right-x,bottom-y); render=Box(max(0,x-2),max(0,y-pixel.h*.31),min(analysis["image"]["widthPx"]-max(0,x-2),(right-x)*1.08+4),min(analysis["image"]["heightPx"]-max(0,y-pixel.h*.31),pixel.h*1.5))
            styles=[item["styleHints"] for item in line]; ordered_sizes=sorted(float(item.get("fontSize",8)) for item in styles); style=styles[0].copy(); style["fontSize"]=ordered_sizes[len(ordered_sizes)//2]
            style["fontSize"]=round(style["fontSize"]*.985,2)
            colors=[item.get("color") for item in styles if item.get("color")]; style["color"]=max(set(colors),key=colors.count) if colors else "#102A43"; style["bold"]=sum(bool(item.get("bold")) for item in styles)>=len(styles)/2
            merged.append({"id":f"text-line-{index+1}","text":" ".join(item["text"] for item in line),"confidence":min(float(item.get("confidence",0)) for item in line),"pixelBox":pixel.as_dict(),"inchBox":px_to_inch(render,analysis["slideMapping"]).as_dict(),"styleHints":style})
        for item in merged:
            confidence = float(item.get("confidence", 0))
            objects.append({**item, "kind": "editable-text" if confidence >= threshold else "cropped-asset", "zOrder": z}); z += 1
        for item in analysis.get("residualRegions", []):
            objects.append({**item, "kind": "cropped-asset", "zOrder": z}); z += 1
        component_keys={(json.dumps(item["pixelBox"],sort_keys=True),item.get("color")) for item in [*analysis.get("rectangles",[]),*analysis.get("lines",[])]}
        source_inventory=[{"id":item["id"],"disposition":item["kind"],"reason":"compiled replica object"} for item in objects]
        source_inventory.extend({"id":item["id"],"disposition":"ignored","reason":"component is subordinate text antialiasing or below native geometry confidence"} for item in analysis.get("connectedComponents",[]) if (json.dumps(item["pixelBox"],sort_keys=True),item.get("color")) not in component_keys)
        return {
            "version": REPLICA_VERSION, "kind": "replica-layer-plan", "sourceImage": analysis["sourceImage"],
            "sourcePath": analysis.get("sourcePath"), "sourceSha256": analysis.get("sourceSha256"), "sourceBytes": analysis.get("sourceBytes"), "deckTitle": analysis.get("deckTitle", "Image Replica"),
            "slideMapping": analysis["slideMapping"], "threshold": round(float(threshold), 4),
            "objects": objects, "sourceInventory": source_inventory,
            "paletteResolution": analysis.get("paletteResolution"), "paletteMatch": analysis.get("paletteMatch",0),
            "layers": [
                {"id":"editable-shapes","objects":[o["id"] for o in objects if o["kind"] in {"native-shape","native-line"}]},
                {"id":"editable-text","objects":[o["id"] for o in objects if o["kind"] == "editable-text"]},
                {"id":"cropped-assets","objects":[o["id"] for o in objects if o["kind"] == "cropped-asset"]},
            ],
            "editabilityTarget": {"level": 3, "summary":"High-confidence OCR and simple geometry are native; only bounded complex regions are rasterized."},
            "repairLoop": {"maxIterations": 3, "stopOnNoImprovement": True, "metrics": ["ssim", "ocrCer", "bboxIou", "paletteDeltaE2000P95"]},
            "detectorReceipt": {"analysisKind": analysis["kind"], "geometryStatus": analysis.get("detectors",{}).get("geometryPrimitives",{}).get("status"), "sourcePath": analysis.get("sourcePath")},
        }
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
