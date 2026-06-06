import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from crop_core import crop_assets, load_crops_file  # noqa: E402

SAMPLE_DIR = ROOT / "examples" / "image-input"
SAMPLE_IMAGE = SAMPLE_DIR / "business-slide.png"
GENERATOR = ROOT / "scripts" / "generate-sample-slide.py"
CROP_CLI = ROOT / "scripts" / "crop-assets.py"


def ensure_sample_image() -> None:
    if SAMPLE_IMAGE.exists():
        return
    subprocess.run([sys.executable, str(GENERATOR)], cwd=ROOT, check=True)


class CropAssetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def test_load_crops_file_array_and_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            array_path = Path(tmp) / "array.json"
            array_path.write_text(json.dumps([{"id": "a", "x": 0, "y": 0, "w": 10, "h": 10}]), encoding="utf-8")
            self.assertEqual(len(load_crops_file(array_path)), 1)

            object_path = Path(tmp) / "object.json"
            object_path.write_text(json.dumps({"crops": [{"id": "b", "x": 1, "y": 1, "w": 5, "h": 5}]}), encoding="utf-8")
            self.assertEqual(load_crops_file(object_path)[0]["id"], "b")

    def test_crop_assets_writes_png(self):
        crops = [{"id": "header-band", "x": 0, "y": 0, "w": 400, "h": 120, "unit": "px"}]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "assets"
            data = crop_assets(SAMPLE_IMAGE, crops, out)
            self.assertEqual(data["assetCount"], 1)
            png = out / "header-band.png"
            self.assertTrue(png.exists())
            self.assertGreater(png.stat().st_size, 100)

    def test_crop_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            crops_path = Path(tmp) / "crops.json"
            crops_path.write_text(
                json.dumps([{"id": "icon", "x": 100, "y": 100, "w": 80, "h": 80}]),
                encoding="utf-8",
            )
            out = Path(tmp) / "out"
            result = subprocess.run(
                [sys.executable, str(CROP_CLI), str(SAMPLE_IMAGE), str(crops_path), str(out)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((out / "icon.png").exists())


if __name__ == "__main__":
    unittest.main()
