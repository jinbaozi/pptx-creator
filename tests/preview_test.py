import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from preview_core import _configure_font_environment, build_contact_sheet, compare_images, libreoffice_status, render_pptx_preview  # noqa: E402

SAMPLE_DIR = ROOT / "examples" / "image-input"
SAMPLE_IMAGE = SAMPLE_DIR / "business-slide.png"
GENERATOR = ROOT / "scripts" / "generate-sample-slide.py"
SMOKE_PPTX = ROOT / ".pptx-creator" / "smoke" / "final.pptx"
COMPARE_CLI = ROOT / "scripts" / "compare-preview.py"
RENDER_CLI = ROOT / "scripts" / "render-preview.py"


def ensure_sample_image() -> None:
    if SAMPLE_IMAGE.exists():
        return
    subprocess.run([sys.executable, str(GENERATOR)], cwd=ROOT, check=True)


class PreviewCoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_sample_image()

    def test_libreoffice_status_structure(self):
        status = libreoffice_status()
        self.assertIn(status["status"], {"deferred", "available"})

    def test_compare_images_identical(self):
        data = compare_images(SAMPLE_IMAGE, SAMPLE_IMAGE)
        self.assertEqual(data["verdict"], "close")
        self.assertEqual(data["meanAbsChannelDiff"], 0.0)
        self.assertTrue(data["sizeMatch"])

    def test_compare_images_different_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            from PIL import Image

            small = Path(tmp) / "small.png"
            Image.new("RGB", (320, 180), color=(30, 60, 90)).save(small)
            data = compare_images(SAMPLE_IMAGE, small)
            self.assertIn(data["verdict"], {"moderate", "divergent", "close"})
            self.assertFalse(data["sizeMatch"])

    def test_build_contact_sheet_labels_every_slide(self):
        with tempfile.TemporaryDirectory() as tmp:
            from PIL import Image

            root = Path(tmp)
            slides = []
            for index, color in enumerate(((20, 40, 80), (160, 80, 20)), start=1):
                slide = root / f"slide-{index}.png"
                Image.new("RGB", (320, 180), color=color).save(slide)
                slides.append(str(slide))
            result = build_contact_sheet(slides, root / "contact-sheet.png")
            self.assertEqual(result["slideCount"], 2)
            self.assertTrue(Path(result["path"]).exists())
            self.assertGreater(result["width"], 320)
            self.assertRegex(result["hash"], r"^sha256:[a-f0-9]{64}$")
            self.assertEqual(len(result["slideHashes"]), 2)

    def test_explicit_font_directories_create_isolated_fontconfig(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "fonts & cjk"
            second = root / "metrics"
            first.mkdir()
            second.mkdir()
            env = {"PPTX_CREATOR_FONT_DIRS": f"{first}{__import__('os').pathsep}{second}"}
            settings = _configure_font_environment(root / "profile", env)
            self.assertEqual(settings, {"fontConfigOverride": True, "fontDirectoryCount": 2})
            config = Path(env["FONTCONFIG_FILE"])
            self.assertTrue(config.exists())
            text = config.read_text(encoding="utf-8")
            self.assertIn("fonts &amp; cjk", text)
            self.assertIn(str(second), text)

    def test_macos_defaults_expose_system_font_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = {}
            with patch("preview_core.platform.system", return_value="Darwin"), patch.object(Path, "is_dir", return_value=True):
                settings = _configure_font_environment(root / "profile", env)
            self.assertEqual(settings, {"fontConfigOverride": True, "fontDirectoryCount": 4})
            text = Path(env["FONTCONFIG_FILE"]).read_text(encoding="utf-8")
            self.assertIn("/System/Library/Fonts", text)
            self.assertIn("/Library/Fonts", text)

    def test_render_preview_smoke_pptx_optional(self):
        if not SMOKE_PPTX.exists():
            self.skipTest("smoke PPTX missing; run npm run setup first")
        with tempfile.TemporaryDirectory() as tmp:
            data = render_pptx_preview(SMOKE_PPTX, Path(tmp))
            self.assertIn(data["status"], {"ok", "deferred", "failed"})
            if data["status"] == "ok":
                self.assertGreater(data["previewCount"], 0)
                self.assertEqual(len(data["pages"]), data["previewCount"])
                self.assertRegex(data["pages"][0]["hash"], r"^sha256:[a-f0-9]{64}$")
                self.assertGreater(data["pages"][0]["width"], 0)
                self.assertEqual(data["environment"]["renderer"], "libreoffice")

    def test_compare_cli(self):
        result = subprocess.run(
            [sys.executable, str(COMPARE_CLI), str(SAMPLE_IMAGE), str(SAMPLE_IMAGE)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["verdict"], "close")

    def test_render_preview_cli_exit_code(self):
        if not SMOKE_PPTX.exists():
            self.skipTest("smoke PPTX missing")
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, str(RENDER_CLI), str(SMOKE_PPTX), tmp],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertIn(result.returncode, {0, 1, 2})


if __name__ == "__main__":
    unittest.main()
