import json
import sys
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import layer_recovery as layers  # noqa: E402


class LayerRecoveryTest(unittest.TestCase):
    def test_alpha_mask_is_authoritative_and_digest_is_stable(self):
        image = Image.new("RGBA", (4, 2), (20, 30, 40, 0))
        image.putpixel((1, 0), (20, 30, 40, 255))
        image.putpixel((2, 1), (20, 30, 40, 9))
        mask = layers.foreground_mask(image, background=(20, 30, 40), tolerance=0)
        self.assertEqual(mask.mode, "L")
        self.assertEqual(mask.getpixel((0, 0)), 0)
        self.assertEqual(mask.getpixel((1, 0)), 0)  # same RGB as explicit background
        self.assertEqual(mask.getpixel((2, 1)), 0)  # alpha threshold is fail-closed
        alpha = layers.alpha_mask(image)
        self.assertEqual(alpha.getpixel((1, 0)), 255)
        self.assertEqual(layers.foreground_mask(image).getpixel((1, 0)), 255)
        self.assertEqual(layers.image_digest(image), layers.image_digest(image.copy()))

    def test_tolerant_components_and_contours_are_deterministic(self):
        image = Image.new("RGB", (8, 4), (250, 250, 250))
        draw = ImageDraw.Draw(image)
        draw.rectangle((1, 1, 2, 2), fill=(20, 20, 20))
        draw.point((3, 2), fill=(28, 28, 28))
        draw.rectangle((6, 1, 6, 1), fill=(100, 100, 100))
        first = layers.connected_components(image, tolerance=12, min_area=1, connectivity=4)
        second = layers.connected_components(image, tolerance=12, min_area=1, connectivity=4)
        self.assertEqual(first, second)
        dark = [item for item in first if item["box"]["x"] == 1]
        self.assertEqual(len(dark), 1)
        self.assertEqual(dark[0]["area"], 4)
        self.assertTrue(dark[0]["contour"])

    def test_occlusion_edges_and_order_use_explicit_z_then_geometry(self):
        components = [
            {"id": "outer", "type": "shape", "pixelBox": {"x": 0, "y": 0, "w": 20, "h": 20}},
            {"id": "inner", "type": "image", "pixelBox": {"x": 4, "y": 4, "w": 6, "h": 6}},
            {"id": "label", "type": "text", "pixelBox": {"x": 5, "y": 5, "w": 4, "h": 2}},
        ]
        result = layers.infer_layers(components)
        self.assertEqual(result["stableOrder"][0], "outer")
        self.assertLess(result["stableOrder"].index("inner"), result["stableOrder"].index("label"))
        self.assertTrue(any(edge["behind"] == "outer" and edge["front"] == "inner" for edge in result["occlusionEdges"]))
        self.assertTrue(all(result["stableOrder"].count(identifier) == 1 for identifier in ("outer", "inner", "label")))

    def test_small_flat_non_text_hole_is_repaired_with_provenance(self):
        image = Image.new("RGB", (24, 24), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((2, 2, 21, 21), fill="black")
        draw.rectangle((8, 8, 10, 10), fill="white")
        mask = layers.foreground_mask(image, background="white", tolerance=10)
        result = layers.repair_background_holes(image, mask, tolerance=10, source_ref="slide-001")
        self.assertEqual(result.status, "repaired")
        self.assertEqual(result.image.getpixel((9, 9)), (0, 0, 0))
        self.assertEqual(result.repairs[0]["provenance"]["sourceRef"], "slide-001")
        self.assertEqual(result.repairs[0]["provenance"]["version"], layers.VERSION)
        json.dumps(result.to_dict())

    def test_text_overlap_and_large_holes_fail_closed(self):
        image = Image.new("RGB", (40, 40), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((2, 2, 37, 37), fill="black")
        draw.rectangle((8, 8, 15, 15), fill="white")
        draw.rectangle((20, 20, 24, 24), fill="white")
        mask = layers.foreground_mask(image, background="white", tolerance=10)
        result = layers.repair_background_holes(
            image,
            mask,
            tolerance=10,
            max_hole_area=16,
            text_boxes=[{"pixelBox": {"x": 7, "y": 7, "w": 10, "h": 10}}],
        )
        reasons = {item["reason"] for item in result.degradations}
        self.assertIn("hole-too-large", reasons)
        self.assertIn("text-overlap", reasons)
        self.assertNotEqual(result.image.getpixel((10, 10)), (0, 0, 0))

    def test_analyze_layers_is_json_serializable_and_reports_fail_closed(self):
        image = Image.new("RGB", (16, 16), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((1, 1, 14, 14), fill="black")
        draw.rectangle((5, 5, 6, 6), fill="white")
        report = layers.analyze_layers(image, source_ref="slide-007")
        self.assertEqual(report["background"]["mode"], "solid")
        self.assertIn("repair", report["background"])
        self.assertIn("occlusionEdges", report)
        self.assertIn("stableOrder", report)
        self.assertEqual(report["provenance"]["coordinateSpace"], "pixels")
        json.dumps(report)


if __name__ == "__main__":
    unittest.main()
