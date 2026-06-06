#!/usr/bin/env python3
import json
import sys
from pathlib import Path


REQUIRED = ["final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md"]


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: package-output.py <output-dir>")
    output_dir = Path(sys.argv[1])
    missing = [name for name in REQUIRED if not (output_dir / name).exists()]
    if missing:
        fail(f"missing output files: {', '.join(missing)}")
    manifest = {"outputDir": str(output_dir), "files": sorted(path.name for path in output_dir.iterdir())}
    (output_dir / "output-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
