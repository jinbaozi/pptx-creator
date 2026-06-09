import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from image_inspect_core import (  # noqa: E402
    build_manifest_hints,
    build_replica_analysis,
    build_replica_layer_plan,
    detect_layout_bands,
    extract_palette,
    image_metadata,
    inspect_image,
    load_image,
    ocr_status,
    png_dimensions_stdlib,
    px_to_inch,
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
            plan = self.run_cli(REPLICA_PLAN_CLI, str(analysis_out), str(plan_out))
            self.assertEqual(plan.returncode, 0, plan.stderr)
            data = json.loads(plan_out.read_text(encoding="utf-8"))
            self.assertEqual(data["kind"], "replica-layer-plan")
            self.assertIn("layers", data)
        finally:
            for path in (analysis_out, plan_out):
                if path.exists():
                    path.unlink()


if __name__ == "__main__":
    unittest.main()
