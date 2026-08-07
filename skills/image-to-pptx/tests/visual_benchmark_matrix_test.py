"""Contract checks for the source-bound 55-sample visual benchmark."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "visual-benchmark-matrix"
MANIFEST_PATH = FIXTURE / "manifest.json"
GENERATOR_PATH = ROOT / "tests" / "generate_visual_benchmark.py"

SPEC = importlib.util.spec_from_file_location("visual_benchmark_generator", GENERATOR_PATH)
assert SPEC is not None and SPEC.loader is not None
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


REQUIRED_THRESHOLDS = {
    "ssim": (">=", 0.94),
    "cer": ("<=", 0.02),
    "bboxIoU": (">=", 0.90),
    "nativeTextRecall": (">=", 0.90),
    "paletteDeltaE2000P95": ("<=", 3.0),
    "editability": (">=", 3),
    "rasterAreaShare": ("<=", 0.65),
    "wholeSlideRaster": ("==", 0),
    "ownershipOverlap": ("==", 0),
    "ownershipConflict": ("==", 0),
    "sourceProvenance": ("==", True),
    "complexPageEditability": (">=", 4),
    "complexPageRasterAreaShare": ("<=", 0.35),
}


class VisualBenchmarkMatrixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        cls.samples = cls.manifest["samples"]

    def test_manifest_has_exact_55_samples_and_declared_quotas(self) -> None:
        self.assertEqual(self.manifest["counts"]["total"], 55)
        self.assertEqual(len(self.samples), 55)
        self.assertEqual(self.manifest["counts"]["categories"], GENERATOR.QUOTAS)
        self.assertEqual(self.manifest["quotas"], GENERATOR.QUOTAS)
        self.assertEqual(self.manifest["categoryQuotas"], GENERATOR.QUOTAS)
        observed: dict[str, int] = {}
        for sample in self.samples:
            observed[sample["category"]] = observed.get(sample["category"], 0) + 1
        self.assertEqual(observed, GENERATOR.QUOTAS)
        self.assertEqual(
            [sample["ordinal"] for sample in self.samples if sample["category"] == "zh-dense"],
            list(range(1, 11)),
        )
        for category, count in GENERATOR.QUOTAS.items():
            self.assertEqual(
                [sample["ordinal"] for sample in self.samples if sample["category"] == category],
                list(range(1, count + 1)),
            )

    def test_sources_exist_have_manifest_sha256_and_safe_relative_paths(self) -> None:
        ids = [sample["id"] for sample in self.samples]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(sample["id"] for sample in self.samples))
        for sample in self.samples:
            source = sample["source"]
            relative = Path(source["path"])
            self.assertFalse(relative.is_absolute(), source["path"])
            self.assertNotIn("..", relative.parts, source["path"])
            self.assertEqual(source["path"], relative.as_posix())
            path = (FIXTURE / relative).resolve()
            self.assertTrue(path.is_relative_to(FIXTURE.resolve()), source["path"])
            self.assertTrue(path.is_file(), source["path"])
            self.assertEqual(len(source["sha256"]), 64)
            self.assertEqual(source["sha256"], _sha256(path), source["path"])
            self.assertEqual(source["origin"], "programmatic-pillow")
            self.assertEqual(source["generatedBy"], GENERATOR.GENERATOR_ID)
            with self.subTest(sample=sample["id"]):
                from PIL import Image

                with Image.open(path) as image:
                    self.assertEqual(image.size, (sample["dimensions"]["width"], sample["dimensions"]["height"]))
                    self.assertEqual(image.format, "JPEG" if source["mediaType"] == "image/jpeg" else "PNG")

    def test_bundled_font_is_source_bound_and_license_is_present(self) -> None:
        font_meta = self.manifest["deterministic"]["font"]
        font_path = FIXTURE / font_meta["path"]
        license_path = FIXTURE / font_meta["license"]
        for relative in (font_meta["path"], font_meta["license"]):
            self.assertFalse(Path(relative).is_absolute())
            self.assertNotIn("..", Path(relative).parts)
        self.assertTrue(font_path.is_file())
        self.assertTrue(license_path.is_file())
        self.assertEqual(font_meta["sha256"], _sha256(font_path))
        self.assertIn("SIL OPEN FONT LICENSE", license_path.read_text(encoding="utf-8"))
        self.assertEqual(self.manifest["provenance"]["font"], font_meta)
        self.assertFalse(self.manifest["provenance"]["externalSourceImages"])
        self.assertNotIn("externalAssets", self.manifest["provenance"])
        self.assertEqual(self.manifest["provenance"]["bundledThirdPartyAssets"], [font_meta])
        self.assertTrue(font_meta["upstreamUrl"].startswith("https://"))
        self.assertEqual(font_meta["upstreamSha256"], GENERATOR.FONT_UPSTREAM_SHA256)
        self.assertEqual(font_meta["glyphSetSha256"], GENERATOR.FONT_GLYPH_SET_SHA256)

    def test_truth_text_is_covered_by_the_bundled_font_cmap(self) -> None:
        font_meta = self.manifest["deterministic"]["font"]
        font = TTFont(FIXTURE / font_meta["path"])
        cmap = set().union(*(table.cmap.keys() for table in font["cmap"].tables))
        self.assertEqual(
            hashlib.sha256(",".join(str(value) for value in sorted(cmap)).encode("ascii")).hexdigest(),
            font_meta["glyphSetSha256"],
        )
        missing: list[tuple[str, str]] = []
        for sample in self.samples:
            for text in sample["truth"]["text"]:
                missing.extend((sample["id"], character) for character in text if not character.isspace() and ord(character) not in cmap)
        self.assertEqual(missing, [])

    def test_generator_rebuild_matches_committed_source_digests_in_a_fresh_directory(self) -> None:
        # This compares a fresh output with the committed fixture, rather than
        # merely comparing two outputs in the same directory/environment.
        with tempfile.TemporaryDirectory(prefix="visual-benchmark-matrix-") as temporary:
            generated_dir = Path(temporary) / "visual-benchmark-matrix"
            generated = GENERATOR.build_manifest(generated_dir)
            generated_by_id = {sample["id"]: sample for sample in generated["samples"]}
            committed_by_id = {sample["id"]: sample for sample in self.samples}
            self.assertEqual(set(generated_by_id), set(committed_by_id))
            for sample_id, committed in committed_by_id.items():
                generated_sample = generated_by_id[sample_id]
                self.assertEqual(generated_sample["source"]["sha256"], committed["source"]["sha256"], sample_id)
                self.assertEqual(generated_sample["truth"], committed["truth"], sample_id)
                generated_source = generated_dir / generated_sample["source"]["path"]
                self.assertEqual(_sha256(generated_source), committed["source"]["sha256"], sample_id)

    def test_generator_is_byte_stable_across_two_fresh_outputs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="visual-benchmark-matrix-a-") as first, tempfile.TemporaryDirectory(
            prefix="visual-benchmark-matrix-b-"
        ) as second:
            first_manifest = GENERATOR.build_manifest(Path(first) / "fixture")
            second_manifest = GENERATOR.build_manifest(Path(second) / "fixture")
            first_digests = {sample["id"]: sample["source"]["sha256"] for sample in first_manifest["samples"]}
            second_digests = {sample["id"]: sample["source"]["sha256"] for sample in second_manifest["samples"]}
            self.assertEqual(first_digests, second_digests)
            self.assertEqual(first_manifest["deterministic"], second_manifest["deterministic"])

    def test_scenario_tag_coverage_is_complete(self) -> None:
        observed = {tag for sample in self.samples for tag in sample["scenarioTags"]}
        self.assertTrue(set(self.manifest["scenarioTagCoverage"]["required"]).issubset(observed))
        self.assertEqual(set(self.manifest["scenarioTagCoverage"]["observed"]), observed)
        self.assertTrue({"cjk", "text-dense"}.issubset(set(self.samples[0]["scenarioTags"])))
        self.assertTrue(any("mixed-script" in sample["scenarioTags"] for sample in self.samples))
        self.assertTrue(any("connectors" in sample["scenarioTags"] for sample in self.samples))
        self.assertTrue(any("table" in sample["scenarioTags"] for sample in self.samples))
        self.assertTrue(any("photo-like" in sample["scenarioTags"] for sample in self.samples))
        self.assertTrue(any("illustration" in sample["scenarioTags"] for sample in self.samples))
        self.assertTrue(any("gradient" in sample["scenarioTags"] for sample in self.samples))
        self.assertTrue(any("low-resolution" in sample["scenarioTags"] for sample in self.samples))
        self.assertTrue(any("portrait" in sample["scenarioTags"] for sample in self.samples))

    def test_strategy_routes_and_font_requirements_are_explicit(self) -> None:
        font_meta = self.manifest["deterministic"]["font"]
        for sample in self.samples:
            route = sample["acceptedStrategy"]["route"]
            self.assertIn(route, {"native-all", "native-plus-local-assets", "bounded-raster"})
            if sample["category"] in {"photography", "low-resolution"}:
                self.assertEqual(route, "native-plus-local-assets")
            elif sample["category"] == "effects":
                self.assertEqual(route, "bounded-raster")
            else:
                self.assertEqual(route, "native-all")
            requirement = sample["knownFontRequirements"][0]
            self.assertEqual(requirement["path"], font_meta["path"])
            self.assertEqual(requirement["family"], font_meta["family"])
            self.assertEqual(requirement["sha256"], font_meta["sha256"])
            self.assertEqual(requirement["license"], font_meta["license"])

    def test_thresholds_cannot_be_lowered_and_visual_results_are_not_claimed(self) -> None:
        thresholds = self.manifest["thresholds"]
        for name, (operator, required) in REQUIRED_THRESHOLDS.items():
            self.assertEqual(thresholds[name]["operator"], operator, name)
            actual = thresholds[name]["value"]
            if operator == ">=":
                self.assertGreaterEqual(actual, required, name)
            elif operator == "<=":
                self.assertLessEqual(actual, required, name)
            else:
                self.assertEqual(actual, required, name)
        self.assertEqual(self.manifest["evaluation"]["status"], "not-run")
        self.assertIsNone(self.manifest["evaluation"]["visualResults"])
        for sample in self.samples:
            self.assertEqual(sample["evaluation"]["status"], "not-run")
            self.assertIsNone(sample["evaluation"]["metrics"])
            features = sample["expectedFeatures"]
            self.assertFalse(features["wholeSlideRasterAllowed"])
            self.assertEqual(features["ownershipOverlapMax"], 0)
            self.assertEqual(features["ownershipConflictMax"], 0)
            if features["complexPage"]:
                self.assertGreaterEqual(features["editabilityTarget"], thresholds["complexPageEditability"]["value"])
                self.assertLessEqual(features["rasterAreaShareMax"], thresholds["complexPageRasterAreaShare"]["value"])

    def test_truth_is_generated_input_only_and_boxes_match_source_dimensions(self) -> None:
        for sample in self.samples:
            truth = sample["truth"]
            self.assertEqual(truth["source"], "generated-input")
            self.assertEqual(truth["generator"], GENERATOR.GENERATOR_ID)
            self.assertEqual(truth["seed"], self.manifest["deterministic"]["seed"])
            self.assertEqual(truth["category"], sample["category"])
            self.assertEqual(truth["ordinal"], sample["ordinal"])
            self.assertEqual(truth["dimensions"]["width"], sample["dimensions"]["width"])
            self.assertEqual(truth["dimensions"]["height"], sample["dimensions"]["height"])
            self.assertEqual(truth["text"], [item["text"] for item in truth["objects"] if item["kind"] == "text"])
            self.assertEqual(truth["objectCount"], len(truth["objects"]))
            width, height = sample["dimensions"]["width"], sample["dimensions"]["height"]
            for obj in truth["objects"]:
                box = obj["box"]
                self.assertGreater(box["w"], 0)
                self.assertGreater(box["h"], 0)
                self.assertGreaterEqual(box["x"], 0, obj["id"])
                self.assertGreaterEqual(box["y"], 0, obj["id"])
                self.assertLessEqual(box["x"] + box["w"], width, obj["id"])
                self.assertLessEqual(box["y"] + box["h"], height, obj["id"])

    def test_text_truth_boxes_do_not_accidentally_overlap(self) -> None:
        for sample in self.samples:
            text_objects = [item for item in sample["truth"]["objects"] if item["kind"] == "text"]
            for index, left in enumerate(text_objects):
                left_box = left["box"]
                for right in text_objects[index + 1 :]:
                    right_box = right["box"]
                    overlap_w = min(left_box["x"] + left_box["w"], right_box["x"] + right_box["w"]) - max(left_box["x"], right_box["x"])
                    overlap_h = min(left_box["y"] + left_box["h"], right_box["y"] + right_box["h"]) - max(left_box["y"], right_box["y"])
                    self.assertLessEqual(max(0, overlap_w) * max(0, overlap_h), 0, f"{sample['id']}: {left['id']} / {right['id']}")

    def test_effects_and_low_resolution_truth_describe_actual_artifacts(self) -> None:
        for sample in self.samples:
            if sample["category"] == "effects":
                self.assertTrue(sample["truth"]["effects"]["transparency"])
                opacities = [item["opacity"] for item in sample["truth"]["objects"] if item["kind"] in {"shadow", "transparent-panel"}]
                self.assertTrue(any(value < 1.0 for value in opacities))
            if sample["category"] == "low-resolution":
                self.assertEqual(sample["source"]["mediaType"], "image/jpeg")
                self.assertEqual(sample["source"]["path"].rsplit(".", 1)[-1], "jpg")
                compression = sample["truth"]["compression"]
                self.assertEqual(compression["format"], "JPEG")
                self.assertEqual(compression["quality"], 48)
                self.assertEqual(compression["subsampling"], "4:2:0")


if __name__ == "__main__":
    unittest.main()
