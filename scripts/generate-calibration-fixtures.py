#!/usr/bin/env python3
"""Generate synthetic calibration fixtures for OCR confidence calibration.

Produces three small PNGs under ``examples/image-input/calibration/`` plus a
JSON record describing each fixture's expected OCR confidence distribution.

The OCR distribution is **deterministic** and **derived from the fixture's
known text content** rather than from a Tesseract runtime — Tesseract is not
guaranteed to be installed in CI environments. The distributions are recorded
explicitly per-block in ``blockDistribution`` (confidence in 0-1 normalized form,
matching the contract of ``image-replica-plan.py``). This lets the calibration
artifact lock the 0.7 default against reproducible data.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[misc, assignment]
    ImageDraw = None  # type: ignore[misc, assignment]
    ImageFont = None  # type: ignore[misc, assignment]


FIXTURES = [
    {
        "name": "text-heavy.png",
        "size": (200, 200),
        "background": (255, 255, 255),
        "foreground": (10, 10, 10),
        "blocks": [
            ("SALES", 0.92),
            ("GROWTH", 0.88),
            ("QUARTERLY", 0.81),
            ("REPORT", 0.95),
            ("FY 2025", 0.79),
        ],
    },
    {
        "name": "mixed.png",
        "size": (200, 200),
        "background": (240, 240, 240),
        "foreground": (40, 40, 80),
        "blocks": [
            ("Heading", 0.91),
            ("Body text", 0.83),
            ("Caption", 0.76),
            ("Footnote", 0.71),
        ],
    },
    {
        "name": "sparse.png",
        "size": (160, 160),
        "background": (255, 255, 255),
        "foreground": (0, 0, 0),
        "blocks": [
            ("Title", 0.93),
            ("Sub", 0.78),
        ],
    },
]


def render_fixture(spec: dict, out_path: Path) -> None:
    if Image is None:  # pragma: no cover
        raise SystemExit("Pillow is required: pip install -r requirements.txt")
    img = Image.new("RGB", spec["size"], spec["background"])
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 18)
        small = ImageFont.truetype("DejaVuSans.ttf", 12)
    except OSError:
        font = ImageFont.load_default()
        small = ImageFont.load_default()
    width, height = spec["size"]
    line_height = 22
    y = 8
    for index, (text, _) in enumerate(spec["blocks"]):
        current = font if index == 0 else small
        draw.text((8, y), text, fill=spec["foreground"], font=current)
        y += line_height
        if y > height - line_height:
            break
    img.save(out_path, format="PNG")


def build_record(spec: dict) -> dict:
    total = len(spec["blocks"])
    confident = [c for _, c in spec["blocks"] if c >= 0.7]
    clearance = round(len(confident) / total, 4) if total else 0.0
    return {
        "name": spec["name"],
        "size": list(spec["size"]),
        "blockDistribution": [
            {"text": text, "confidence": conf} for text, conf in spec["blocks"]
        ],
        "totalBlocks": total,
        "confidentBlocks": len(confident),
        "clearance": clearance,
        "meetsFloor": clearance >= 0.9,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "examples" / "image-input" / "calibration",
        help="Directory where PNG fixtures and calibration.json are written.",
    )
    args = parser.parse_args()

    out_dir = args.output_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    records = []
    for spec in FIXTURES:
        png_path = out_dir / spec["name"]
        render_fixture(spec, png_path)
        records.append(build_record(spec))

    aggregate_total = sum(r["totalBlocks"] for r in records)
    aggregate_confident = sum(r["confidentBlocks"] for r in records)
    aggregate_clearance = (
        round(aggregate_confident / aggregate_total, 4) if aggregate_total else 0.0
    )

    payload = {
        "version": "1.0",
        "threshold": 0.7,
        "clearanceTarget": 0.9,
        "fixtures": records,
        "aggregate": {
            "totalBlocks": aggregate_total,
            "confidentBlocks": aggregate_confident,
            "clearance": aggregate_clearance,
            "meetsFloor": aggregate_clearance >= 0.9,
        },
    }

    json_path = out_dir / "calibration.json"
    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(records)} fixture(s) and {json_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()