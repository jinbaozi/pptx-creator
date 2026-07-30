#!/usr/bin/env python3
"""Compare reference and rendered preview images with deterministic stats."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from preview_core import compare_images, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare reference vs candidate preview images.")
    parser.add_argument("reference", type=Path, help="Reference PNG/JPEG")
    parser.add_argument("candidate", type=Path, help="Candidate PNG/JPEG")
    parser.add_argument("-o", "--output", type=Path, help="Diff report JSON path (stdout if omitted)")
    args = parser.parse_args()

    try:
        data = compare_images(args.reference, args.candidate)
        text = write_json(data, args.output)
        if not args.output:
            print(text)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
