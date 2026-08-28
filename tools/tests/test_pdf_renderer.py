"""Contract tests for tools/pdf_renderer.py (RenderPlan / faithful export).

Guards:
  - only `faithful` renders; other modes fail with a clear message
  - an unsupported plan version is rejected
  - redaction keeps vector line art (table rules) and images
  - translated text uses the bundled CJK font and is extractable
  - blocks that overflow shrink toward the minimum instead of vanishing silently
  - a page whose geometry disagrees with the plan is rejected, not misplaced
"""

from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from pathlib import Path

import pymupdf

_MODULE_PATH = Path(__file__).resolve().parents[1] / "pdf_renderer.py"
_spec = importlib.util.spec_from_file_location("pdf_renderer", _MODULE_PATH)
pdf_renderer = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(pdf_renderer)


def _one_page_pdf_with_rule() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=400)
    page.insert_text((50, 60), "Original English paragraph text here.", fontsize=11)
    page.draw_line(pymupdf.Point(40, 200), pymupdf.Point(360, 200), width=1.2)
    data = doc.tobytes()
    doc.close()
    return data


def _plan(pages, *, mode="faithful", version=1):
    return {
        "version": version,
        "mode": mode,
        "targetLanguage": "zh-TW",
        "fontScale": 0.9,
        "minFontScale": 0.85,
        "pages": pages,
    }


def _block(bid, x, y, w, h, text, *, font_size=11, masks=None):
    return {
        "id": bid,
        "kind": "text",
        "bbox": {"x": x, "y": y, "width": w, "height": h},
        "fontSize": font_size,
        "text": text,
        "maskRects": masks if masks is not None else [{"x": x, "y": y, "width": w, "height": h}],
    }


class PdfRendererTests(unittest.TestCase):
    def test_non_faithful_modes_fail_with_message(self) -> None:
        for mode in ("adaptive", "bilingual"):
            with self.assertRaises(NotImplementedError):
                pdf_renderer.render(b"", _plan([], mode=mode))

    def test_unsupported_plan_version_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pdf_renderer.render(b"", _plan([], version=999))

    def test_faithful_keeps_line_art_and_embeds_cjk_text(self) -> None:
        pdf_bytes = _one_page_pdf_with_rule()
        page = {
            "pageNumber": 1,
            "width": 400,
            "height": 400,
            "blocks": [
                _block(
                    "b0", 48, 48, 300, 80,
                    "這是一段用於測試的繁體中文翻譯文字，應可完整寫入方框。",
                    masks=[{"x": 48, "y": 48, "width": 300, "height": 16}],
                )
            ],
        }
        rendered = pdf_renderer.render_faithful(pdf_bytes, _plan([page]))
        out = pymupdf.open(stream=rendered, filetype="pdf")
        p = out[0]

        self.assertEqual(len(out), 1)
        self.assertIn("這是一段用於測試的繁體中文翻譯", p.get_text())
        self.assertNotIn("Original English paragraph", p.get_text())
        font_names = {name for _, _, _, name, _, _ in p.get_fonts()}
        self.assertTrue(any("Fangti" in n or "china" in n.lower() for n in font_names))
        self.assertGreaterEqual(len(p.get_drawings()), 1)  # the vector rule survives

    def test_overflowing_block_is_reported_not_dropped_silently(self) -> None:
        page = {
            "pageNumber": 1,
            "width": 400,
            "height": 400,
            "blocks": [_block("tiny", 50, 300, 20, 8, "這段文字對這個極小的方框來說永遠塞不下無論字級縮到多小。", font_size=8)],
        }
        stderr = io.StringIO()
        real, sys.stderr = sys.stderr, stderr
        try:
            pdf_renderer.render_faithful(_one_page_pdf_with_rule(), _plan([page]))
        finally:
            sys.stderr = real
        self.assertIn("tiny", stderr.getvalue())

    def test_coordinate_system_mismatch_is_rejected(self) -> None:
        page = {
            "pageNumber": 1,
            "width": 999,  # real page is 400x400
            "height": 999,
            "blocks": [_block("b0", 10, 10, 100, 20, "翻譯")],
        }
        with self.assertRaises(ValueError):
            pdf_renderer.render_faithful(_one_page_pdf_with_rule(), _plan([page]))


if __name__ == "__main__":
    unittest.main()
