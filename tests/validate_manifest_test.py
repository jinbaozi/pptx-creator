import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import TestCase


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate-manifest.py"
SAMPLE = ROOT / "examples" / "text-input" / "deck.manifest.json"


class ValidateManifestTest(TestCase):
    def run_validator(self, manifest: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), str(manifest)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_accepts_sample_manifest(self):
        result = self.run_validator(SAMPLE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("manifest valid", result.stdout)

    def with_resolved_design(self, data: dict) -> dict:
        copy = json.loads(json.dumps(data))
        copy["designSystem"]["source"] = str(ROOT / "design-systems" / "business-neutral" / "DESIGN.md")
        return copy

    def test_rejects_duplicate_element_ids(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["elements"].append(dict(data["slides"][0]["elements"][0]))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate element id", result.stderr)

    def test_rejects_missing_image_file(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["elements"].append(
            {
                "type": "image",
                "id": "missing-photo",
                "src": "assets/does-not-exist.png",
                "x": 1.0,
                "y": 1.0,
                "w": 2.0,
                "h": 2.0,
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("file missing: assets/does-not-exist.png", result.stderr)

    def test_rejects_remote_image_file(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["elements"].append(
            {
                "type": "image",
                "id": "remote-photo",
                "src": "https://example.com/photo.png",
                "x": 1.0,
                "y": 1.0,
                "w": 2.0,
                "h": 2.0,
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("remote src must be downloaded before validation", result.stderr)

    def test_rejects_missing_background_image_file(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["background"] = {"type": "image", "src": "assets/missing-bg.png"}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("file missing: assets/missing-bg.png", result.stderr)

    def test_rejects_out_of_bounds_element(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["elements"][0]["x"] = 13.0
        data["slides"][0]["elements"][0]["w"] = 2.0
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside slide bounds", result.stderr)

    def test_accepts_chart_elements(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        for index, kind in enumerate(["bar", "line", "pie", "horizontalBar", "kpiGroup", "sparkline"]):
            data["slides"][0]["elements"].append(
                {
                    "type": "chart",
                    "kind": kind,
                    "id": f"pipeline-chart-{kind}",
                    "x": 1.0 + index,
                    "y": 4.0,
                    "w": 2.0,
                    "h": 2.0,
                    "data": [
                        {"label": "Q1", "value": 12},
                        {"label": "Q2", "value": 18}
                    ],
                    "style": {"color": "{colors.primary}"}
                }
            )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "chart.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_series_chart_elements(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        for index, kind in enumerate(["stackedBar", "groupedBar"]):
            data["slides"][0]["elements"].append(
                {
                    "type": "chart",
                    "kind": kind,
                    "id": f"series-chart-{kind}",
                    "x": 1.0 + index * 2.2,
                    "y": 4.0,
                    "w": 2.0,
                    "h": 2.0,
                    "data": [
                        {"label": "Phase 1", "series": {"Dev": 30, "Test": 10}},
                        {"label": "Phase 2", "series": {"Dev": 20, "Test": 20}}
                    ],
                    "style": {"palette": ["#36C5F0", "#7CFFB2"]}
                }
            )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "series-chart.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_icon_elements(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["elements"].append(
            {
                "type": "icon",
                "name": "check",
                "id": "status-check",
                "x": 6.0,
                "y": 4.0,
                "w": 0.4,
                "h": 0.4,
                "style": {"color": "{colors.primary}"}
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "icon.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_diagram_elements(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["elements"].append(
            {
                "type": "diagram",
                "kind": "layeredArchitecture",
                "id": "architecture-diagram",
                "x": 0.8,
                "y": 1.0,
                "w": 10.0,
                "h": 4.5,
                "layers": [
                    {"label": "Frontend", "nodes": ["Lexer", "Parser"]},
                    {"label": "Middle End", "nodes": ["IR", "Optimize"]},
                    {"label": "Backend", "nodes": ["Codegen", "Assemble"]}
                ],
                "style": {"theme": "business-tech"}
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "diagram.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_cropped_asset_with_src(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        image_abs = str(ROOT / "examples/image-input/business-slide.png")
        data["slides"][0]["elements"].append(
            {
                "type": "cropped-asset",
                "id": "cropped-asset-direct",
                "src": image_abs,
                "x": 0.5,
                "y": 0.5,
                "w": 2.0,
                "h": 2.0,
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cropped.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_cropped_asset_via_assets_id(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        image_abs = str(ROOT / "examples/image-input/business-slide.png")
        data["assets"] = [{"id": "shared-asset", "src": image_abs}]
        data["slides"][0]["elements"].append(
            {
                "type": "cropped-asset",
                "id": "cropped-asset-ref",
                "assets": {"id": "shared-asset"},
                "x": 0.5,
                "y": 0.5,
                "w": 2.0,
                "h": 2.0,
                "crop": {"x": 0, "y": 0, "w": 100, "h": 100},
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cropped-ref.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_cropped_asset_without_src_or_assets(self):
        data = self.with_resolved_design(json.loads(SAMPLE.read_text(encoding="utf-8")))
        data["slides"][0]["elements"].append(
            {
                "type": "cropped-asset",
                "id": "cropped-asset-orphan",
                "x": 0.5,
                "y": 0.5,
                "w": 2.0,
                "h": 2.0,
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cropped-orphan.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cropped-asset requires src or assets.id", result.stderr)
