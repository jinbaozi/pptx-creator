import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATE = ROOT / "scripts" / "generate_examples.py"
FIXTURE = ROOT / "tests" / "fixtures" / "object-level-benchmark"
REFERENCE = FIXTURE / "reference.png"
MANIFEST = FIXTURE / "manifest.json"
TRUTH = FIXTURE / "ground-truth.json"
ANALYZE = ROOT / "scripts" / "analyze_images.py"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def iou(left: dict, right: dict) -> float:
    left_right = min(left["x"] + left["w"], right["x"] + right["w"])
    left_bottom = min(left["y"] + left["h"], right["y"] + right["h"])
    width = max(0, left_right - max(left["x"], right["x"]))
    height = max(0, left_bottom - max(left["y"], right["y"]))
    intersection = width * height
    union = left["w"] * left["h"] + right["w"] * right["h"] - intersection
    return intersection / max(1, union)


class ObjectBenchmarkTest(unittest.TestCase):
    def test_fixture_regenerates_byte_for_byte_and_manifest_is_closed(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        truth = json.loads(TRUTH.read_text(encoding="utf-8"))
        self.assertEqual(manifest["id"], truth["id"])
        self.assertFalse(manifest["deterministic"]["network"])
        self.assertIsNone(manifest["deterministic"]["model"])
        self.assertTrue(REFERENCE.is_file())
        self.assertTrue((FIXTURE / manifest["fixture"]["groundTruth"]).is_file())
        self.assertEqual(len({item["id"] for item in truth["objects"]}), len(truth["objects"]))
        for item in truth["objects"]:
            self.assertRegex(item["id"], r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
            self.assertGreater(item["box"]["w"], 0)
            self.assertGreater(item["box"]["h"], 0)
            self.assertGreaterEqual(item["z"], 0)
            self.assertIn("text", item)
            self.assertIn("style", item)
            self.assertIn("relations", item)
            self.assertIn("recoverability", item)

        with tempfile.TemporaryDirectory(prefix="image-to-pptx-benchmark-generate-") as first, tempfile.TemporaryDirectory(prefix="image-to-pptx-benchmark-generate-") as second:
            for output in (first, second):
                result = subprocess.run(
                    [sys.executable, str(GENERATE), "--output-root", output],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            first_fixture = Path(first) / "tests" / "fixtures" / "object-level-benchmark"
            second_fixture = Path(second) / "tests" / "fixtures" / "object-level-benchmark"
            for name in ("reference.png", "ground-truth.json", "manifest.json"):
                self.assertEqual(digest(first_fixture / name), digest(second_fixture / name), name)

    def test_analyzer_meets_object_level_recall_without_whole_slide_raster(self):
        if shutil.which("tesseract") is None:
            self.skipTest("tesseract is required for the source-bound benchmark")
        try:
            import pytesseract  # noqa: F401
        except ImportError:
            self.skipTest("pytesseract is required for the source-bound benchmark")

        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        truth = json.loads(TRUTH.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(prefix="image-to-pptx-object-analysis-") as temporary:
            root = Path(temporary)
            source = root / REFERENCE.name
            source.write_bytes(REFERENCE.read_bytes())
            result = subprocess.run(
                [
                    sys.executable,
                    str(ANALYZE),
                    str(source),
                    "--package-root",
                    str(root),
                    "--output",
                    str(root / "analysis.json"),
                    "--ocr-report",
                    str(root / "ocr-report.json"),
                    "--assets-dir",
                    str(root / "assets"),
                    "--annotations-dir",
                    str(root / "reports" / "low-confidence"),
                    "--langs",
                    "eng",
                    "--ocr-threshold",
                    "0.70",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            analysis = json.loads((root / "analysis.json").read_text(encoding="utf-8"))
            slide = analysis["slides"][0]
            self.assertFalse(analysis["editabilityTarget"]["wholeSlideRasterAllowed"])
            types = {item["type"] for item in slide["objects"]}
            self.assertTrue({"shape", "text"}.issubset(types))
            self.assertGreaterEqual(len(slide.get("componentCandidates", [])), 1)

            required = [item for item in truth["objects"] if item["match"]["required"]]
            region_iou = manifest["evaluation"]["requiredRegionIoU"]
            candidates = []
            for expected_index, expected in enumerate(required):
                self.assertGreaterEqual(expected["match"]["minIoU"], region_iou)
                for observed_index, observed in enumerate(slide["objects"]):
                    if observed["type"] not in expected["match"]["types"]:
                        continue
                    overlap = iou(expected["box"], observed["pixelBox"])
                    if overlap >= expected["match"]["minIoU"]:
                        candidates.append((overlap, expected_index, observed_index))

            matched_expected = set()
            matched_observed = set()
            for _, expected_index, observed_index in sorted(candidates, reverse=True):
                if expected_index in matched_expected or observed_index in matched_observed:
                    continue
                matched_expected.add(expected_index)
                matched_observed.add(observed_index)

            matched = len(matched_expected)
            recall = matched / max(1, len(required))
            self.assertGreaterEqual(recall, manifest["evaluation"]["requiredObjectRecall"])


if __name__ == "__main__":
    unittest.main()
