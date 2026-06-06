import json
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate-manifest.py"
SAMPLE = ROOT / "examples" / "text-input" / "deck.manifest.json"


class ValidateManifestTest(TestCase):
    def run_validator(self, manifest: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["python", str(VALIDATOR), str(manifest)],
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
        for index, kind in enumerate(["bar", "line", "pie"]):
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
