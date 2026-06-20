#!/usr/bin/env python3
"""Build a layer plan from image replica analysis JSON.

When the analysis JSON does not already carry an ``image`` source path we
still try to invoke ``scripts/ocr-image.py`` to gather text blocks with
confidence values. The raw Tesseract 0-100 scale is normalized to 0-1 here
so the gating logic in ``build_replica_layer_plan`` can compare against a
single, project-wide threshold (default 0.7 — locked after U10 Calibration).
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from image_inspect_core import (  # noqa: E402
    DEFAULT_OCR_CONFIDENCE_THRESHOLD,
    build_replica_layer_plan,
    write_json,
)

OCR_SCRIPT = ROOT / "scripts" / "ocr-image.py"


def _normalize_ocr_blocks(ocr_payload: dict | None) -> list[dict] | None:
    """Convert Tesseract 0-100 confidences into 0-1 and preserve pixel boxes.

    Returns None when OCR is unavailable (``status: "deferred"`` or no
    payload) so ``build_replica_layer_plan`` falls back to the conservative
    default (every text-region object becomes ``cropped-asset``).
    """
    if not ocr_payload:
        return None
    if ocr_payload.get("status") and ocr_payload.get("status") != "ok":
        return None
    blocks: list[dict] = []
    for raw in ocr_payload.get("textBlocks") or []:
        try:
            confidence_raw = float(raw.get("confidence"))
        except (TypeError, ValueError):
            continue
        confidence_01 = round(confidence_raw / 100.0, 4)
        text = str(raw.get("text") or "").strip()
        pixel_box = raw.get("pixelBox") or {}
        if not text or not pixel_box:
            continue
        blocks.append(
            {
                "text": text,
                "confidence01": confidence_01,
                "pixelBox": pixel_box,
            }
        )
    return blocks or None


def _invoke_ocr(image_path: Path, min_confidence: float = 0.0) -> dict | None:
    """Run ``scripts/ocr-image.py`` and parse its JSON output.

    Returns the OCR dict on success, or None when the script is missing,
    returns a non-JSON payload, or the Tesseract binary is unavailable
    (ocr-image.py exits with code 2 in that case).
    """
    if not OCR_SCRIPT.exists():
        return None
    try:
        result = subprocess.run(
            [sys.executable, str(OCR_SCRIPT), str(image_path), "--json"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode not in {0, 2}:
        return None
    stdout = (result.stdout or "").strip()
    if not stdout:
        return None
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return None


def _resolve_source_image(analysis: dict) -> Path | None:
    """Try to locate the original image referenced by an analysis payload.

    Falls back to ``None`` when only the filename is known and the file does
    not sit next to the analysis JSON. In that case we skip OCR (the layer
    plan still runs, treating all text-region objects as ``cropped-asset``).
    """
    name = analysis.get("sourceImage")
    if not name:
        return None
    candidate = Path(name)
    if candidate.is_absolute() and candidate.exists():
        return candidate
    # Common locations: analysis-dir/ and repo root/examples/<set>/
    for base in (Path.cwd(), ROOT):
        for sub in (".", "examples/image-input", "examples"):
            path = (base / sub / name).resolve() if not (base / sub).is_absolute() else (base / sub / name)
            if path.exists():
                return path
    return None


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
        help="Skip OCR invocation (useful for tests and offline runs).",
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

    ocr_blocks: list[dict] | None = None
    if not args.skip_ocr:
        image_path = _resolve_source_image(data)
        if image_path is not None:
            ocr_payload = _invoke_ocr(image_path)
            ocr_blocks = _normalize_ocr_blocks(ocr_payload)

    try:
        plan = build_replica_layer_plan(data, ocr_blocks=ocr_blocks, threshold=args.ocr_confidence)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
    text = write_json(plan, args.output)
    if not args.output:
        print(text)


if __name__ == "__main__":
    main()
