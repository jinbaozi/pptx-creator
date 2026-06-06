#!/usr/bin/env python3
"""Render PDF pages to image references and emit manifest-authoring hints."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from pdf_page_core import pdf_to_page_hints, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Build page-level PPTX authoring hints from a PDF.")
    parser.add_argument("pdf", type=Path, help="Source PDF")
    parser.add_argument("output_dir", type=Path, help="Directory for rendered page PNGs")
    parser.add_argument("-o", "--output", type=Path, help="Hints JSON path (stdout if omitted)")
    parser.add_argument("--dpi", type=int, default=144, help="PDF render DPI (default: 144)")
    parser.add_argument("--preset", default="wide", help="Slide size preset (default: wide)")
    parser.add_argument("--palette-count", type=int, default=6, help="Number of palette colors (1-12)")
    args = parser.parse_args()

    try:
        data = pdf_to_page_hints(
            args.pdf,
            args.output_dir,
            dpi=args.dpi,
            preset=args.preset,
            palette_count=args.palette_count,
        )
        text = write_json(data, args.output)
        if not args.output:
            print(text)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
