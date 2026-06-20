import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from image_inspect_core import (  # noqa: E402
    DEFAULT_OCR_CONFIDENCE_THRESHOLD,
    build_manifest_hints,
    build_replica_analysis,
    build_replica_layer_plan,
    detect_layout_bands,
    extract_palette,
    image_metadata,
    inspect_image,
    load_design_tokens,
    load_image,
    ocr_status,
    png_dimensions_stdlib,
    px_to_inch,
    resolve_palette_to_tokens,
    slide_mapping,
    Box,
)

SAMPLE_DIR = ROOT / "examples" / "image-input"
SAMPLE_IMAGE = SAMPLE_DIR / "business-slide.png"
GENERATOR = ROOT / "scripts" / "generate-sample-slide.py"
INSPECT_CLI = ROOT / "scripts" / "inspect-image.py"
HINTS_CLI = ROOT / "scripts" / "image-to-manifest-hints.py"
REPLICA_ANALYZE_CLI = ROOT / "scripts" / "image-replica-analyze.py"
REPLICA_PLAN_CLI = ROOT / "scripts" / "image-replica-plan.py"


def ensure_sample_image() -> None:
    if SAMPLE_IMAGE.exists():
        return
    result = subprocess.run(
        [sys.executable, str(GENERATOR)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)


class ImageInspectCoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def test_png_dimensions_stdlib(self):
        width, height = png_dimensions_stdlib(SAMPLE_IMAGE)
        self.assertEqual(width, 1920)
        self.assertEqual(height, 1080)

    def test_image_metadata(self):
        img = load_image(SAMPLE_IMAGE)
        meta = image_metadata(SAMPLE_IMAGE, img)
        self.assertEqual(meta["widthPx"], 1920)
        self.assertEqual(meta["heightPx"], 1080)
        self.assertEqual(meta["format"], "PNG")
        self.assertEqual(meta["orientation"], "landscape")
        self.assertAlmostEqual(meta["aspectRatio"], 1920 / 1080, places=3)

    def test_slide_mapping(self):
        meta = image_metadata(SAMPLE_IMAGE, load_image(SAMPLE_IMAGE))
        mapping = slide_mapping("wide", meta)
        self.assertEqual(mapping["preset"], "wide")
        self.assertEqual(mapping["widthIn"], 13.333)
        self.assertEqual(mapping["heightIn"], 7.5)
        self.assertAlmostEqual(mapping["pxPerInX"], 1920 / 13.333, places=2)

    def test_px_to_inch_round_trip(self):
        meta = image_metadata(SAMPLE_IMAGE, load_image(SAMPLE_IMAGE))
        mapping = slide_mapping("wide", meta)
        box = Box(x=192.0, y=108.0, w=384.0, h=216.0)
        inch = px_to_inch(box, mapping)
        self.assertAlmostEqual(inch.x + inch.w, (box.x + box.w) / mapping["pxPerInX"], places=3)

    def test_extract_palette(self):
        palette = extract_palette(load_image(SAMPLE_IMAGE), count=6)
        self.assertGreaterEqual(len(palette), 3)
        self.assertLessEqual(len(palette), 6)
        for entry in palette:
            self.assertRegex(entry["hex"], r"^#[0-9A-F]{6}$")
            self.assertEqual(len(entry["rgb"]), 3)
            self.assertGreater(entry["share"], 0)

    def test_detect_layout_bands(self):
        img = load_image(SAMPLE_IMAGE)
        meta = image_metadata(SAMPLE_IMAGE, img)
        mapping = slide_mapping("wide", meta)
        regions = detect_layout_bands(img, mapping)
        self.assertGreaterEqual(len(regions), 2)
        first = regions[0]
        self.assertIn("pixelBox", first)
        self.assertIn("inchBox", first)
        self.assertIn("suggestedElements", first)
        self.assertGreater(first["inchBox"]["h"], 0)

    def test_ocr_status_structure(self):
        status = ocr_status()
        self.assertIn(status["status"], {"deferred", "available"})
        self.assertIn("note", status)
        self.assertIsInstance(status["textBlocks"], list)

    def test_build_manifest_hints(self):
        hints = build_manifest_hints(SAMPLE_IMAGE, deck_title="产品能力概览")
        self.assertEqual(hints["version"], "0.1.0")
        self.assertEqual(hints["sourceImage"], "business-slide.png")
        self.assertIn("palette", hints)
        self.assertIn("layoutHints", hints)
        self.assertIn("manifestSkeleton", hints)
        skeleton = hints["manifestSkeleton"]
        self.assertEqual(skeleton["version"], "0.1.1")
        self.assertTrue(skeleton.get("_skeleton"))
        self.assertGreaterEqual(len(skeleton["slides"][0]["elements"]), 1)
        self.assertIn("hostAgentTasks", hints)

    def test_build_replica_analysis_emits_object_candidates(self):
        analysis = build_replica_analysis(SAMPLE_IMAGE, deck_title="Image Replica Upgrade")
        self.assertEqual(analysis["version"], "0.2.0")
        self.assertEqual(analysis["kind"], "image-replica-analysis")
        self.assertEqual(analysis["sourceImage"], "business-slide.png")
        self.assertIn("slideMapping", analysis)
        self.assertGreaterEqual(len(analysis["objectCandidates"]), 2)
        self.assertIn("detectors", analysis)
        self.assertEqual(analysis["detectors"]["layoutBands"]["status"], "ok")
        self.assertIn(analysis["detectors"]["ocr"]["status"], {"deferred", "available"})
        self.assertLessEqual(analysis["qualityTargets"]["textBoxMaxOffsetPx"], 4)

    def test_build_replica_layer_plan_prioritizes_editable_text_and_shapes(self):
        analysis = build_replica_analysis(SAMPLE_IMAGE, deck_title="Image Replica Upgrade")
        plan = build_replica_layer_plan(analysis)
        self.assertEqual(plan["version"], "0.2.0")
        self.assertEqual(plan["kind"], "replica-layer-plan")
        self.assertEqual(plan["sourceImage"], "business-slide.png")
        self.assertGreaterEqual(len(plan["layers"]), 3)
        layer_ids = {layer["id"] for layer in plan["layers"]}
        self.assertIn("source-reference", layer_ids)
        self.assertIn("editable-text", layer_ids)
        self.assertIn("editable-shapes", layer_ids)
        self.assertGreaterEqual(plan["editabilityTarget"]["level"], 4)
        self.assertIn("repairLoop", plan)

    def test_load_design_tokens_parses_business_neutral(self):
        tokens = load_design_tokens(ROOT / "design-systems" / "business-neutral" / "DESIGN.md")
        self.assertIn("colors", tokens)
        self.assertEqual(tokens["colors"].get("primary"), "#2563EB")
        self.assertEqual(tokens["colors"].get("background"), "#FFFFFF")
        self.assertEqual(tokens.get("name"), "Business Neutral")

    def test_resolve_palette_to_tokens_pure(self):
        tokens = load_design_tokens(ROOT / "design-systems" / "business-neutral" / "DESIGN.md")
        # Exact match against an existing design-system color.
        exact = resolve_palette_to_tokens(
            [{"hex": "#2563EB", "origin": "p0"}], tokens
        )
        self.assertEqual(exact["paletteMatch"], 1.0)
        self.assertEqual(exact["matches"][0]["tokenName"], "primary")
        self.assertFalse(exact["skipped"])

        # Far-off color is unmapped.
        far = resolve_palette_to_tokens(
            [{"hex": "#FF00FF", "origin": "p1"}], tokens
        )
        self.assertEqual(far["paletteMatch"], 0)
        self.assertEqual(far["unmapped"][0]["extractedHex"], "#FF00FF")

        # Replica mode bypasses.
        replica = resolve_palette_to_tokens(
            [{"hex": "#2563EB", "origin": "p2"}], tokens, is_replica=True
        )
        self.assertTrue(replica["skipped"])
        self.assertEqual(replica["paletteMatch"], 0)

    def test_build_manifest_hints_emits_palette_resolution(self):
        tokens = load_design_tokens(ROOT / "design-systems" / "business-neutral" / "DESIGN.md")
        hints = build_manifest_hints(
            SAMPLE_IMAGE,
            deck_title="产品能力概览",
            design_tokens=tokens,
        )
        self.assertIn("paletteResolution", hints)
        self.assertIn("paletteMatch", hints["paletteResolution"])
        self.assertIsInstance(hints["paletteResolution"]["matches"], list)
        self.assertIsInstance(hints["paletteResolution"]["unmapped"], list)
        self.assertGreaterEqual(hints["paletteResolution"]["paletteMatch"], 0)
        self.assertLessEqual(hints["paletteResolution"]["paletteMatch"], 1)
        # Skeleton surfaces the paletteMatch + inlineColors for downstream use.
        skeleton = hints["manifestSkeleton"]
        self.assertIn("paletteMatch", skeleton)
        self.assertIn("inlineColors", skeleton)
        self.assertEqual(skeleton["paletteMatch"], hints["paletteResolution"]["paletteMatch"])

    def test_build_replica_analysis_emits_palette_match_top_level(self):
        tokens = load_design_tokens(ROOT / "design-systems" / "business-neutral" / "DESIGN.md")
        analysis = build_replica_analysis(
            SAMPLE_IMAGE, deck_title="Replica", design_tokens=tokens
        )
        self.assertIn("paletteResolution", analysis)
        self.assertIn("paletteMatch", analysis)
        self.assertIn("paletteMatches", analysis)
        self.assertIn("paletteUnmapped", analysis)
        # Replica layer plan propagates the resolution.
        plan = build_replica_layer_plan(analysis)
        self.assertIn("paletteMatch", plan)
        self.assertEqual(plan["paletteMatch"], analysis["paletteMatch"])

    def test_build_replica_analysis_replica_mode_skips_resolution(self):
        analysis = build_replica_analysis(
            SAMPLE_IMAGE,
            deck_title="Replica",
            design_tokens={"colors": {"primary": "#FF0000"}},
            mode="replica",
        )
        self.assertTrue(analysis["paletteResolution"]["skipped"])
        self.assertEqual(analysis["paletteMatch"], 0)
        self.assertEqual(analysis["paletteMatches"], [])


class ImageInspectCliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def run_cli(self, script: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(script), *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_inspect_image_cli_stdout(self):
        result = self.run_cli(INSPECT_CLI, str(SAMPLE_IMAGE))
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["image"]["widthPx"], 1920)
        self.assertIn("palette", data)

    def test_image_to_manifest_hints_cli_writes_file(self):
        out = SAMPLE_DIR / "_test-hints.json"
        try:
            result = self.run_cli(HINTS_CLI, str(SAMPLE_IMAGE), str(out), "--deck-title", "产品能力概览")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(out.exists())
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["deckTitle"] if "deckTitle" in data else data["manifestSkeleton"]["deck"]["title"], "产品能力概览")
            self.assertIn("layoutHints", data)
        finally:
            if out.exists():
                out.unlink()

    def test_inspect_image_matches_core(self):
        cli = json.loads(self.run_cli(INSPECT_CLI, str(SAMPLE_IMAGE)).stdout)
        core = inspect_image(SAMPLE_IMAGE)
        self.assertEqual(cli["image"]["widthPx"], core["image"]["widthPx"])
        self.assertEqual(len(cli["palette"]), len(core["palette"]))

    def test_image_replica_analyze_cli_writes_file(self):
        out = SAMPLE_DIR / "_test-replica-analysis.json"
        try:
            result = self.run_cli(REPLICA_ANALYZE_CLI, str(SAMPLE_IMAGE), str(out), "--deck-title", "Image Replica Upgrade")
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["kind"], "image-replica-analysis")
            self.assertGreaterEqual(len(data["objectCandidates"]), 2)
        finally:
            if out.exists():
                out.unlink()

    def test_image_replica_plan_cli_writes_file(self):
        analysis_out = SAMPLE_DIR / "_test-replica-analysis.json"
        plan_out = SAMPLE_DIR / "_test-replica-plan.json"
        try:
            analyze = self.run_cli(REPLICA_ANALYZE_CLI, str(SAMPLE_IMAGE), str(analysis_out))
            self.assertEqual(analyze.returncode, 0, analyze.stderr)
            plan = self.run_cli(REPLICA_PLAN_CLI, str(analysis_out), str(plan_out), "--skip-ocr")
            self.assertEqual(plan.returncode, 0, plan.stderr)
            data = json.loads(plan_out.read_text(encoding="utf-8"))
            self.assertEqual(data["kind"], "replica-layer-plan")
            self.assertIn("layers", data)
        finally:
            for path in (analysis_out, plan_out):
                if path.exists():
                    path.unlink()


