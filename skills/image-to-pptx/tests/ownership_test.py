import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
ANALYZE = SCRIPTS / "analyze_images.py"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("analyze_images_ownership_tests", ANALYZE)
assert spec and spec.loader
analyze_images = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = analyze_images
spec.loader.exec_module(analyze_images)


def empty_masks(size):
    return {
        name: Image.new("L", size, 0)
        for name in ("background", "native_text", "native_shape", "raster_asset", "unresolved")
    }


class OwnershipTest(unittest.TestCase):
    def test_masks_are_disjoint_complete_and_repeatable(self):
        image = Image.new("RGB", (64, 48), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((4, 4, 18, 10), fill="black")
        draw.rectangle((44, 5, 54, 16), fill="#2E75B6")
        for x in range(25, 38):
            for y in range(24, 36):
                image.putpixel((x, y), ((x * 17) % 255, (y * 23) % 255, (x * y) % 255))
        lines = [{"pixelBox": {"x": 3, "y": 3, "w": 17, "h": 9}}]
        shapes = [{"pixelBox": {"x": 43, "y": 4, "w": 13, "h": 14}}]
        first = analyze_images.build_ownership_masks(image, lines, shapes, [])
        second = analyze_images.build_ownership_masks(image, lines, shapes, [])
        _, report, residuals = first
        _, repeat_report, repeat_residuals = second
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["totalPixels"], report["unionPixels"])
        self.assertEqual(report["classes"], repeat_report["classes"])
        self.assertEqual(len(residuals), len(repeat_residuals))
        self.assertTrue(residuals)
        residual = residuals[0]
        self.assertEqual(residual["pixelBox"], {"x": 25, "y": 24, "w": 13, "h": 12})
        self.assertEqual(analyze_images._mask_count(residual["_mask"]), 13 * 12)

    def test_transparent_crop_is_tight_and_excludes_native_claims(self):
        image = Image.new("RGB", (32, 24), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((2, 2, 8, 5), fill="black")
        draw.rectangle((20, 10, 25, 15), fill="#2E75B6")
        draw.rectangle((11, 17, 15, 20), fill="#D04A3A")
        masks, _, residuals = analyze_images.build_ownership_masks(
            image,
            [{"pixelBox": {"x": 1, "y": 1, "w": 9, "h": 6}}],
            [{"pixelBox": {"x": 19, "y": 9, "w": 8, "h": 8}}],
            [],
        )
        self.assertTrue(residuals)
        component = residuals[0]
        self.assertEqual(component["pixelBox"], {"x": 11, "y": 17, "w": 5, "h": 4})
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "crop.png"
            asset_digest, mask_digest = analyze_images.write_transparent_crop(
                image,
                component["_mask"],
                analyze_images.Box(**component["pixelBox"]),
                target,
            )
            self.assertEqual(len(asset_digest), 64)
            self.assertEqual(mask_digest, analyze_images._mask_digest(component["_mask"].crop((11, 17, 16, 21))))
            cropped = Image.open(target).convert("RGBA")
            self.assertEqual(cropped.size, (5, 4))
            self.assertTrue(all(alpha > 0 for alpha in cropped.getchannel("A").getdata()))
        self.assertGreaterEqual(analyze_images._mask_count(masks["native_text"]), 28)
        self.assertGreaterEqual(analyze_images._mask_count(masks["native_shape"]), 36)

    def test_low_confidence_raster_claim_is_excluded_from_native_text(self):
        image = Image.new("RGB", (40, 24), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((2, 2, 8, 5), fill="black")
        draw.rectangle((20, 10, 25, 15), fill="#2E75B6")
        draw.rectangle((11, 17, 15, 20), fill="#D04A3A")
        masks, _, residuals = analyze_images.build_ownership_masks(
            image,
            [{"id": "text-editable", "pixelBox": {"x": 1, "y": 1, "w": 9, "h": 6}}],
            [{"pixelBox": {"x": 19, "y": 9, "w": 8, "h": 8}}],
            [],
            raster_boxes=[
                {
                    "id": "text-low",
                    "pixelBox": {"x": 10, "y": 16, "w": 7, "h": 6},
                    "reason": "low-confidence-ocr",
                    "confidence": 0.2,
                }
            ],
        )
        low = [item for item in residuals if item.get("objectRef") == "text-low"]
        self.assertEqual(len(low), 1)
        self.assertGreater(analyze_images._mask_count(masks["raster_asset"]), 0)
        self.assertEqual(analyze_images._mask_count(masks["native_text"]), 28)
        self.assertIsNone(
            analyze_images.ImageChops.multiply(masks["raster_asset"], masks["native_text"]).getbbox()
        )
        self.assertIsNone(
            analyze_images.ImageChops.multiply(masks["raster_asset"], masks["native_shape"]).getbbox()
        )

    def test_local_ink_and_observed_shape_color_preserve_card_content(self):
        image = Image.new("RGB", (80, 50), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((10, 10, 70, 40), fill="#2E75B6")
        draw.rectangle((30, 22, 50, 28), fill="white")
        shape = {
            "id": "shape-card",
            "type": "shape",
            "pixelBox": {"x": 10, "y": 10, "w": 61, "h": 31},
            "color": "#2E75B6",
            "fill": True,
            "colorTolerancePx": 10,
        }
        line = {"id": "text-editable", "pixelBox": {"x": 29, "y": 21, "w": 23, "h": 9}}
        first = analyze_images.build_ownership_masks(image, [line], [shape], [])
        second = analyze_images.build_ownership_masks(image, [line], [shape], [])
        masks, report, residuals = first
        self.assertGreater(analyze_images._mask_count(masks["native_text"]), 0)
        self.assertGreater(analyze_images._mask_count(masks["native_shape"]), 0)
        self.assertEqual(report["classes"], second[1]["classes"])
        self.assertFalse(residuals)
        self.assertEqual(masks["native_text"].getpixel((35, 24)), 255)
        self.assertEqual(masks["native_shape"].getpixel((35, 24)), 0)
        self.assertEqual(masks["native_shape"].getpixel((12, 12)), 255)
        self.assertIsNone(
            analyze_images.ImageChops.multiply(masks["native_text"], masks["native_shape"]).getbbox()
        )

        low_masks, low_report, low_residuals = analyze_images.build_ownership_masks(
            image,
            [],
            [shape],
            [],
            raster_boxes=[
                {
                    "id": "text-low",
                    "pixelBox": line["pixelBox"],
                    "reason": "low-confidence-ocr",
                    "confidence": 0.2,
                }
            ],
        )
        low = [item for item in low_residuals if item.get("objectRef") == "text-low"]
        self.assertEqual(len(low), 1)
        self.assertEqual(analyze_images._mask_count(low_masks["native_text"]), 0)
        self.assertGreater(analyze_images._mask_count(low_masks["raster_asset"]), 0)
        self.assertEqual(low_masks["raster_asset"].getpixel((35, 24)), 255)
        self.assertEqual(low_masks["native_shape"].getpixel((35, 24)), 0)
        self.assertEqual(low_report["classes"], analyze_images.build_ownership_masks(
            image,
            [],
            [shape],
            [],
            raster_boxes=[
                {
                    "id": "text-low",
                    "pixelBox": line["pixelBox"],
                    "reason": "low-confidence-ocr",
                    "confidence": 0.2,
                }
            ],
        )[1]["classes"])

    def test_card_icon_color_remains_residual_not_shape_fill(self):
        image = Image.new("RGB", (80, 50), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((10, 10, 70, 40), fill="#2E75B6")
        draw.rectangle((35, 22, 44, 29), fill="#D04A3A")
        shape = {
            "id": "shape-card",
            "type": "shape",
            "pixelBox": {"x": 10, "y": 10, "w": 61, "h": 31},
            "color": "#2E75B6",
            "fill": True,
            "colorTolerancePx": 10,
        }
        masks, report, residuals = analyze_images.build_ownership_masks(image, [], [shape], [])
        self.assertGreater(analyze_images._mask_count(masks["raster_asset"]), 0)
        self.assertEqual(masks["native_shape"].getpixel((38, 24)), 0)
        self.assertEqual(masks["raster_asset"].getpixel((38, 24)), 255)
        self.assertEqual(report["classes"], analyze_images.build_ownership_masks(image, [], [shape], [])[1]["classes"])
        self.assertTrue(any(item["reason"] == "claimed-pixel-residual" for item in residuals))

    def test_ownership_error_codes_are_stable(self):
        masks = empty_masks((4, 4))
        masks["native_text"].putpixel((0, 0), 255)
        masks["native_shape"].putpixel((0, 0), 255)
        with self.assertRaises(analyze_images.AnalysisError) as caught:
            analyze_images.validate_ownership_masks(masks)
        self.assertEqual(caught.exception.code, "E_PIXEL_OWNERSHIP_CONFLICT")

        masks = empty_masks((4, 4))
        masks["native_text"].putpixel((0, 0), 255)
        masks["raster_asset"].putpixel((0, 0), 255)
        with self.assertRaises(analyze_images.AnalysisError) as caught:
            analyze_images.validate_ownership_masks(masks)
        self.assertEqual(caught.exception.code, "E_RASTER_NATIVE_TEXT_OVERLAP")

        masks = empty_masks((4, 4))
        masks["background"].putpixel((0, 0), 255)
        with self.assertRaises(analyze_images.AnalysisError) as caught:
            analyze_images.validate_ownership_masks(masks)
        self.assertEqual(caught.exception.code, "E_UNASSIGNED_PIXEL_BUDGET")

        analyze_images.validate_duplicate_visible_content(
            [
                {
                    "assetDigest": "a",
                    "maskDigest": "m",
                    "pagePixelBox": {"x": 0, "y": 0, "w": 2, "h": 2},
                },
                {
                    "assetDigest": "a",
                    "maskDigest": "m",
                    "pagePixelBox": {"x": 8, "y": 8, "w": 2, "h": 2},
                },
            ]
        )
        with self.assertRaises(analyze_images.AnalysisError) as caught:
            analyze_images.validate_duplicate_visible_content(
                [
                    {
                        "assetDigest": "a",
                        "maskDigest": "m",
                        "pagePixelBox": {"x": 0, "y": 0, "w": 2, "h": 2},
                    },
                    {
                        "assetDigest": "different",
                        "maskDigest": "m",
                        "pagePixelBox": {"x": 0, "y": 0, "w": 2, "h": 2},
                    },
                ]
            )
        self.assertEqual(caught.exception.code, "E_DUPLICATE_VISIBLE_CONTENT")


if __name__ == "__main__":
    unittest.main()
