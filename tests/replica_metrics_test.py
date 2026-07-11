import tempfile
import unittest
from pathlib import Path
import sys

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
from replica_metrics_core import compare_replica_images


class ReplicaMetricsTest(unittest.TestCase):
    def test_identical_images_are_perfect(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            render = Path(directory) / "render.png"
            Image.new("RGB", (64, 64), "#f8fafc").save(source)
            Image.new("RGB", (64, 64), "#f8fafc").save(render)
            metrics = compare_replica_images(source, render)
            self.assertEqual(metrics["ssim"], 1.0)
            self.assertEqual(metrics["normalizedMae"], 0.0)
            self.assertEqual(metrics["worstTileMae"], 0.0)
            self.assertEqual(metrics["worstTileBadPixelRatio"], 0.0)

    def test_size_mismatch_is_not_resized(self):
        with tempfile.TemporaryDirectory() as directory:
            a = Path(directory) / "a.png"; b = Path(directory) / "b.png"
            Image.new("RGB", (1280, 720), "white").save(a)
            Image.new("RGB", (640, 360), "white").save(b)
            result = compare_replica_images(a, b)
            self.assertFalse(result["sizeMatch"])
            self.assertIsNone(result["ssim"])

    def test_ssim_tolerates_subpixel_rasterizer_edges_but_mae_stays_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            a = Path(directory) / "a.png"; b = Path(directory) / "b.png"
            source = Image.new("RGB", (128, 64), "white")
            render = Image.new("RGB", (128, 64), "white")
            ImageDraw.Draw(source).rectangle((16, 16, 96, 48), fill="#102a43")
            ImageDraw.Draw(render).rectangle((17, 16, 97, 48), fill="#102a43")
            source.save(a); render.save(b)
            result = compare_replica_images(a, b)
            self.assertGreater(result["ssim"], 0.94)
            self.assertGreater(result["normalizedMae"], 0)

    def test_local_missing_region_is_visible_to_worst_tile(self):
        with tempfile.TemporaryDirectory() as directory:
            a = Path(directory) / "a.png"; b = Path(directory) / "b.png"
            source = Image.new("RGB", (1280, 720), "white")
            ImageDraw.Draw(source).rectangle((200, 200, 299, 289), fill="#2563eb")
            source.save(a); Image.new("RGB", (1280, 720), "white").save(b)
            result = compare_replica_images(a, b)
            self.assertGreater(result["worstTileMae"], 0.20)
            self.assertGreater(result["worstTileBadPixelRatio"], 0.5)


if __name__ == "__main__":
    unittest.main()