class ImageReplicaOcrGatingTest(unittest.TestCase):
    """U5: per-block kind + OCR confidence threshold gating."""

    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def _analysis(self) -> dict:
        return build_replica_analysis(SAMPLE_IMAGE, deck_title="U5 Gating")

    def _first_text_candidate(self, analysis: dict) -> dict:
        for cand in analysis.get("objectCandidates", []):
            if cand.get("editableAs") == "native-text":
                return cand
        self.fail("expected at least one native-text candidate in fixture")

    def test_high_confidence_emits_editable_text(self):
        analysis = self._analysis()
        text_cand = self._first_text_candidate(analysis)
        box = text_cand["pixelBox"]
        ocr_blocks = [
            {
                "text": "Sample Title",
                "confidence01": 0.85,
                "pixelBox": box,
            }
        ]
        plan = build_replica_layer_plan(analysis, ocr_blocks=ocr_blocks, threshold=0.7)
        kinds = {cand["id"]: cand.get("kind") for cand in plan["objectCandidates"]}
        self.assertEqual(kinds[text_cand["id"]], "editable-text")
        decisions = [d for d in plan["decisions"] if d["candidateId"] == text_cand["id"]]
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["kind"], "editable-text")
        self.assertTrue(decisions[0]["passes"])
        self.assertEqual(decisions[0]["threshold"], 0.7)
        self.assertEqual(plan["threshold"], 0.7)

    def test_low_confidence_emits_cropped_asset(self):
        analysis = self._analysis()
        text_cand = self._first_text_candidate(analysis)
        box = text_cand["pixelBox"]
        ocr_blocks = [
            {
                "text": "blurry caption",
                "confidence01": 0.55,
                "pixelBox": box,
            }
        ]
        plan = build_replica_layer_plan(analysis, ocr_blocks=ocr_blocks, threshold=0.7)
        kinds = {cand["id"]: cand.get("kind") for cand in plan["objectCandidates"]}
        self.assertEqual(kinds[text_cand["id"]], "cropped-asset")
        decisions = [d for d in plan["decisions"] if d["candidateId"] == text_cand["id"]]
        self.assertEqual(decisions[0]["kind"], "cropped-asset")
        self.assertFalse(decisions[0]["passes"])

    def test_lower_threshold_lifts_block_into_editable(self):
        analysis = self._analysis()
        text_cand = self._first_text_candidate(analysis)
        box = text_cand["pixelBox"]
        ocr_blocks = [
            {
                "text": "almost there",
                "confidence01": 0.4,
                "pixelBox": box,
            }
        ]
        plan_default = build_replica_layer_plan(analysis, ocr_blocks=ocr_blocks, threshold=0.7)
        plan_low = build_replica_layer_plan(analysis, ocr_blocks=ocr_blocks, threshold=0.3)
        kinds_default = {c["id"]: c.get("kind") for c in plan_default["objectCandidates"]}
        kinds_low = {c["id"]: c.get("kind") for c in plan_low["objectCandidates"]}
        self.assertEqual(kinds_default[text_cand["id"]], "cropped-asset")
        self.assertEqual(kinds_low[text_cand["id"]], "editable-text")

    def test_ocr_deferred_falls_back_to_cropped_asset(self):
        analysis = self._analysis()
        plan = build_replica_layer_plan(analysis, ocr_blocks=None)
        text_cands = [c for c in analysis["objectCandidates"] if c.get("editableAs") == "native-text"]
        self.assertGreater(len(text_cands), 0)
        for cand in text_cands:
            matches = [c for c in plan["objectCandidates"] if c["id"] == cand["id"]]
            self.assertEqual(len(matches), 1)
            self.assertEqual(matches[0].get("kind"), "cropped-asset")
        self.assertEqual(plan["decisions"], [])
        self.assertEqual(plan["threshold"], 0.7)

    def test_no_ocr_preserves_existing_behavior(self):
        """Without OCR the plan still produces a decisions list (empty) and a
        threshold field. Text-region candidates default to ``cropped-asset``
        per the conservative fallback; non-text candidates are left
        unannotated to preserve the existing shape for downstream consumers.
        """
        analysis = self._analysis()
        plan = build_replica_layer_plan(analysis)
        for cand in plan["objectCandidates"]:
            if cand.get("editableAs") == "native-text":
                self.assertEqual(cand.get("kind"), "cropped-asset")
        self.assertEqual(plan["decisions"], [])
        self.assertEqual(plan["threshold"], DEFAULT_OCR_CONFIDENCE_THRESHOLD)

    def test_decisions_record_threshold_and_confidence(self):
        analysis = self._analysis()
        text_cand = self._first_text_candidate(analysis)
        box = text_cand["pixelBox"]
        ocr_blocks = [
            {"text": "alpha", "confidence01": 0.91, "pixelBox": box},
            {"text": "beta", "confidence01": 0.62, "pixelBox": box},
        ]
        plan = build_replica_layer_plan(analysis, ocr_blocks=ocr_blocks, threshold=0.7)
        relevant = [d for d in plan["decisions"] if d["candidateId"] == text_cand["id"]]
        self.assertEqual(len(relevant), 2)
        confidence_values = sorted(d["confidence01"] for d in relevant)
        self.assertEqual(confidence_values, [0.62, 0.91])
        for decision in relevant:
            self.assertEqual(decision["threshold"], 0.7)
            self.assertIn(decision["kind"], {"editable-text", "cropped-asset"})
            self.assertIn("passes", decision)


