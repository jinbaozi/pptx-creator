"""PPTX preview rendering and image comparison helpers."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

try:
    from PIL import Image, ImageChops, ImageStat
except ImportError:  # pragma: no cover
    Image = ImageChops = ImageStat = None  # type: ignore[misc, assignment]

PREVIEW_VERSION = "0.1.0"

WINDOWS_SOFFICE_PATHS = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]


def build_contact_sheet(previews: list[str], output_path: Path) -> dict[str, Any]:
    if Image is None:
        _fail("Pillow is required. Install with: pip install -r requirements-core.txt")
    if not previews:
        _fail("contact sheet requires at least one preview")
    images = []
    try:
        for preview in previews:
            images.append(Image.open(preview).convert("RGB"))
        thumb_width = 480
        thumb_height = round(thumb_width * images[0].height / images[0].width)
        columns = min(3, len(images))
        rows = (len(images) + columns - 1) // columns
        gutter, label_height = 24, 34
        width = gutter + columns * (thumb_width + gutter)
        height = gutter + rows * (thumb_height + label_height + gutter)
        sheet = Image.new("RGB", (width, height), color=(245, 246, 248))
        for index, image in enumerate(images):
            thumb = image.resize((thumb_width, thumb_height))
            x = gutter + (index % columns) * (thumb_width + gutter)
            y = gutter + (index // columns) * (thumb_height + label_height + gutter)
            sheet.paste(thumb, (x, y + label_height))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(output_path)
        return {"path": str(output_path.resolve()), "slideCount": len(images), "width": width, "height": height}
    finally:
        for image in images:
            image.close()


def _fail(message: str) -> None:
    raise ValueError(message)


def find_libreoffice() -> str | None:
    for candidate in ("soffice", "libreoffice"):
        found = shutil.which(candidate)
        if found:
            return found
    for path in WINDOWS_SOFFICE_PATHS:
        if Path(path).exists():
            return path
    return None


def libreoffice_status() -> dict[str, Any]:
    binary = find_libreoffice()
    if not binary:
        return {
            "status": "deferred",
            "binary": None,
            "note": (
                "LibreOffice headless not found. PPTX preview rendering is optional; "
                "install LibreOffice or open final.pptx manually."
            ),
        }
    return {
        "status": "available",
        "binary": binary,
        "note": "Use render-preview.py to convert PPTX slides to PNG.",
    }


def render_pptx_preview(pptx_path: Path, output_dir: Path) -> dict[str, Any]:
    pptx_path = pptx_path.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    lo = libreoffice_status()
    if lo["status"] != "available":
        return {
            "version": PREVIEW_VERSION,
            "source": pptx_path.name,
            "renderer": lo,
            "previews": [],
            "status": "deferred",
            "note": lo["note"],
        }

    env = os.environ.copy()
    env.setdefault("SAL_USE_VCLPLUGIN", "svp")
    with tempfile.TemporaryDirectory(prefix="pptx-lo-profile-") as profile:
        env["HOME"] = profile
        env["XDG_CONFIG_HOME"] = str(Path(profile) / ".config")
        result = subprocess.run(
            [lo["binary"], f"-env:UserInstallation={Path(profile).as_uri()}", "--headless", "--convert-to", "pdf", "--outdir", str(output_dir), str(pptx_path)],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
            env=env,
        )
    if result.returncode != 0:
        return {
            "version": PREVIEW_VERSION,
            "source": pptx_path.name,
            "renderer": lo,
            "previews": [],
            "status": "failed",
            "note": (result.stderr or result.stdout or "LibreOffice conversion failed").strip(),
        }

    pdf_path = output_dir / f"{pptx_path.stem}.pdf"
    converter = shutil.which("pdftoppm")
    if result.returncode == 0 and pdf_path.exists() and converter:
        raster = subprocess.run(
            [converter, "-png", "-r", "96", str(pdf_path), str(output_dir / "slide")],
            capture_output=True, text=True, check=False, timeout=120, env=env,
        )
        if raster.returncode != 0:
            result = raster
    previews = sorted(str(path) for path in output_dir.glob("slide-*.png"))
    contact_sheet = build_contact_sheet(previews, output_dir / "contact-sheet.png") if previews else None
    return {
        "version": PREVIEW_VERSION,
        "source": pptx_path.name,
        "renderer": lo,
        "previews": previews,
        "previewCount": len(previews),
        "contactSheet": contact_sheet,
        "status": "ok" if previews else "failed",
        "note": "Preview PNGs written to output directory.",
    }


def _resize_to_match(reference: Any, candidate: Any) -> Any:
    if reference.size == candidate.size:
        return candidate
    return candidate.resize(reference.size)


def compare_images(reference_path: Path, candidate_path: Path) -> dict[str, Any]:
    if Image is None:
        _fail("Pillow is required. Install with: pip install -r requirements.txt")

    reference_path = reference_path.resolve()
    candidate_path = candidate_path.resolve()
    if not reference_path.exists():
        _fail(f"reference image not found: {reference_path}")
    if not candidate_path.exists():
        _fail(f"candidate image not found: {candidate_path}")

    with Image.open(reference_path) as ref_img, Image.open(candidate_path) as cand_img:
        ref = ref_img.convert("RGB")
        cand = _resize_to_match(ref, cand_img.convert("RGB"))
        diff = ImageChops.difference(ref, cand)
        ref_stat = ImageStat.Stat(ref)
        cand_stat = ImageStat.Stat(cand)
        diff_stat = ImageStat.Stat(diff)

    size_match = ref.size == cand_img.size
    mean_abs_diff = sum(diff_stat.mean) / 3.0
    extrema = diff_stat.extrema
    channel_index = max(range(len(extrema)), key=lambda i: extrema[i][1] - extrema[i][0])
    channel_low, channel_high = extrema[channel_index]
    ref_mean = [round(v, 2) for v in ref_stat.mean]
    cand_mean = [round(v, 2) for v in cand_stat.mean]

    return {
        "version": PREVIEW_VERSION,
        "reference": reference_path.name,
        "candidate": candidate_path.name,
        "referenceSize": {"width": ref.size[0], "height": ref.size[1]},
        "candidateSize": {"width": cand_img.size[0], "height": cand_img.size[1]},
        "sizeMatch": size_match,
        "meanRgbReference": ref_mean,
        "meanRgbCandidate": cand_mean,
        "meanAbsChannelDiff": round(mean_abs_diff, 4),
        "maxChannelDiff": {
            "channel": channel_index,
            "min": channel_low,
            "max": channel_high,
        },
        "verdict": "close" if mean_abs_diff < 12 else ("moderate" if mean_abs_diff < 40 else "divergent"),
        "note": "Deterministic pixel stats only; host agent judges visual fidelity.",
    }


def write_json(data: dict[str, Any], output_path: Path | None = None) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text + "\n", encoding="utf-8")
    return text
