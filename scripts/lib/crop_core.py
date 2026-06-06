"""Deterministic image crop helpers for manifest asset preparation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[misc, assignment]

from image_inspect_core import Box, load_image, px_to_inch, slide_mapping, image_metadata  # noqa: E402

CROP_VERSION = "0.1.0"


def _fail(message: str) -> None:
    raise ValueError(message)


def _clamp_box(box: Box, width: int, height: int) -> Box:
    x = max(0, min(box.x, width - 1))
    y = max(0, min(box.y, height - 1))
    w = max(1, min(box.w, width - x))
    h = max(1, min(box.h, height - y))
    return Box(x=x, y=y, w=w, h=h)


def resolve_pixel_box(crop: dict[str, Any], image_width: int, image_height: int, mapping: dict[str, Any] | None) -> Box:
    unit = crop.get("unit", "px")
    x = float(crop["x"])
    y = float(crop["y"])
    w = float(crop["w"])
    h = float(crop["h"])
    if unit == "in":
        if not mapping:
            _fail("inch crop boxes require slideMapping with pxPerIn values")
        px_per_in_x = mapping["pxPerInX"] or 1.0
        px_per_in_y = mapping["pxPerInY"] or 1.0
        x, y, w, h = x * px_per_in_x, y * px_per_in_y, w * px_per_in_x, h * px_per_in_y
    return _clamp_box(Box(x=x, y=y, w=w, h=h), image_width, image_height)


def crop_assets(
    image_path: Path,
    crops: list[dict[str, Any]],
    output_dir: Path,
    *,
    preset: str = "wide",
) -> dict[str, Any]:
    if Image is None:
        _fail("Pillow is required. Install with: pip install -r requirements.txt")

    image_path = image_path.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    img = load_image(image_path)
    width, height = img.size
    meta = image_metadata(image_path, img)
    mapping = slide_mapping(preset, meta)

    assets: list[dict[str, Any]] = []
    for index, crop in enumerate(crops):
        crop_id = crop.get("id") or f"crop-{index + 1}"
        pixel_box = resolve_pixel_box(crop, width, height, mapping)
        inch_box = px_to_inch(pixel_box, mapping)
        left = int(pixel_box.x)
        top = int(pixel_box.y)
        right = int(pixel_box.x + pixel_box.w)
        bottom = int(pixel_box.y + pixel_box.h)
        region = img.crop((left, top, right, bottom))
        filename = crop.get("filename") or f"{crop_id}.png"
        if not filename.lower().endswith(".png"):
            filename = f"{filename}.png"
        out_path = output_dir / filename
        region.save(out_path, format="PNG")

        assets.append(
            {
                "id": crop_id,
                "src": str(Path("assets") / filename) if crop.get("relative", True) else str(out_path.name),
                "role": crop.get("role", "cropped-image"),
                "pixelBox": pixel_box.as_dict(),
                "inchBox": inch_box.as_dict(),
                "outputPath": str(out_path),
            }
        )

    manifest = {
        "version": CROP_VERSION,
        "source": image_path.name,
        "outputDir": str(output_dir),
        "assets": assets,
        "assetCount": len(assets),
    }
    return manifest


def load_crops_file(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("crops"), list):
        return data["crops"]
    _fail("crops file must be a JSON array or {\"crops\": [...]}")


def write_json(data: dict[str, Any], output_path: Path | None = None) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text + "\n", encoding="utf-8")
    return text
