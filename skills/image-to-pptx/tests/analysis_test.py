import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

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
        slide = data["slides"][0]
        self.assertTrue((root / slide["annotation"]).is_file())
        self.assertEqual(slide["layerAnalysis"]["kind"], "image-layer-analysis")
        self.assertEqual(slide["layerAnalysis"]["provenance"]["sourceRef"], data["sources"][0]["id"])
        self.assertEqual(slide["layerAnalysis"]["background"]["repairStatus"], "disabled")
        object_ids = [item["id"] for item in slide["objects"]]
        self.assertEqual(slide["sceneLayerGraph"]["stableOrder"], object_ids)
        self.assertEqual([item["z"] for item in slide["objects"]], list(range(len(object_ids))))

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

    def test_ocr_metadata_includes_polygon_reading_order_orientation_and_languages(self):
        temporary, root, result = self.run_analysis([MINIMAL])
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        analysis = json.loads((root / "analysis.json").read_text())
        report = json.loads((root / "ocr-report.json").read_text())
        self.assertEqual(analysis["ocr"]["requestedLanguages"], ["eng"])
        self.assertEqual(analysis["ocr"]["languages"], ["eng"])
        slide = analysis["slides"][0]
        self.assertIn(slide["orientation"]["status"], {"ok", "unavailable"})
        self.assertEqual(slide["languageMetadata"]["requested"], ["eng"])
        lines = report["slides"][0]["lines"]
        self.assertGreater(len(lines), 1)
        self.assertEqual(
            [line["readingOrder"] for line in lines],
            list(range(1, len(lines) + 1)),
        )
        for line in lines:
            self.assertEqual(len(line["polygon"]), 4)
            self.assertEqual(line["languages"], ["eng"])
            self.assertIn("orientation", line)
        self.assertTrue(all("polygon" in word for word in report["slides"][0]["words"]))

    def test_multicolor_bars_emit_geometry_only_chart_candidate(self):
        with tempfile.TemporaryDirectory() as source_dir:
            source = Path(source_dir) / "bars.png"
            image = Image.new("RGB", (1280, 720), "#FFFFFF")
            draw = ImageDraw.Draw(image)
            colors = ["#D98C5F", "#CF7442", "#B95D34", "#9F482C"]
            heights = [120, 200, 280, 360]
            for index, (color, height) in enumerate(zip(colors, heights)):
                left = 150 + index * 240
                draw.rectangle((left, 560 - height, left + 100, 560), fill=color)
            draw.line((100, 560, 1140, 560), fill="#64748B", width=3)
            image.save(source)
            temporary, root, result = self.run_analysis([source])
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        slide = json.loads((root / "analysis.json").read_text())["slides"][0]
        charts = [item for item in slide["componentCandidates"] if item["type"] == "chart"]
        self.assertEqual(len(charts), 1)
        chart = charts[0]
        self.assertEqual(chart["chartKind"], "bar")
        self.assertEqual(chart["dataStatus"], "geometry-only")
        self.assertIsNone(chart["data"])
        self.assertIsNone(chart["values"])
        self.assertGreaterEqual(len(chart["memberIds"]), 3)

    def test_grid_candidate_is_unresolved_without_synthetic_cell_data(self):
        with tempfile.TemporaryDirectory() as source_dir:
            source = Path(source_dir) / "grid.png"
            image = Image.new("RGB", (1280, 720), "#FFFFFF")
            draw = ImageDraw.Draw(image)
            for x in (120, 420, 720, 1020):
                draw.line((x, 100, x, 620), fill="#64748B", width=3)
            for y in (100, 280, 460, 620):
                draw.line((120, y, 1020, y), fill="#64748B", width=3)
            image.save(source)
            temporary, root, result = self.run_analysis([source])
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        slide = json.loads((root / "analysis.json").read_text())["slides"][0]
        tables = [item for item in slide["componentCandidates"] if item["type"] == "table"]
        self.assertEqual(len(tables), 1)
        table = tables[0]
        self.assertTrue(table["closedGrid"])
        self.assertEqual(table["cellAssignment"], "unresolved")
        self.assertEqual(table["dataStatus"], "not-recovered")
        self.assertIsNone(table["data"])
        self.assertGreaterEqual(table["rows"], 2)
        self.assertGreaterEqual(table["columns"], 2)

    def test_color_tolerance_joins_antialiased_near_colors(self):
        spec = importlib.util.spec_from_file_location("analyze_images", ANALYZE)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        image = Image.new("RGB", (120, 100), "#FFFFFF")
        pixels = image.load()
        for y in range(20, 80):
            for x in range(20, 100):
                pixels[x, y] = (51, 102, 153) if x < 60 else (57, 108, 159)
        shapes, connectors = module.exact_color_components(
            image,
            (255, 255, 255),
            tolerance=12,
        )
        self.assertEqual(len(connectors), 0)
        self.assertEqual(len(shapes), 1)
        self.assertEqual(shapes[0]["colorTolerancePx"], 12)
        self.assertIn(shapes[0]["color"], {"#336699", "#3C6FA2"})


if __name__ == "__main__":
    unittest.main()
