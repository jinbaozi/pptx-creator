"""Real pixel metrics for replica evidence (Pillow-only, deterministic)."""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat


def _windowed_ssim(a: Image.Image, b: Image.Image) -> float:
    """Mean local-window SSIM; avoids the misleading whole-image covariance shortcut."""
    x = a.convert("L")
    y = b.convert("L")
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    scores: list[float] = []
    window = 8
    for top in range(0, x.height, window):
        for left in range(0, x.width, window):
            box = (left, top, min(left + window, x.width), min(top + window, x.height))
            xb = x.crop(box)
            yb = y.crop(box)
            xp = list(xb.get_flattened_data() if hasattr(xb, "get_flattened_data") else xb.getdata())
            yp = list(yb.get_flattened_data() if hasattr(yb, "get_flattened_data") else yb.getdata())
            count = len(xp)
            mx, my = sum(xp) / count, sum(yp) / count
            vx = sum((value - mx) ** 2 for value in xp) / count
            vy = sum((value - my) ** 2 for value in yp) / count
            cov = sum((left_value - mx) * (right_value - my) for left_value, right_value in zip(xp, yp)) / count
            denominator = (mx * mx + my * my + c1) * (vx + vy + c2)
            scores.append(1.0 if denominator == 0 else ((2 * mx * my + c1) * (2 * cov + c2)) / denominator)
    return sum(scores) / len(scores)


def compare_replica_images(source_path: Path, render_path: Path, normalized_path: Path | None = None) -> dict[str, Any]:
    with Image.open(source_path) as source_image, Image.open(render_path) as render_image:
        source = source_image.convert("RGB")
        render = render_image.convert("RGB")
        original_render_size = render.size
        size_match = render.size == source.size
        if normalized_path and size_match:
            normalized_path.parent.mkdir(parents=True, exist_ok=True)
            render.save(normalized_path)
        if not size_match:
            return {
                "sourceSize": {"width": source.width, "height": source.height},
                "renderSize": {"width": render.width, "height": render.height},
                "originalRenderSize": {"width": original_render_size[0], "height": original_render_size[1]},
                "sizeMatch": False, "ssim": None, "normalizedMae": None, "worstTileMae": None,
            }
        diff = ImageChops.difference(source, render)
        mae = sum(ImageStat.Stat(diff).mean) / (3.0 * 255.0)
        ssim = max(-1.0, min(1.0, _windowed_ssim(source, render)))
        tile_mae = []
        for top in range(0, source.height, 64):
            for left in range(0, source.width, 64):
                box = (left, top, min(source.width, left + 64), min(source.height, top + 64))
                tile_mae.append(sum(ImageStat.Stat(diff.crop(box)).mean) / (3.0 * 255.0))
        return {
            "sourceSize": {"width": source.width, "height": source.height},
            "renderSize": {"width": render.width, "height": render.height},
            "originalRenderSize": {"width": original_render_size[0], "height": original_render_size[1]},
            "sizeMatch": True,
            "ssim": round(ssim, 8),
            "normalizedMae": round(mae, 8),
            "worstTileMae": round(max(tile_mae, default=0.0), 8),
        }
