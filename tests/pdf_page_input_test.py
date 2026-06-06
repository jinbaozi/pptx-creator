import tempfile
import subprocess
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from pdf_page_core import pdf_renderer_status, pdf_to_page_hints  # noqa: E402


class PdfPageInputTest(unittest.TestCase):
    def test_pdf_renderer_status_structure(self):
        status = pdf_renderer_status()
        self.assertIn(status["status"], {"available", "deferred"})
        self.assertIn("note", status)

    def test_pdf_to_page_hints_deferred_without_renderer(self):
        if pdf_renderer_status()["status"] == "available":
            self.skipTest("PyMuPDF is available; deferred path is not active")

        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "sample.pdf"
            pdf_path.write_bytes(
                b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
            )
            output_dir = Path(tmp) / "pages"
            data = pdf_to_page_hints(pdf_path, output_dir)

        self.assertEqual(data["status"], "deferred")
        self.assertEqual(data["pages"], [])
        self.assertIn("PyMuPDF", data["note"])

    def test_pdf_hints_cli_deferred_is_report_not_failure(self):
        if pdf_renderer_status()["status"] == "available":
            self.skipTest("PyMuPDF is available; deferred path is not active")

        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "sample.pdf"
            output_dir = Path(tmp) / "pages"
            report_path = Path(tmp) / "pdf-page-hints.json"
            pdf_path.write_bytes(
                b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "pdf-to-page-hints.py"),
                    str(pdf_path),
                    str(output_dir),
                    "-o",
                    str(report_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(report_path.exists())


if __name__ == "__main__":
    unittest.main()
