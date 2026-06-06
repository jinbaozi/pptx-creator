import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from preview_core import compare_images, libreoffice_status, render_pptx_preview  # noqa: E402

SAMPLE_DIR = ROOT / "examples" / "image-input"
SAMPLE_IMAGE = SAMPLE_DIR / "business-slide.png"
GENERATOR = ROOT / "scripts" / "generate-sample-slide.py"
SMOKE_PPTX = ROOT / ".pptx-creator" / "smoke" / "final.pptx"
COMPARE_CLI = ROOT / "scripts" / "compare-preview.py"
RENDER_CLI = ROOT / "scripts" / "render-preview.py"


def ensure_sample_image() -> None:
    if SAMPLE_IMAGE.exists():
        return
    subprocess.run([sys.executable, str(GENERATOR)], cwd=ROOT, check=True)


class PreviewCoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def test_libreoffice_status_structure(self):
        status = libreoffice_status()
        self.assertIn(status["status"], {"deferred", "available"})

    def test_compare_images_identical(self):
        data = compare_images(SAMPLE_IMAGE, SAMPLE_IMAGE)
        self.assertEqual(data["verdict"], "close")
        self.assertEqual(data["meanAbsChannelDiff"], 0.0)
        self.assertTrue(data["sizeMatch"])

    def test_compare_images_different_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            from PIL import Image

            small = Path(tmp) / "small.png"
            Image.new("RGB", (320, 180), color=(30, 60, 90)).save(small)
            data = compare_images(SAMPLE_IMAGE, small)
            self.assertIn(data["verdict"], {"moderate", "divergent", "close"})
            self.assertFalse(data["sizeMatch"])

    def test_render_preview_smoke_pptx_optional(self):
        if not SMOKE_PPTX.exists():
            self.skipTest("smoke PPTX missing; run npm run setup first")
        with tempfile.TemporaryDirectory() as tmp:
            data = render_pptx_preview(SMOKE_PPTX, Path(tmp))
            self.assertIn(data["status"], {"ok", "deferred", "failed"})
            if data["status"] == "ok":
                self.assertGreater(data["previewCount"], 0)

    def test_compare_cli(self):
        result = subprocess.run(
            [sys.executable, str(COMPARE_CLI), str(SAMPLE_IMAGE), str(SAMPLE_IMAGE)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["verdict"], "close")

    def test_render_preview_cli_exit_code(self):
        if not SMOKE_PPTX.exists():
            self.skipTest("smoke PPTX missing")
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, str(RENDER_CLI), str(SMOKE_PPTX), tmp],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertIn(result.returncode, {0, 1, 2})


if __name__ == "__main__":
    unittest.main()
