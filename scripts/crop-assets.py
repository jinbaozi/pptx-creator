#!/usr/bin/env python3
"""Crop regions from a reference image into standalone PNG assets."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from crop_core import crop_assets, load_crops_file, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Crop image regions into PNG assets.")
    parser.add_argument("image", type=Path, help="Source PNG/JPEG")
    parser.add_argument("crops", type=Path, help="JSON file with crop boxes")
    parser.add_argument("output_dir", type=Path, help="Directory for cropped PNG files")
    parser.add_argument("-m", "--manifest", type=Path, help="Optional assets manifest JSON output path")
    parser.add_argument("--preset", default="wide", help="Slide preset for inch boxes (default: wide)")
    args = parser.parse_args()

    try:
        crops = load_crops_file(args.crops)
        data = crop_assets(args.image, crops, args.output_dir, preset=args.preset)
        text = write_json(data, args.manifest)
        if not args.manifest:
            print(text)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
