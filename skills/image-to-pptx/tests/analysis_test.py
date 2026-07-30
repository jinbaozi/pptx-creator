import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ANALYZE = ROOT / "scripts" / "analyze_images.py"
MINIMAL = ROOT / "examples" / "minimal" / "input.png"


class AnalysisTest(unittest.TestCase):
    def run_analysis(self, images, threshold=0.70):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        copied = []
        sources = root / "sources"
        sources.mkdir()
        for index, image in enumerate(images, 1):
            target = sources / f"slide-{index:03d}.png"
            target.write_bytes(Path(image).read_bytes())
            copied.append(target)
        output = root / "analysis.json"
        ocr = root / "ocr-report.json"
        result = subprocess.run([
            sys.executable,
            str(ANALYZE),
            *map(str, copied),
            "--package-root", str(root),
            "--output", str(output),
            "--ocr-report", str(ocr),
            "--assets-dir", str(root / "assets"),
            "--annotations-dir", str(root / "reports" / "low-confidence"),
            "--langs", "eng",
            "--ocr-threshold", str(threshold),
        ], capture_output=True, text=True, check=False)
        return temporary, root, result

    def test_analysis_emits_editable_text_shapes_and_source_digests(self):
        temporary, root, result = self.run_analysis([MINIMAL])
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((root / "analysis.json").read_text())
        self.assertEqual(data["version"], "1.0.0")
        self.assertEqual(data["kind"], "image-reconstruction-analysis")
        types = {item["type"] for item in data["slides"][0]["objects"]}
        self.assertIn("text", types)
        self.assertIn("shape", types)
        self.assertIn("connector", types)
        self.assertFalse(data["editabilityTarget"]["wholeSlideRasterAllowed"])
        self.assertEqual(len(data["sources"][0]["sha256"]), 64)
        self.assertTrue((root / data["slides"][0]["annotation"]).is_file())

    def test_threshold_one_preserves_uncertain_text_as_local_crops(self):
        temporary, root, result = self.run_analysis([MINIMAL], threshold=1.0)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((root / "analysis.json").read_text())
        self.assertTrue(any(item["reason"] == "low-confidence-ocr" for item in data["degradations"]))
        self.assertFalse(any(item["type"] == "text" for item in data["slides"][0]["objects"]))

    def test_mixed_page_ratios_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            square = Path(temporary) / "square.png"
            Image.new("RGB", (400, 400), "white").save(square)
            managed, _, result = self.run_analysis([MINIMAL, square])
            self.addCleanup(managed.cleanup)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("E_PAGE_RATIO_MISMATCH", result.stderr)


if __name__ == "__main__":
    unittest.main()
