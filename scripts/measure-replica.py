#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
from replica_metrics_core import compare_replica_images  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("render", type=Path)
    parser.add_argument("--normalized-render", type=Path)
    args = parser.parse_args()
    print(json.dumps(compare_replica_images(args.source, args.render, args.normalized_render)))


if __name__ == "__main__":
    main()
