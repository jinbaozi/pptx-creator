import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "render_preview", ROOT / "scripts" / "render_preview.py"
)
RENDER_PREVIEW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RENDER_PREVIEW)


class RenderPreviewTest(unittest.TestCase):
    def _run_renderer(self, page_size):
        calls = []

        def fake_run(command_args, **kwargs):
            command, *args = command_args
            calls.append([command, *args])
            if command == "/fake/soffice":
                if "--version" in args:
                    return subprocess.CompletedProcess(command, 0, "LibreOffice 24.2", "")
                outdir = Path(args[args.index("--outdir") + 1])
                pptx = Path(args[-1])
                (outdir / f"{pptx.stem}.pdf").write_bytes(b"%PDF-1.4\n")
                return subprocess.CompletedProcess(command, 0, "", "")
            if command == "/fake/pdftoppm":
                if "-v" in args:
                    return subprocess.CompletedProcess(command, 0, "", "pdftoppm version 24.2")
                prefix = Path(args[-1])
                Image.new("RGB", page_size, "white").save(prefix.parent / "slide-1.png")
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "version 1", "")

        return calls, fake_run

    def test_renderer_passes_both_dimensions_and_reports_exact_size(self):
        with tempfile.TemporaryDirectory(prefix="image-render-preview-") as temporary:
            root = Path(temporary)
            pptx = root / "candidate.pptx"
            pptx.write_bytes(b"candidate")
            calls, fake_run = self._run_renderer((320, 180))
            with patch.object(RENDER_PREVIEW, "binary", side_effect=["/fake/soffice", "/fake/pdftoppm"]), patch.object(
                RENDER_PREVIEW.subprocess, "run", side_effect=fake_run
            ):
                report = RENDER_PREVIEW.render(pptx, root / "preview", 320, 180)
            pdftoppm_call = next(call for call in calls if call[0] == "/fake/pdftoppm")
            self.assertEqual(
                pdftoppm_call[pdftoppm_call.index("-scale-to-x") : pdftoppm_call.index("-scale-to-y") + 2],
                ["-scale-to-x", "320", "-scale-to-y", "180"],
            )
            self.assertEqual(report["requestedSize"], {"width": 320, "height": 180, "unit": "px"})
            self.assertEqual(
                set(report["runtime"]),
                {"renderer", "libreoffice", "poppler", "tesseract", "python", "libraries"},
            )

    def test_renderer_fails_with_stable_size_error_without_rescaling(self):
        with tempfile.TemporaryDirectory(prefix="image-render-size-error-") as temporary:
            root = Path(temporary)
            pptx = root / "candidate.pptx"
            pptx.write_bytes(b"candidate")
            calls, fake_run = self._run_renderer((319, 180))
            with patch.object(RENDER_PREVIEW, "binary", side_effect=["/fake/soffice", "/fake/pdftoppm"]), patch.object(
                RENDER_PREVIEW.subprocess, "run", side_effect=fake_run
            ):
                with self.assertRaises(RENDER_PREVIEW.PreviewError) as context:
                    RENDER_PREVIEW.render(pptx, root / "preview", 320, 180)
            self.assertEqual(context.exception.code, "E_RENDER_SIZE_MISMATCH")
            pdftoppm_call = next(call for call in calls if call[0] == "/fake/pdftoppm")
            self.assertNotIn("-r", pdftoppm_call)


if __name__ == "__main__":
    unittest.main()
