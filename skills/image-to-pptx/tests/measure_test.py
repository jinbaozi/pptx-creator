import importlib.util
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("measure_visual", ROOT / "scripts" / "measure_visual.py")
MEASURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEASURE)


class MeasureTest(unittest.TestCase):
    def test_cer_charges_missing_and_extra_characters(self):
        self.assertEqual(MEASURE.cer("ABC", "ABC"), 0)
        self.assertGreater(MEASURE.cer("ABC", "AB"), 0)
        self.assertGreater(MEASURE.cer("ABC", "ABCD"), 0)
        self.assertEqual(MEASURE.cer("", "EXTRA"), 1.0)

    def test_ocr_evidence_keeps_global_extras_and_local_small_labels(self):
        localized = [
            {"text": "TITLE"},
            {"text": "Q1 Q2 Q3 Q4"},
        ]
        merged = MEASURE.merge_ocr_evidence("TITLE UNDECLARED Q1", localized)
        self.assertEqual(merged, "TITLE UNDECLARED Q1 Q2 Q3 Q4")
        self.assertGreater(MEASURE.cer("TITLE Q1 Q2 Q3 Q4", merged), 0)
        evidence = MEASURE.ocr_evidence_cer(
            "TITLE Q1 Q2 Q3 Q4",
            "TITLE UNDECLARED",
            localized,
            [{"text": "TITLE Q1 Q2 Q3 Q4"}],
        )
        self.assertGreater(evidence, 0.02)

    def test_region_category_is_stable_for_native_and_raster_objects(self):
        self.assertEqual(MEASURE.region_category({"type": "text"}), "text")
        self.assertEqual(MEASURE.region_category({"type": "shape"}), "shape")
        self.assertEqual(MEASURE.region_category({"type": "connector"}), "shape")
        self.assertEqual(MEASURE.region_category({"type": "image"}), "image")

    def test_calibration_uses_measured_translation_height_and_spacing(self):
        expected = [{
            "id": "text-001",
            "text": "VISIBLE TEXT",
            "pixelBox": {"x": 100, "y": 50, "w": 180, "h": 20},
        }]
        rendered = [{
            "id": "text-001",
            "text": "VISIBLE TEXT",
            "pixelBox": {"x": 104, "y": 54, "w": 165, "h": 24},
        }]
        ious, adjustments, matched, recognized = MEASURE.match_text(expected, rendered)
        self.assertEqual(matched, 1)
        self.assertEqual(recognized, ["VISIBLE TEXT"])
        self.assertLess(ious[0], 0.90)
        self.assertEqual(adjustments[0]["dx"], -4)
        self.assertEqual(adjustments[0]["dy"], -4)
        self.assertLess(adjustments[0]["fontScale"], 1)
        self.assertGreater(adjustments[0]["charSpacingDeltaPt"], 0)

    def test_equal_boxes_clear_bbox_gate(self):
        box = {"x": 100, "y": 50, "w": 180, "h": 20}
        expected = [{"id": "text-001", "text": "VISIBLE TEXT", "pixelBox": box}]
        rendered = [{"id": "text-001", "text": "VISIBLE TEXT", "pixelBox": box}]
        ious, _, matched, _ = MEASURE.match_text(expected, rendered)
        self.assertEqual(matched, 1)
        self.assertGreaterEqual(ious[0], 0.99)
        self.assertTrue(MEASURE.pass_metric("bboxIou", ious[0]))

    def test_shape_geometry_is_measured_from_render_pixels(self):
        with tempfile.TemporaryDirectory(prefix="image-region-measure-") as temporary:
            root = Path(temporary)
            source_path = root / "source.png"
            render_path = root / "render.png"
            source = Image.new("RGB", (100, 80), "white")
            render = Image.new("RGB", (100, 80), "white")
            ImageDraw.Draw(source).rectangle((20, 20, 49, 39), fill="#2F80ED")
            ImageDraw.Draw(render).rectangle((24, 23, 53, 42), fill="#2F80ED")
            source.save(source_path)
            render.save(render_path)
            slide = {
                "sizePx": {"width": 100, "height": 80},
                "objects": [{
                    "id": "shape-001",
                    "type": "shape",
                    "pixelBox": {"x": 20, "y": 20, "w": 30, "h": 20},
                    "z": 0,
                }],
            }
            reports, _, adjustments = MEASURE.object_diagnostics(
                source_path, render_path, slide, []
            )
            self.assertEqual(reports[0]["geometryMeasurement"]["status"], "measured")
            self.assertEqual(reports[0]["renderedBox"], {"x": 24, "y": 23, "w": 30, "h": 20})
            self.assertEqual(adjustments[0]["dx"], -4)
            self.assertEqual(adjustments[0]["dy"], -3)


if __name__ == "__main__":
    unittest.main()
