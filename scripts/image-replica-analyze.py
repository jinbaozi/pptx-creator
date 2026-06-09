#!/usr/bin/env python3
"""Build structured analysis for image-to-editable-PPTX replication."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from image_inspect_core import build_replica_analysis, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze an image for editable PPTX replication.")
    parser.add_argument("image", type=Path, help="Path to PNG/JPEG reference image")
    parser.add_argument("output", type=Path, nargs="?", help="Output analysis JSON path (stdout if omitted)")
    parser.add_argument("--preset", default="wide", help="Slide size preset (default: wide)")
    parser.add_argument("--deck-title", default=None, help="Deck title for downstream replica planning")
    parser.add_argument("--palette-count", type=int, default=8, help="Number of palette colors (1-12)")
    args = parser.parse_args()

    try:
        data = build_replica_analysis(
            args.image,
            preset=args.preset,
            palette_count=args.palette_count,
            deck_title=args.deck_title,
        )
        text = write_json(data, args.output)
        if not args.output:
            print(text)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
