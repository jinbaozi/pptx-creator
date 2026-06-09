#!/usr/bin/env python3
"""Build a layer plan from image replica analysis JSON."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from image_inspect_core import build_replica_layer_plan, write_json  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a PPTX replica layer plan from analysis JSON.")
    parser.add_argument("analysis", type=Path, help="Path to image-replica-analysis.json")
    parser.add_argument("output", type=Path, nargs="?", help="Output layer plan JSON path (stdout if omitted)")
    args = parser.parse_args()

    try:
        data = json.loads(args.analysis.read_text(encoding="utf-8"))
        plan = build_replica_layer_plan(data)
        text = write_json(plan, args.output)
        if not args.output:
            print(text)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
