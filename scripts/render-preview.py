#!/usr/bin/env python3
"""Render PPTX preview PNGs using LibreOffice headless when available."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from preview_core import render_pptx_preview, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Render PPTX to PNG previews (optional LibreOffice).")
    parser.add_argument("pptx", type=Path, help="Path to .pptx file")
    parser.add_argument("output_dir", type=Path, help="Directory for preview PNG files")
    parser.add_argument("-o", "--report", type=Path, help="Optional JSON report path")
    args = parser.parse_args()

    try:
        data = render_pptx_preview(args.pptx, args.output_dir)
        text = write_json(data, args.report)
        if not args.report:
            print(text)
        if data.get("status") == "failed":
            raise SystemExit(1)
        if data.get("status") == "deferred":
            raise SystemExit(2)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
