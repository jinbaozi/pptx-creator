"""Deterministic OCR helpers using system Tesseract when available."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[misc, assignment]

try:
    import pytesseract
except ImportError:  # pragma: no cover
    pytesseract = None  # type: ignore[assignment]

OCR_VERSION = "0.1.0"
DEFAULT_LANGS = "eng+chi_sim"


def _fail(message: str) -> None:
    raise ValueError(message)


def tesseract_info() -> dict[str, Any]:
    binary = shutil.which("tesseract")
    if not binary:
        return {
            "status": "deferred",
            "engine": None,
            "binary": None,
            "pytesseract": pytesseract is not None,
            "note": (
                "Tesseract not found on PATH. Install Tesseract OCR and optionally "
                "pip install pytesseract, or use host-agent vision for text extraction."
            ),
        }
    try:
        result = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        version_line = (result.stdout or result.stderr).splitlines()[0] if (result.stdout or result.stderr) else ""
    except (OSError, subprocess.TimeoutExpired):
        version_line = ""
    return {
        "status": "available",
        "engine": "tesseract",
        "binary": binary,
        "pytesseract": pytesseract is not None,
        "version": version_line,
        "note": "Run ocr-image.py to extract text blocks with bounding boxes.",
    }


def _require_ocr_runtime() -> dict[str, Any]:
    info = tesseract_info()
    if info["status"] != "available":
        _fail(info["note"])
    if pytesseract is None:
        _fail("pytesseract is required for OCR. Install with: pip install pytesseract")
    if Image is None:
        _fail("Pillow is required. Install with: pip install -r requirements.txt")
    return info


def _parse_tsv_boxes(tsv: str) -> list[dict[str, Any]]:
    lines = [line for line in tsv.strip().splitlines() if line.strip()]
    if len(lines) <= 1:
        return []
    blocks: list[dict[str, Any]] = []
    for row in lines[1:]:
        parts = row.split("\t")
        if len(parts) < 12:
            continue
        level, _, left, top, width, height, conf, text = (
            parts[0],
            parts[1],
            parts[6],
            parts[7],
            parts[8],
            parts[9],
            parts[10],
            parts[11],
        )
        if level != "5":
            continue
        cleaned = text.strip()
        if not cleaned or cleaned == "-1":
            continue
        try:
            confidence = float(conf)
        except ValueError:
            confidence = -1.0
        if confidence < 0:
            continue
        x, y, w, h = int(left), int(top), int(width), int(height)
        if w <= 0 or h <= 0:
            continue
        blocks.append(
            {
                "text": cleaned,
                "confidence": round(confidence, 2),
                "pixelBox": {"x": x, "y": y, "w": w, "h": h},
            }
        )
    return blocks


def ocr_image(
    image_path: Path,
    *,
    langs: str = DEFAULT_LANGS,
    min_confidence: float = 30.0,
) -> dict[str, Any]:
    image_path = image_path.resolve()
    if not image_path.exists():
        _fail(f"image not found: {image_path}")

    info = tesseract_info()
    if info["status"] != "available" or pytesseract is None or Image is None:
        return {
            "version": OCR_VERSION,
            "source": image_path.name,
            "ocr": info,
            "langs": langs,
            "textBlocks": [],
            "blockCount": 0,
            "status": "deferred",
            "note": info.get("note", "OCR unavailable"),
        }

    with Image.open(image_path) as img:
        rgb = img.convert("RGB")
        tsv = pytesseract.image_to_data(rgb, lang=langs, output_type=pytesseract.Output.STRING)
    blocks = _parse_tsv_boxes(tsv)
    filtered = [block for block in blocks if block["confidence"] >= min_confidence]

    return {
        "version": OCR_VERSION,
        "source": image_path.name,
        "ocr": info,
        "langs": langs,
        "textBlocks": filtered,
        "blockCount": len(filtered),
        "status": "ok",
        "note": "Host agent must verify OCR text; do not auto-rewrite content.",
    }


def write_json(data: dict[str, Any], output_path: Path | None = None) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text + "\n", encoding="utf-8")
    return text
