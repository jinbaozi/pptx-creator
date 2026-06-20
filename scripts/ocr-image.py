#!/usr/bin/env python3
"""Run basic OCR on an image and emit text blocks with bounding boxes."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from ocr_core import DEFAULT_LANGS, ocr_image, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="OCR an image with Tesseract (when installed).")
    parser.add_argument("image", type=Path, help="Path to PNG/JPEG image")
    parser.add_argument("-o", "--output", type=Path, help="Output JSON path (stdout if omitted)")
    parser.add_argument("--json", dest="json_stdout", action="store_true",
                        help="Always emit JSON to stdout (ignores --output). Used by adapter scripts.")
    parser.add_argument("--langs", default=DEFAULT_LANGS, help="Tesseract language codes (default: eng+chi_sim)")
    parser.add_argument("--min-confidence", type=float, default=30.0, help="Minimum confidence 0-100")
    args = parser.parse_args()

    try:
        data = ocr_image(args.image, langs=args.langs, min_confidence=args.min_confidence)
        if args.json_stdout:
            print(write_json(data))
        else:
            text = write_json(data, args.output)
            if not args.output:
                print(text)
        if data.get("status") == "deferred":
            raise SystemExit(2)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
