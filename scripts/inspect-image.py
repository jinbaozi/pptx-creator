#!/usr/bin/env python3
"""Output image dimensions, palette, and OCR status as JSON."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from image_inspect_core import inspect_image, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect an image and emit metadata JSON.")
    parser.add_argument("image", type=Path, help="Path to PNG/JPEG reference image")
    parser.add_argument("-o", "--output", type=Path, help="Optional output JSON path")
    parser.add_argument("--palette-count", type=int, default=6, help="Number of palette colors (1-12)")
    args = parser.parse_args()

    try:
        data = inspect_image(args.image, palette_count=args.palette_count)
        text = write_json(data, args.output)
        if not args.output:
            print(text)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
