#!/usr/bin/env python3
"""Render a PPTX to deterministic PNG previews through LibreOffice and Poppler."""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import shutil
import subprocess
import sys
import tempfile
import platform
from pathlib import Path

from PIL import Image


RENDERER_VERSION = "2.0"


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


def _command_version(command: str, *args: str) -> dict[str, str]:
    """Capture a stable first-line version without making optional tools fatal."""
    try:
        result = subprocess.run(
            [command, *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"status": "unavailable", "detail": str(error)}
    output = next(
        (line.strip() for line in (result.stdout + "\n" + result.stderr).splitlines() if line.strip()),
        "",
    )
    if result.returncode != 0 and not output:
        return {"status": "unavailable", "detail": f"{command} exited {result.returncode}"}
    return {"status": "available", "version": output}


def _package_version(distribution: str, module_name: str | None = None) -> dict[str, str]:
    try:
        version = importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        try:
            module = importlib.import_module(module_name or distribution)
            version = str(getattr(module, "__version__"))
        except Exception as error:  # pragma: no cover - optional environment
            return {"status": "unavailable", "detail": str(error)}
    except Exception as error:  # pragma: no cover - optional environment
        return {"status": "unavailable", "detail": str(error)}
    return {"status": "available", "version": str(version)}


def runtime_report(soffice: str, pdftoppm: str) -> dict:
    """Record the binaries and Python libraries that determine the preview."""
    return {
        "renderer": {
            "name": "render_preview",
            "version": RENDERER_VERSION,
            "engine": "libreoffice+pdftoppm",
        },
        "libreoffice": {
            "command": soffice,
            **_command_version(soffice, "--version"),
        },
        "poppler": {
            "command": pdftoppm,
            **_command_version(pdftoppm, "-v"),
        },
        "tesseract": {
            "command": "tesseract",
            **_command_version("tesseract", "--version"),
        },
        "python": {
            "status": "available",
            "executable": sys.executable,
            "version": platform.python_version(),
        },
        "libraries": {
            "Pillow": _package_version("Pillow", "PIL"),
            "pytesseract": _package_version("pytesseract"),
            "numpy": _package_version("numpy"),
            "scikit-image": _package_version("scikit-image", "skimage"),
            "fontTools": _package_version("fonttools", "fontTools"),
        },
    }


def render(
    pptx: Path,
    output_dir: Path,
    width_px: int,
    height_px: int,
    relative_to: Path | None = None,
) -> dict:
    if not pptx.is_file():
        raise PreviewError("E_CONTRACT", f"PPTX not found: {pptx}")
    if not isinstance(width_px, int) or not isinstance(height_px, int) or width_px <= 0 or height_px <= 0:
        raise PreviewError("E_ARGUMENT", "width_px and height_px must be positive integers")
    soffice = binary("soffice", "libreoffice")
    pdftoppm = binary("pdftoppm")
    output_dir.mkdir(parents=True, exist_ok=True)
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
            "-scale-to-x",
            str(width_px),
            "-scale-to-y",
            str(height_px),
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
    for page in pages:
        try:
            with Image.open(page) as opened:
                actual = opened.size
        except Exception as error:
            raise PreviewError("E_RENDER_RUNTIME", f"cannot inspect preview page {page}: {error}") from error
        if actual != (width_px, height_px):
            raise PreviewError(
                "E_RENDER_SIZE_MISMATCH",
                f"preview page {page.name} has size {actual[0]}x{actual[1]}, "
                f"expected {width_px}x{height_px}",
            )
    def display(path: Path) -> str:
        if relative_to:
            return path.resolve().relative_to(relative_to.resolve()).as_posix()
        return str(path.resolve())

    return {
        "status": "ok",
        "engine": "libreoffice+pdftoppm",
        "requestedSize": {"width": width_px, "height": height_px, "unit": "px"},
        "pdf": display(pdf),
        "pages": [display(path) for path in pages],
        "runtime": runtime_report(soffice, pdftoppm),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--width-px", type=int, required=True)
    parser.add_argument("--height-px", type=int, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--relative-to", type=Path)
    args = parser.parse_args()
    try:
        result = render(
            args.pptx,
            args.output_dir,
            args.width_px,
            args.height_px,
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
