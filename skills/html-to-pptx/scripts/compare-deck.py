#!/usr/bin/env python3
"""Compare source HTML slide screenshots with rendered PPTX slides.

The comparator intentionally depends only on Pillow and the Python standard
library.  It refuses to resize either image: a dimension mismatch means that
the source and candidate are not comparable evidence and therefore fails the
gate.  The report retains the historical mean RGB-channel difference while
adding normalized MAE, global SSIM, and a deterministic worst-tile diagnostic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageStat


DEFAULT_THRESHOLD = 48.0
DEFAULT_SSIM_THRESHOLD = 0.85
DEFAULT_NORMALIZED_MAE_THRESHOLD = 12.0 / 255.0
DEFAULT_WORST_TILE_MAE_THRESHOLD = 0.20
DEFAULT_BAD_PIXEL_THRESHOLD = 0.10
DEFAULT_BAD_PIXEL_RATIO = 0.80
DEFAULT_TILE_SIZE = 64


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _luma_pixels(image: Image.Image) -> list[float]:
    """Return deterministic ITU-R BT.601 luma values in the 0..255 range."""

    return [
        (299.0 * red + 587.0 * green + 114.0 * blue) / 1000.0
        for red, green, blue in image.getdata()
    ]


def _ssim(reference: Image.Image, candidate: Image.Image, window_size: int = 8) -> float:
    """Compute a tiled grayscale SSIM score without third-party arrays.

    This is the standard luminance/contrast/structure form with the usual
    constants for an 8-bit signal.  Eight-pixel windows expose local text and
    shape omissions while avoiding a global score being dominated by one large
    background. Keeping this implementation scalar makes the metric
    reproducible in an isolated Skill package.
    """

    reference_values = _luma_pixels(reference)
    candidate_values = _luma_pixels(candidate)
    c1 = (0.01 * 255.0) ** 2
    c2 = (0.03 * 255.0) ** 2
    width, height = reference.size
    values: list[float] = []
    for left, top, tile_width, tile_height in _iter_tile_boxes(width, height, window_size):
        ref_window: list[float] = []
        cand_window: list[float] = []
        for row in range(top, top + tile_height):
            start = row * width + left
            end = start + tile_width
            ref_window.extend(reference_values[start:end])
            cand_window.extend(candidate_values[start:end])
        count = len(ref_window)
        if count == 0:
            continue
        reference_mean = sum(ref_window) / count
        candidate_mean = sum(cand_window) / count
        reference_variance = sum((value - reference_mean) ** 2 for value in ref_window) / count
        candidate_variance = sum((value - candidate_mean) ** 2 for value in cand_window) / count
        covariance = sum(
            (ref_window[index] - reference_mean)
            * (cand_window[index] - candidate_mean)
            for index in range(count)
        ) / count
        numerator = (2.0 * reference_mean * candidate_mean + c1) * (2.0 * covariance + c2)
        denominator = (
            (reference_mean**2 + candidate_mean**2 + c1)
            * (reference_variance + candidate_variance + c2)
        )
        score = 1.0 if denominator == 0 and numerator == 0 else 0.0 if denominator == 0 else numerator / denominator
        values.append(max(0.0, min(1.0, score)))
    return sum(values) / len(values) if values else 1.0


def _iter_tile_boxes(width: int, height: int, tile_size: int) -> Iterable[tuple[int, int, int, int]]:
    for top in range(0, height, tile_size):
        for left in range(0, width, tile_size):
            yield left, top, min(tile_size, width - left), min(tile_size, height - top)


def _worst_tile(
    reference: Image.Image,
    candidate: Image.Image,
    tile_size: int,
    bad_pixel_threshold: float,
) -> dict:
    """Return the highest-MAE tile, with deterministic row-major tie breaking."""

    reference_pixels = list(reference.getdata())
    candidate_pixels = list(candidate.getdata())
    width, height = reference.size
    best: dict | None = None
    for left, top, tile_width, tile_height in _iter_tile_boxes(width, height, tile_size):
        total = 0.0
        bad = 0
        count = tile_width * tile_height
        for row in range(top, top + tile_height):
            start = row * width + left
            for offset in range(tile_width):
                ref = reference_pixels[start + offset]
                cand = candidate_pixels[start + offset]
                delta = (
                    abs(ref[0] - cand[0])
                    + abs(ref[1] - cand[1])
                    + abs(ref[2] - cand[2])
                ) / (3.0 * 255.0)
                total += delta
                if delta > bad_pixel_threshold:
                    bad += 1
        mae = total / max(count, 1)
        candidate_tile = {
            "x": left,
            "y": top,
            "width": tile_width,
            "height": tile_height,
            "mae": round(mae, 6),
            "badPixelRatio": round(bad / max(count, 1), 6),
        }
        if best is None or candidate_tile["mae"] > best["mae"]:
            best = candidate_tile
    return best or {
        "x": 0,
        "y": 0,
        "width": 0,
        "height": 0,
        "mae": 0.0,
        "badPixelRatio": 0.0,
    }


def compare(
    reference_path: Path,
    candidate_path: Path,
    diff_path: Path,
    *,
    tile_size: int,
    bad_pixel_threshold: float,
) -> dict:
    with Image.open(reference_path) as reference_image, Image.open(candidate_path) as candidate_image:
        reference = reference_image.convert("RGB")
        candidate = candidate_image.convert("RGB")
        size_match = reference.size == candidate.size
        result = {
            "reference": str(reference_path.resolve()),
            "candidate": str(candidate_path.resolve()),
            "diff": None,
            "referenceSha256": sha256(reference_path),
            "candidateSha256": sha256(candidate_path),
            "referenceSize": {"width": reference.width, "height": reference.height},
            "candidateSize": {"width": candidate.width, "height": candidate.height},
            "sizeMatch": size_match,
        }
        if not size_match:
            result.update(
                {
                    "meanAbsChannelDiff": None,
                    "normalizedMae": None,
                    "similarity": None,
                    "ssim": None,
                    "worstTile": None,
                    "worstTileMae": None,
                    "worstTileBadPixelRatio": None,
                    "passed": False,
                    "failureReason": "source and candidate image dimensions must match exactly",
                }
            )
            return result

        difference = ImageChops.difference(reference, candidate)
        difference.save(diff_path)
        mean = sum(ImageStat.Stat(difference).mean) / 3.0
        normalized_mae = mean / 255.0
        worst_tile = _worst_tile(reference, candidate, tile_size, bad_pixel_threshold)
        result.update(
            {
                "diff": str(diff_path.resolve()),
                "meanAbsChannelDiff": round(mean, 4),
                "normalizedMae": round(normalized_mae, 8),
                "similarity": round(max(0.0, 1.0 - normalized_mae), 6),
                "ssim": round(_ssim(reference, candidate), 8),
                "worstTile": worst_tile,
                "worstTileMae": worst_tile["mae"],
                "worstTileBadPixelRatio": worst_tile["badPixelRatio"],
            }
        )
        return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("render_dir", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--ssim-threshold", type=float, default=DEFAULT_SSIM_THRESHOLD)
    parser.add_argument("--normalized-mae-threshold", type=float, default=None)
    parser.add_argument("--worst-tile-mae-threshold", type=float, default=DEFAULT_WORST_TILE_MAE_THRESHOLD)
    parser.add_argument("--bad-pixel-threshold", type=float, default=DEFAULT_BAD_PIXEL_THRESHOLD)
    parser.add_argument("--bad-pixel-ratio", type=float, default=DEFAULT_BAD_PIXEL_RATIO)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    args = parser.parse_args()
    if args.threshold < 0 or args.ssim_threshold < 0 or args.ssim_threshold > 1:
        raise SystemExit("thresholds must be non-negative and SSIM must be within 0..1")
    if args.normalized_mae_threshold is None:
        args.normalized_mae_threshold = DEFAULT_NORMALIZED_MAE_THRESHOLD
    if args.normalized_mae_threshold < 0 or args.worst_tile_mae_threshold < 0:
        raise SystemExit("MAE thresholds must be non-negative")
    if args.bad_pixel_threshold < 0 or args.bad_pixel_threshold > 1 or args.bad_pixel_ratio < 0 or args.bad_pixel_ratio > 1:
        raise SystemExit("bad-pixel thresholds must be within 0..1")
    if args.tile_size < 1:
        raise SystemExit("tile size must be positive")

    source_paths = sorted(args.source_dir.glob("*.png"))
    render_paths = sorted(args.render_dir.glob("slide-*.png"))
    if not source_paths:
        raise SystemExit("no source HTML screenshots were found")
    if len(source_paths) != len(render_paths):
        raise SystemExit(
            f"slide count mismatch: source={len(source_paths)} render={len(render_paths)}"
        )

    diff_dir = args.output.parent / "visual-diff"
    diff_dir.mkdir(parents=True, exist_ok=True)
    slides = [
        compare(
            source,
            candidate,
            diff_dir / f"slide-{index + 1:03d}.png",
            tile_size=args.tile_size,
            bad_pixel_threshold=args.bad_pixel_threshold,
        )
        for index, (source, candidate) in enumerate(zip(source_paths, render_paths))
    ]
    size_match = all(slide["sizeMatch"] for slide in slides)
    available = [slide for slide in slides if slide["sizeMatch"]]
    maximum = max((slide["meanAbsChannelDiff"] for slide in available), default=None)
    mean = (
        sum(slide["meanAbsChannelDiff"] for slide in available) / len(available)
        if available
        else None
    )
    minimum_similarity = min((slide["similarity"] for slide in available), default=None)
    minimum_ssim = min((slide["ssim"] for slide in available), default=None)
    maximum_normalized_mae = max((slide["normalizedMae"] for slide in available), default=None)
    worst_tile = max(
        (
            {"slideIndex": index, **slide["worstTile"]}
            for index, slide in enumerate(slides)
            if slide["sizeMatch"] and slide["worstTile"]
        ),
        key=lambda tile: tile["mae"],
        default=None,
    )
    catastrophic_tile = bool(
        worst_tile
        and worst_tile["mae"] > args.worst_tile_mae_threshold
        and worst_tile["badPixelRatio"] > args.bad_pixel_ratio
    )
    passed = bool(
        size_match
        and available
        and maximum <= args.threshold
        and minimum_ssim >= args.ssim_threshold
        and maximum_normalized_mae <= args.normalized_mae_threshold
        and not catastrophic_tile
    )
    report = {
        "version": "1.1.0",
        "threshold": args.threshold,
        "ssimThreshold": args.ssim_threshold,
        "normalizedMaeThreshold": args.normalized_mae_threshold,
        "worstTileMaeThreshold": args.worst_tile_mae_threshold,
        "badPixelThreshold": args.bad_pixel_threshold,
        "badPixelRatioThreshold": args.bad_pixel_ratio,
        "tileSize": args.tile_size,
        "slides": slides,
        "summary": {
            "slideCount": len(slides),
            "sizeMatch": size_match,
            "meanAbsChannelDiff": round(mean, 4) if mean is not None else None,
            "maxMeanAbsChannelDiff": round(maximum, 4) if maximum is not None else None,
            "minimumSimilarity": round(minimum_similarity, 6) if minimum_similarity is not None else None,
            "minimumSsim": round(minimum_ssim, 8) if minimum_ssim is not None else None,
            "maximumNormalizedMae": round(maximum_normalized_mae, 8) if maximum_normalized_mae is not None else None,
            "worstTile": worst_tile,
            "catastrophicWorstTile": catastrophic_tile,
            "passed": passed,
        },
    }
    if not size_match:
        report["summary"]["failureReason"] = "source and candidate image dimensions must match exactly"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    raise SystemExit(0 if passed else 2)


if __name__ == "__main__":
    main()
