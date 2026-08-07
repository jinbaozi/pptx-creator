import importlib.util
import sys
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
ANALYZE = SCRIPTS / "analyze_images.py"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("analyze_images_region_tests", ANALYZE)
assert spec and spec.loader
analyze_images = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = analyze_images
spec.loader.exec_module(analyze_images)


class FakeProvider(analyze_images.OcrProvider):
    name = "fake"

    def __init__(self):
        self.calls = []

    def recognize(self, image, langs, psm):
        self.calls.append((langs, psm, image.mode))
        return {
            "text": ["Title"],
            "conf": [95],
            "left": [1],
            "top": [1],
            "width": [30],
            "height": [10],
        }


class RegionOcrTest(unittest.TestCase):
    def test_role_psm_routing_and_bounded_candidates(self):
        self.assertEqual(analyze_images.psm_for_role("title"), 7)
        self.assertEqual(analyze_images.psm_for_role("body"), 6)
        self.assertEqual(analyze_images.psm_for_role("label"), 8)
        self.assertEqual(analyze_images.psm_for_role("number"), 10)
        self.assertEqual(analyze_images.psm_for_role("caption"), 13)
        candidates = analyze_images.preprocessing_candidates(Image.new("RGB", (80, 30)), "title", 99)
        self.assertEqual(len(candidates), analyze_images.MAX_REGION_OCR_CANDIDATES)

    def test_region_provider_selects_one_candidate_and_records_psm(self):
        image = Image.new("RGB", (160, 80), "white")
        provider = FakeProvider()
        lines, report = analyze_images.regional_ocr(
            image,
            [{"text": "Title", "confidence": 0.8, "pixelBox": {"x": 10, "y": 5, "w": 50, "h": 15}}],
            "eng",
            provider=provider,
            max_candidates=1,
            page_budget=1,
        )
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(provider.calls[0][1], 7)
        self.assertEqual(report[0]["candidateCount"], 1)
        self.assertEqual(lines[0]["text"], "Title")
        self.assertEqual(lines[0]["recognitionPass"], "region-psm-7-original")

    def test_region_budget_prioritizes_title_and_defers_dense_tail(self):
        image = Image.new("RGB", (240, 120), "white")
        provider = FakeProvider()
        lines = [
            {"text": "Title", "confidence": 0.8, "pixelBox": {"x": 10, "y": 4, "w": 70, "h": 15}},
            *[
                {"text": f"body {index}", "confidence": 0.2, "pixelBox": {"x": 10, "y": 20 + index * 12, "w": 60, "h": 10}}
                for index in range(5)
            ],
        ]
        selected, report = analyze_images.regional_ocr(
            image,
            lines,
            "eng",
            provider=provider,
            max_candidates=1,
            page_budget=2,
        )
        self.assertLessEqual(len(provider.calls), 2)
        self.assertEqual(report[-1]["kind"], "summary")
        self.assertEqual(report[-1]["budgetLimit"], 2)
        self.assertEqual(report[-1]["deferredCount"], 4)
        self.assertEqual(selected[0]["regionOcrStatus"], "selected")
        self.assertEqual(selected[-1]["regionOcrStatus"], "budget-deferred")

    def test_language_resolution_is_explicit_and_auto_evidence_bound(self):
        resolved, evidence = analyze_images.resolve_language_request(
            "eng", {"eng", "chi_sim"}, {"status": "ok", "script": "Han", "source": "test"}
        )
        self.assertEqual(resolved, ["eng"])
        self.assertEqual(evidence["mapping"], "explicit-request")
        resolved, evidence = analyze_images.resolve_language_request(
            "auto", {"eng", "chi_sim"}, {"status": "ok", "script": "Han", "source": "test"}
        )
        self.assertEqual(resolved, ["chi_sim", "eng"])
        self.assertEqual(evidence["mapping"], "osd-script:han->chi_sim+eng")
        with self.assertRaises(analyze_images.AnalysisError) as caught:
            analyze_images.resolve_language_request(
                "auto", {"eng"}, {"status": "ok", "script": "Han", "source": "test"}
            )
        self.assertEqual(caught.exception.code, "E_OCR_RUNTIME")
        with self.assertRaises(analyze_images.AnalysisError) as caught:
            analyze_images.resolve_language_request(
                "auto", {"eng"}, {"status": "unavailable", "script": None, "source": "test"}
            )
        self.assertIn("--langs eng", str(caught.exception))

    def test_page_profile_and_region_profiles_are_repeatable(self):
        image = Image.new("RGB", (100, 50), "white")
        objects = [
            {"id": "text-1", "type": "text", "pixelBox": {"x": 5, "y": 5, "w": 40, "h": 10}, "confidence": 0.9, "z": 0},
            {"id": "shape-1", "type": "shape", "pixelBox": {"x": 50, "y": 20, "w": 30, "h": 20}, "confidence": 1, "z": 1},
        ]
        lines = [{"id": "text-1", "text": "Title", "pixelBox": objects[0]["pixelBox"], "regionRole": "title"}]
        first = analyze_images.build_page_profile(image, objects, lines, [], [])
        second = analyze_images.build_page_profile(image, objects, lines, [], [])
        self.assertEqual(first, second)
        groups = [{"id": "layout-group-001", "role": "text-block", "pixelBox": {"x": 5, "y": 5, "w": 75, "h": 35}, "memberIds": ["text-1", "shape-1"], "confidence": 0.8}]
        profiles = analyze_images.build_region_profiles("slide-001", "source-001", objects, lines, groups, image.size)
        self.assertEqual([profile["id"] for profile in profiles], ["slide-001-region-001"])
        self.assertEqual(profiles[0]["memberIds"], ["text-1", "shape-1"])
        self.assertEqual(profiles[0]["objectCount"], 2)
        self.assertEqual(profiles[0]["role"], "title")

    def test_page_profile_prefers_structure_and_exposes_auditable_metrics(self):
        image = Image.new("RGB", (200, 100), "white")
        objects = [
            {"id": "shape-1", "type": "shape", "pixelBox": {"x": 10, "y": 20, "w": 40, "h": 20}, "confidence": 1, "z": 0},
            {"id": "shape-2", "type": "shape", "pixelBox": {"x": 80, "y": 20, "w": 40, "h": 20}, "confidence": 1, "z": 1},
            {"id": "shape-3", "type": "shape", "pixelBox": {"x": 150, "y": 20, "w": 40, "h": 20}, "confidence": 1, "z": 2},
            {"id": "connector-1", "type": "connector", "pixelBox": {"x": 50, "y": 30, "w": 30, "h": 2}, "confidence": 1, "z": 3},
        ]
        profile = analyze_images.build_page_profile(
            image,
            objects,
            [{"text": "A", "pixelBox": {"x": 10, "y": 5, "w": 20, "h": 8}}] * 8,
            [],
            [],
            groups=[{"id": "g", "memberIds": [item["id"] for item in objects]}],
        )
        self.assertEqual(profile["pageType"], "flowchart")
        for metric in ("textDensity", "flatColorRatio", "photoRatio", "repeatedComponentScore", "layoutComplexity"):
            self.assertIn(metric, profile)
        self.assertEqual(profile["metricEvidence"][-1]["signal"], "classification")


if __name__ == "__main__":
    unittest.main()
