#!/usr/bin/env python3
"""Compare source HTML slide screenshots with rendered PPTX slides."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageStat


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compare(reference_path: Path, candidate_path: Path, diff_path: Path) -> dict:
    with Image.open(reference_path) as reference_image, Image.open(candidate_path) as candidate_image:
        reference = reference_image.convert("RGB")
        candidate_original_size = candidate_image.size
        candidate = candidate_image.convert("RGB")
        size_match = reference.size == candidate.size
        if not size_match:
            candidate = candidate.resize(reference.size)
        difference = ImageChops.difference(reference, candidate)
        difference.save(diff_path)
        mean = sum(ImageStat.Stat(difference).mean) / 3.0
        similarity = max(0.0, 1.0 - mean / 255.0)
        return {
            "reference": str(reference_path.resolve()),
            "candidate": str(candidate_path.resolve()),
            "diff": str(diff_path.resolve()),
            "referenceSha256": sha256(reference_path),
            "candidateSha256": sha256(candidate_path),
            "referenceSize": {"width": reference.width, "height": reference.height},
            "candidateSize": {
                "width": candidate_original_size[0],
                "height": candidate_original_size[1],
            },
            "sizeMatch": size_match,
            "meanAbsChannelDiff": round(mean, 4),
            "similarity": round(similarity, 6),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("render_dir", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--threshold", type=float, default=48.0)
    args = parser.parse_args()

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
        compare(source, candidate, diff_dir / f"slide-{index + 1:03d}.png")
        for index, (source, candidate) in enumerate(zip(source_paths, render_paths))
    ]
    maximum = max(slide["meanAbsChannelDiff"] for slide in slides)
    mean = sum(slide["meanAbsChannelDiff"] for slide in slides) / len(slides)
    report = {
        "version": "1.0.0",
        "threshold": args.threshold,
        "slides": slides,
        "summary": {
            "slideCount": len(slides),
            "meanAbsChannelDiff": round(mean, 4),
            "maxMeanAbsChannelDiff": round(maximum, 4),
            "minimumSimilarity": min(slide["similarity"] for slide in slides),
            "passed": maximum <= args.threshold,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False))
    raise SystemExit(0 if report["summary"]["passed"] else 2)


if __name__ == "__main__":
    main()