class ImageReplicaOcrGatingCliTest(unittest.TestCase):
    """U5 CLI: --ocr-confidence and --skip-ocr flags."""

    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def setUp(self) -> None:
        self.analysis_out = SAMPLE_DIR / "_test-u5-analysis.json"
        self.plan_out = SAMPLE_DIR / "_test-u5-plan.json"
        result = subprocess.run(
            [sys.executable, str(REPLICA_ANALYZE_CLI), str(SAMPLE_IMAGE), str(self.analysis_out)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def tearDown(self) -> None:
        for path in (self.analysis_out, self.plan_out):
            if path.exists():
                path.unlink()

    def _run_plan(self, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(REPLICA_PLAN_CLI), str(self.analysis_out), str(self.plan_out), *extra],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_skip_ocr_keeps_existing_behavior(self):
        result = self._run_plan("--skip-ocr")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(self.plan_out.read_text(encoding="utf-8"))
        self.assertEqual(data["kind"], "replica-layer-plan")
        # Without OCR the conservative default applies: text-region
        # candidates become cropped-asset; non-text candidates stay
        # unannotated to preserve the legacy shape.
        for cand in data["objectCandidates"]:
            if cand.get("editableAs") == "native-text":
                self.assertEqual(cand.get("kind"), "cropped-asset")
            else:
                self.assertNotIn("kind", cand)
        self.assertEqual(data["decisions"], [])

    def test_ocr_confidence_flag_default_matches_constant(self):
        result = self._run_plan("--skip-ocr")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(self.plan_out.read_text(encoding="utf-8"))
        self.assertEqual(data["threshold"], DEFAULT_OCR_CONFIDENCE_THRESHOLD)

    def test_ocr_confidence_flag_rejects_out_of_range(self):
        result = self._run_plan("--skip-ocr", "--ocr-confidence", "1.5")
        self.assertNotEqual(result.returncode, 0)
        result = self._run_plan("--skip-ocr", "--ocr-confidence", "-0.1")
        self.assertNotEqual(result.returncode, 0)

    def test_ocr_confidence_low_threshold(self):
        result = self._run_plan("--skip-ocr", "--ocr-confidence", "0.3")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(self.plan_out.read_text(encoding="utf-8"))
        self.assertEqual(data["threshold"], 0.3)


if __name__ == "__main__":
    unittest.main()
