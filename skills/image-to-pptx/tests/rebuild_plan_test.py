import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("rebuild_reconstruction_plan", ROOT / "scripts" / "rebuild_reconstruction_plan.py")
REBUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REBUILD)


class RebuildPlanPathTest(unittest.TestCase):
    def test_report_path_is_validated_before_any_write(self):
        with tempfile.TemporaryDirectory(prefix="image-rebuild-path-") as temporary:
            root = Path(temporary) / "package"
            root.mkdir()
            analysis = root / "analysis.json"
            analysis.write_text("{}\n", encoding="utf-8")
            outside = Path(temporary) / "escape.json"
            with self.assertRaises(REBUILD.ReconstructionPlanError) as context:
                REBUILD.rebuild(analysis, Path("../escape.json"), root)
            self.assertEqual(context.exception.code, "E_RECONSTRUCTION_PLAN")
            self.assertFalse(outside.exists())


if __name__ == "__main__":
    unittest.main()
