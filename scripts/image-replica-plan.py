#!/usr/bin/env python3
"""Build a layer plan from the analysis artifact's measured detector facts."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from image_inspect_core import (  # noqa: E402
    DEFAULT_OCR_CONFIDENCE_THRESHOLD,
    build_replica_layer_plan,
    write_json,
)

def main() -> None:
    parser = argparse.ArgumentParser(description="Create a PPTX replica layer plan from analysis JSON.")
    parser.add_argument("analysis", type=Path, help="Path to image-replica-analysis.json")
    parser.add_argument("output", type=Path, nargs="?", help="Output layer plan JSON path (stdout if omitted)")
    parser.add_argument(
        "--ocr-confidence",
        type=float,
        default=DEFAULT_OCR_CONFIDENCE_THRESHOLD,
        help=(
            "Per-block OCR confidence threshold (0-1) above which a text "
            "block is emitted as editable-text. Below the threshold the "
            f"block is emitted as cropped-asset. Default: {DEFAULT_OCR_CONFIDENCE_THRESHOLD}."
        ),
    )
    parser.add_argument(
        "--skip-ocr",
        action="store_true",
        help="Deprecated compatibility flag; OCR is owned by the analysis stage.",
    )
    args = parser.parse_args()

    if not 0.0 <= args.ocr_confidence <= 1.0:
        print(
            f"--ocr-confidence must be between 0 and 1 (got {args.ocr_confidence})",
            file=sys.stderr,
        )
        raise SystemExit(2)

    try:
        data = json.loads(args.analysis.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error

    try:
        plan = build_replica_layer_plan(data, threshold=args.ocr_confidence)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
    analysis_bytes=args.analysis.read_bytes()
    plan["analysisPath"]=str(args.analysis.resolve())
    plan["analysisSha256"]=hashlib.sha256(analysis_bytes).hexdigest()
    text = write_json(plan, args.output)
    if not args.output:
        print(text)


if __name__ == "__main__":
    main()
