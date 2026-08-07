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

    def test_ssim_contract_is_versioned_and_not_legacy_windowed(self):
        self.assertEqual(MEASURE.SSIM_METRIC, "pptx-creator-ssim")
        self.assertEqual(MEASURE.SSIM_VERSION, "2.0")
        self.assertEqual(
            MEASURE.ssim_metadata(),
            {
                "metric": "pptx-creator-ssim",
                "version": "2.0",
                "configuration": {
                    "implementation": "skimage.structural_similarity",
                    "dataRange": 255,
                    "gaussianWeights": True,
                    "sigma": 1.5,
                    "useSampleCovariance": False,
                    "channelAxis": 2,
                },
            },
        )
        self.assertFalse(hasattr(MEASURE, "windowed_ssim"))

    def test_ssim_repeated_measurement_is_deterministic(self):
        with tempfile.TemporaryDirectory(prefix="image-ssim-repeat-") as temporary:
            root = Path(temporary)
            source_path = root / "source.png"
            render_path = root / "render.png"
            image = Image.new("RGB", (64, 64), "white")
            ImageDraw.Draw(image).rectangle((8, 12, 52, 48), fill="#336699")
            image.save(source_path)
            image.save(render_path)
            first = MEASURE.pixel_metrics(source_path, render_path, root / "diff-1.png")
            second = MEASURE.pixel_metrics(source_path, render_path, root / "diff-2.png")
            self.assertEqual(first["ssim"], 1.0)
            self.assertEqual(first["ssim"], second["ssim"])
            self.assertEqual(first["ssimMetric"], MEASURE.ssim_metadata())

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

    def test_region_profile_metrics_are_measured_from_independent_crops_and_impact_is_exact(self):
        with tempfile.TemporaryDirectory(prefix="image-region-profile-") as temporary:
            root = Path(temporary)
            source_path = root / "source.png"
            render_path = root / "render.png"
            source = Image.new("RGB", (128, 96), "white")
            render = Image.new("RGB", (128, 96), "white")
            ImageDraw.Draw(source).rectangle((16, 16, 79, 63), fill="#336699")
            ImageDraw.Draw(render).rectangle((20, 18, 83, 65), fill="#336699")
            source.save(source_path)
            render.save(render_path)
            profile = {
                "id": "region-001",
                "role": "card-or-native-group",
                "pixelBox": {"x": 8, "y": 8, "w": 96, "h": 72},
                "objectRefs": ["shape-001"],
            }
            slide = {"sizePx": {"width": 128, "height": 96}, "objects": [{"id": "shape-001", "type": "shape", "pixelBox": {"x": 16, "y": 16, "w": 64, "h": 48}}]}
            reports = [{"id": "shape-001", "renderedBox": {"x": 20, "y": 18, "w": 64, "h": 48}}]
            original_crop_text = MEASURE._crop_text
            MEASURE._crop_text = lambda path, box, langs: ("VISIBLE", {"status": "measured", "method": "test"})
            try:
                measured = MEASURE.measure_region_profile(source_path, render_path, profile, slide, reports, "eng")
            finally:
                MEASURE._crop_text = original_crop_text
            self.assertEqual(measured["measurement"], "source-render-crop")
            self.assertNotEqual(measured.get("estimatedFrom"), "analysis")
            self.assertIsNotNone(measured["regionSSIM"])
            self.assertIsNotNone(measured["bboxIoU"])
            self.assertEqual(measured["ocrCER"], 0.0)
            expected = measured["areaShare"] * (1 - measured["regionSSIM"]) * measured["severityWeight"]
            self.assertAlmostEqual(measured["impact"], expected, places=6)

    def test_regional_palette_delta_uses_sorted_p95(self):
        original_palette = MEASURE._region_palette
        original_delta = MEASURE.delta_e_2000
        values = iter([9.0, 1.0, 5.0, 3.0])
        calls = {"count": 0}
        def palette(*_args):
            calls["count"] += 1
            return ([(1, 1, 1)] * 4 if calls["count"] == 1 else [(2, 2, 2)], {"status": "measured"})
        MEASURE._region_palette = palette
        MEASURE.delta_e_2000 = lambda *_args: next(values)
        try:
            value, status, impact = MEASURE._regional_palette_delta(Path("source.png"), Path("render.png"), {"x": 0, "y": 0, "w": 1, "h": 1})
        finally:
            MEASURE._region_palette = original_palette
            MEASURE.delta_e_2000 = original_delta
        self.assertEqual(value, 9.0)
        self.assertEqual(status["status"], "measured")
        self.assertEqual(impact["status"], "measured")

    def test_regional_bbox_is_unavailable_when_any_member_box_is_missing(self):
        value, status = MEASURE._region_bbox_iou(
            {"objectRefs": ["shape-001", "shape-002"]},
            [
                {"id": "shape-001", "pixelBox": {"x": 0, "y": 0, "w": 10, "h": 10}},
                {"id": "shape-002", "pixelBox": {"x": 20, "y": 0, "w": 10, "h": 10}},
            ],
            [{"id": "shape-001", "renderedBox": {"x": 0, "y": 0, "w": 10, "h": 10}}],
        )
        self.assertIsNone(value)
        self.assertEqual(status["status"], "unavailable")
        self.assertEqual(status["missingMembers"], ["shape-002"])

    def test_region_impact_order_is_stable_and_top_five_bounded(self):
        regions = [
            {"id": f"region-{index:03d}", "impact": impact, "impactStatus": {"status": "measured"}}
            for index, impact in [(5, 0.1), (1, 0.4), (3, 0.2), (2, 0.4), (4, 0.3), (6, 0.05), (7, 0.01)]
        ]
        first = [item["id"] for item in MEASURE.rank_error_regions(regions)]
        second = [item["id"] for item in MEASURE.rank_error_regions(list(reversed(regions)))]
        self.assertEqual(first, second)
        self.assertEqual(first, ["region-001", "region-002", "region-004", "region-003", "region-005"])
        self.assertLessEqual(len(first), 5)

    def test_route_trial_without_schema_bound_source_aspect_is_unavailable(self):
        slide = {
            "objects": [{"id": "image-001", "type": "image", "pixelBox": {"x": 0, "y": 0, "w": 100, "h": 100}, "asset": "assets/slide-001/image.png"}],
            "reconstructionPlan": {"regions": [{
                "id": "region-001",
                "assignedObjectRefs": ["image-001"],
                "winnerId": "region-001-native-plus-local-assets",
                "candidates": [
                    {"id": "region-001-native-all", "strategy": "native-all", "eligible": False},
                    {"id": "region-001-native-plus-local-assets", "strategy": "native-plus-local-assets", "eligible": True},
                    {"id": "region-001-bounded-raster", "strategy": "bounded-raster", "eligible": True},
                ],
            }]},
        }
        measured = [{"id": "region-001", "impact": 0.2, "impactStatus": {"status": "measured"}}]
        candidates = MEASURE.build_region_repair_candidates(slide, measured, [])
        route = next(item for item in candidates if item["action"] == "route-switch" and item["targetStrategy"] == "bounded-raster")
        self.assertEqual(route["status"], "unavailable")
        self.assertEqual(route["reason"], "no-source-asset-aspect-evidence")
        self.assertFalse(any(item["action"] == "route-switch" and item["status"] == "proposed" for item in candidates))

    def test_synthetic_adjustments_bind_to_regions_or_remain_unavailable(self):
        adjustments = [
            {"id": "__z-order__", "objectId": "shape-001", "zDelta": 1, "sourceBound": True},
            {"id": "__background__", "backgroundColor": "#112233", "sourceBound": True},
        ]
        profiles = [
            {"id": "region-shape", "role": "decor", "objectRefs": ["shape-001"]},
        ]
        MEASURE.bind_adjustment_regions(adjustments, profiles)
        self.assertEqual(adjustments[0]["regionId"], "region-shape")
        self.assertEqual(adjustments[0]["status"], "proposed")
        self.assertTrue(adjustments[0]["sourceBound"])
        self.assertEqual(adjustments[1]["status"], "unavailable")
        self.assertEqual(adjustments[1]["reason"], "background-region-profile-missing")
        self.assertFalse(adjustments[1]["sourceBound"])

        background = {"id": "__background__", "backgroundColor": "#112233", "sourceBound": True}
        MEASURE.bind_adjustment_regions(
            [background],
            [{"id": "region-bg", "role": "background", "objectRefs": []}],
        )
        self.assertEqual(background["regionId"], "region-bg")
        self.assertEqual(background["status"], "proposed")
        self.assertTrue(background["sourceBound"])


if __name__ == "__main__":
    unittest.main()
