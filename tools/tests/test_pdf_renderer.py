"""Contract tests for tools/pdf_renderer.py (faithful export mode).

Guards the PR-1 fixes:
  - only `faithful` renders; other modes fail with a clear message
  - redaction keeps vector line art (table rules) and images
  - translated text uses the bundled CJK font and is extractable
  - blocks that overflow shrink toward the minimum instead of vanishing silently
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path

import fitz

_MODULE_PATH = Path(__file__).resolve().parents[1] / "pdf_renderer.py"
_spec = importlib.util.spec_from_file_location("pdf_renderer", _MODULE_PATH)
pdf_renderer = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(pdf_renderer)


def _one_page_pdf_with_rule() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=400, height=400)
    page.insert_text((50, 60), "Original English paragraph text here.", fontsize=11)
    # a horizontal rule standing in for a table border
    page.draw_line(fitz.Point(40, 200), fitz.Point(360, 200), width=1.2)
    data = doc.tobytes()
    doc.close()
    return data


class PdfRendererTests(unittest.TestCase):
    def test_non_faithful_modes_fail_with_message(self) -> None:
        for mode in ("adaptive", "bilingual"):
            code = pdf_renderer.main(
                ["--mode", mode, "--pages-json", "[]", "--translations-json", "{}"]
            )
            self.assertEqual(code, 1)

    def test_faithful_keeps_line_art_and_embeds_cjk_text(self) -> None:
        pdf_bytes = _one_page_pdf_with_rule()
        blocks = [
            {
                "id": "b0",
                "sourceBBox": {"x": 48, "y": 48, "width": 300, "height": 80},
                "sourceStyle": {"fontSize": 11},
                "maskRects": [{"x": 48, "y": 48, "width": 300, "height": 16}],
            }
        ]
        translations = {"b0": "這是一段用於測試的繁體中文翻譯文字，應可完整寫入方框。"}

        rendered = pdf_renderer.render_faithful(
            pdf_bytes, [{"pageNumber": 1, "blocks": blocks}], translations
        )
        out = fitz.open(stream=rendered, filetype="pdf")
        page = out[0]

        self.assertEqual(len(out), 1)
        self.assertIn("這是一段用於測試的繁體中文翻譯", page.get_text())
        self.assertNotIn("Original English paragraph", page.get_text())
        font_names = {name for _, _, _, name, _, _ in page.get_fonts()}
        self.assertTrue(any("Fangti" in name or "china" in name.lower() for name in font_names))
        # the vector rule must survive redaction
        self.assertGreaterEqual(len(page.get_drawings()), 1)

    def test_overflowing_block_is_reported_not_dropped_silently(self) -> None:
        pdf_bytes = _one_page_pdf_with_rule()
        blocks = [
            {
                "id": "tiny",
                "sourceBBox": {"x": 50, "y": 300, "width": 20, "height": 8},
                "sourceStyle": {"fontSize": 8},
                "maskRects": [{"x": 50, "y": 300, "width": 20, "height": 8}],
            }
        ]
        translations = {"tiny": "這段文字對這個極小的方框來說永遠塞不下無論字級縮到多小。"}

        stderr = io.StringIO()
        real_stderr = sys.stderr
        sys.stderr = stderr
        try:
            pdf_renderer.render_faithful(
                pdf_bytes, [{"pageNumber": 1, "blocks": blocks}], translations
            )
        finally:
            sys.stderr = real_stderr
        self.assertIn("tiny", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
