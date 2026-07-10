import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from replica_metrics_core import compare_replica_images  # noqa: E402


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

    def test_local_change_reduces_real_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            render = Path(directory) / "render.png"
            Image.new("RGB", (64, 64), "white").save(source)
            changed = Image.new("RGB", (64, 64), "white")
            ImageDraw.Draw(changed).rectangle((8, 8, 31, 31), fill="black")
            changed.save(render)
            metrics = compare_replica_images(source, render)
            self.assertLess(metrics["ssim"], 0.95)
            self.assertGreater(metrics["normalizedMae"], 0.1)

    def test_records_original_render_size_before_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            render = Path(directory) / "render.png"
            normalized = Path(directory) / "normalized.png"
            Image.new("RGB", (64, 64), "white").save(source)
            Image.new("RGB", (32, 32), "white").save(render)
            metrics = compare_replica_images(source, render, normalized)
            self.assertEqual(metrics["sourceSize"], {"width": 64, "height": 64})
            self.assertEqual(metrics["originalRenderSize"], {"width": 32, "height": 32})
            with Image.open(normalized) as normalized_image:
                self.assertEqual(normalized_image.size, (64, 64))


if __name__ == "__main__":
    unittest.main()
