import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("measure_visual", ROOT / "scripts" / "measure_visual.py")
MEASURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEASURE)


class MeasureTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
