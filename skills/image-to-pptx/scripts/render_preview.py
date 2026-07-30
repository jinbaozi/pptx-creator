#!/usr/bin/env python3
"""Render a PPTX to deterministic PNG previews through LibreOffice and Poppler."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


class PreviewError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def binary(*names: str) -> str:
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    raise PreviewError("E_RENDER_RUNTIME", f"missing runtime: {' or '.join(names)}")


def render(
    pptx: Path,
    output_dir: Path,
    width_px: int,
    width_in: float,
    relative_to: Path | None = None,
) -> dict:
    if not pptx.is_file():
        raise PreviewError("E_CONTRACT", f"PPTX not found: {pptx}")
    soffice = binary("soffice", "libreoffice")
    pdftoppm = binary("pdftoppm")
    output_dir.mkdir(parents=True, exist_ok=True)
    dpi = round(width_px / width_in)
    with tempfile.TemporaryDirectory(prefix="image-to-pptx-lo-") as profile:
        profile_uri = Path(profile).resolve().as_uri()
        converted = subprocess.run(
            [
                soffice,
                "--headless",
                f"-env:UserInstallation={profile_uri}",
                "--convert-to",
                "pdf",
                "--outdir",
                str(output_dir),
                str(pptx.resolve()),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    if converted.returncode != 0:
        raise PreviewError(
            "E_RENDER_RUNTIME",
            converted.stderr.strip() or converted.stdout.strip() or "LibreOffice conversion failed",
        )
    pdf = output_dir / f"{pptx.stem}.pdf"
    if not pdf.is_file():
        candidates = sorted(output_dir.glob("*.pdf"))
        if len(candidates) != 1:
            raise PreviewError("E_RENDER_RUNTIME", "LibreOffice did not create one PDF")
        pdf = candidates[0]
    prefix = output_dir / "slide"
    rendered = subprocess.run(
        [
            pdftoppm,
            "-png",
            "-r",
            str(dpi),
            str(pdf),
            str(prefix),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    if rendered.returncode != 0:
        raise PreviewError(
            "E_RENDER_RUNTIME",
            rendered.stderr.strip() or "pdftoppm conversion failed",
        )
    pages = sorted(output_dir.glob("slide-*.png"))
    if not pages:
        raise PreviewError("E_RENDER_RUNTIME", "no preview pages were rendered")
    def display(path: Path) -> str:
        if relative_to:
            return path.resolve().relative_to(relative_to.resolve()).as_posix()
        return str(path.resolve())

    return {
        "status": "ok",
        "engine": "libreoffice+pdftoppm",
        "dpi": dpi,
        "pdf": display(pdf),
        "pages": [display(path) for path in pages],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--width-px", type=int, required=True)
    parser.add_argument("--width-in", type=float, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--relative-to", type=Path)
    args = parser.parse_args()
    try:
        result = render(
            args.pptx,
            args.output_dir,
            args.width_px,
            args.width_in,
            args.relative_to,
        )
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result))
    except (PreviewError, subprocess.TimeoutExpired) as error:
        code = getattr(error, "code", "E_RENDER_RUNTIME")
        print(
            json.dumps({"status": "failed", "code": code, "message": str(error)}),
            file=sys.stderr,
        )
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
