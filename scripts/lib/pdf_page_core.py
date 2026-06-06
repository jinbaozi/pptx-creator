"""PDF page input helpers for page-level PPTX replication."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

from image_inspect_core import build_manifest_hints

PDF_HINTS_VERSION = "0.1.0"


def _fail(message: str) -> None:
    raise ValueError(message)


def _find_fitz() -> Any | None:
    if importlib.util.find_spec("fitz") is None:
        return None
    import fitz  # type: ignore[import-not-found]

    return fitz


def pdf_renderer_status() -> dict[str, Any]:
    fitz = _find_fitz()
    if fitz is None:
        return {
            "status": "deferred",
            "engine": None,
            "note": "PyMuPDF is not installed. Install it to render PDF pages: pip install PyMuPDF",
        }
    return {
        "status": "available",
        "engine": "PyMuPDF",
        "version": getattr(fitz, "version", ["unknown"])[0],
        "note": "PDF pages can be rendered to PNG references.",
    }


def pdf_to_page_hints(
    pdf_path: Path,
    output_dir: Path,
    *,
    dpi: int = 144,
    preset: str = "wide",
    palette_count: int = 6,
) -> dict[str, Any]:
    pdf_path = pdf_path.resolve()
    output_dir = output_dir.resolve()
    if not pdf_path.exists():
        _fail(f"PDF not found: {pdf_path}")
    if pdf_path.suffix.lower() != ".pdf":
        _fail(f"expected a .pdf file: {pdf_path}")

    renderer = pdf_renderer_status()
    if renderer["status"] != "available":
        return {
            "version": PDF_HINTS_VERSION,
            "sourcePdf": pdf_path.name,
            "renderer": renderer,
            "pages": [],
            "status": "deferred",
            "note": renderer["note"],
        }

    fitz = _find_fitz()
    output_dir.mkdir(parents=True, exist_ok=True)
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pages: list[dict[str, Any]] = []

    try:
        document = fitz.open(str(pdf_path))
    except Exception as error:  # pragma: no cover - depends on optional parser
        _fail(f"failed to open PDF: {error}")

    with document:
        for index, page in enumerate(document, start=1):
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            image_path = output_dir / f"page-{index:03d}.png"
            pixmap.save(str(image_path))
            hints = build_manifest_hints(
                image_path,
                preset=preset,
                palette_count=palette_count,
                deck_title=f"{pdf_path.stem} page {index}",
            )
            pages.append(
                {
                    "pageNumber": index,
                    "image": str(image_path),
                    "widthPt": round(page.rect.width, 4),
                    "heightPt": round(page.rect.height, 4),
                    "hints": hints,
                }
            )

    return {
        "version": PDF_HINTS_VERSION,
        "sourcePdf": pdf_path.name,
        "renderer": renderer,
        "dpi": dpi,
        "pageCount": len(pages),
        "pages": pages,
        "status": "ok",
        "note": "PDF pages rendered to PNG and analyzed as image-to-PPTX references.",
    }


def write_json(data: dict[str, Any], output_path: Path | None = None) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text + "\n", encoding="utf-8")
    return text
