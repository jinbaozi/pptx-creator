#!/usr/bin/env python3
"""Extract dominant palette colors from an image."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from image_inspect_core import extract_palette, load_image  # noqa: E402

PALETTE_VERSION = "0.1.0"


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract palette colors from an image.")
    parser.add_argument("image", type=Path, help="Path to PNG/JPEG image")
    parser.add_argument("output", type=Path, nargs="?", help="Output palette.json (stdout if omitted)")
    parser.add_argument("--count", type=int, default=6, help="Number of colors (1-12)")
    args = parser.parse_args()

    try:
        img = load_image(args.image)
        palette = extract_palette(img, args.count)
        data = {
            "version": PALETTE_VERSION,
            "source": args.image.name,
            "count": len(palette),
            "palette": palette,
        }
        text = json.dumps(data, ensure_ascii=False, indent=2)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text + "\n", encoding="utf-8")
        else:
            print(text)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
