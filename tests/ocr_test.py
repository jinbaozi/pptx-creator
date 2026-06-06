import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from ocr_core import ocr_image, tesseract_info  # noqa: E402

SAMPLE_DIR = ROOT / "examples" / "image-input"
SAMPLE_IMAGE = SAMPLE_DIR / "business-slide.png"
GENERATOR = ROOT / "scripts" / "generate-sample-slide.py"
OCR_CLI = ROOT / "scripts" / "ocr-image.py"


def ensure_sample_image() -> None:
    if SAMPLE_IMAGE.exists():
        return
    subprocess.run([sys.executable, str(GENERATOR)], cwd=ROOT, check=True)


class OcrCoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def test_tesseract_info_structure(self):
        info = tesseract_info()
        self.assertIn(info["status"], {"deferred", "available"})
        self.assertIn("note", info)

    def test_ocr_image_returns_valid_document(self):
        data = ocr_image(SAMPLE_IMAGE)
        self.assertEqual(data["version"], "0.1.0")
        self.assertIn(data["status"], {"ok", "deferred"})
        self.assertIsInstance(data["textBlocks"], list)
        if data["status"] == "ok":
            self.assertGreater(data["blockCount"], 0)
            block = data["textBlocks"][0]
            self.assertIn("text", block)
            self.assertIn("pixelBox", block)

    def test_ocr_cli_exit_codes(self):
        result = subprocess.run(
            [sys.executable, str(OCR_CLI), str(SAMPLE_IMAGE)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertIn(result.returncode, {0, 2})
        payload = json.loads(result.stdout)
        self.assertIn("textBlocks", payload)


if __name__ == "__main__":
    unittest.main()
