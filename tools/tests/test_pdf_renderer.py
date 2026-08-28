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
# @dataclass needs the module registered before exec so it can resolve
# `cls.__module__` while processing fields.
sys.modules["pdf_renderer"] = pdf_renderer
_spec.loader.exec_module(pdf_renderer)

_FIXTURES = Path(__file__).resolve().parent / "fixtures"


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
    def test_adaptive_still_not_implemented(self) -> None:
        with self.assertRaises(NotImplementedError):
            pdf_renderer.render(b"", _plan([], mode="adaptive"))

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


class FlowPlannerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.font = pdf_renderer._cjk_font()

    def test_wrap_ascii_breaks_only_at_spaces(self) -> None:
        lines = pdf_renderer.wrap("the quick brown fox jumps over", self.font, 10, 70)
        self.assertGreater(len(lines), 1)
        for line in lines:
            self.assertNotIn(" ", (line[:1] + line[-1:]))  # no leading/trailing space
            self.assertLessEqual(self.font.text_length(line, 10), 70 + 1e-6)

    def test_wrap_cjk_breaks_anywhere_but_not_before_forbidden_punct(self) -> None:
        lines = pdf_renderer.wrap("結尾標點測試，句號。逗號，不能在行首", self.font, 10, 52)
        self.assertGreater(len(lines), 1)
        for line in lines[1:]:
            self.assertNotIn(line[0], pdf_renderer._LEADING_FORBIDDEN)

    def test_wrap_keeps_ascii_words_whole_in_mixed_text(self) -> None:
        lines = pdf_renderer.wrap("這是 mixed 中英 content 測試", self.font, 10, 60)
        self.assertIn("mixed", "".join(lines))
        for word in ("mixed", "content"):
            self.assertTrue(any(word in line for line in lines))

    def test_detect_columns_two_column_fixture(self) -> None:
        doc = pymupdf.open(_FIXTURES / "docling-two-column-table.pdf")
        page = doc[0]
        blocks = []
        for block in page.get_text("dict")["blocks"]:
            if block.get("type", 0) != 0:
                continue
            for line in block["lines"]:
                xs = [s["bbox"][0] for s in line["spans"]]
                xe = [s["bbox"][2] for s in line["spans"]]
                if xs:
                    blocks.append({"kind": "text", "bbox": {"x": min(xs), "y": line["bbox"][1],
                                                            "width": max(xe) - min(xs), "height": 10}})
        self.assertEqual(len(pdf_renderer.detect_columns(blocks, page.rect.width)), 2)

    def test_detect_columns_falls_back_to_single(self) -> None:
        blocks = [{"kind": "text", "bbox": {"x": 40, "y": y, "width": 300, "height": 10}} for y in range(0, 300, 12)]
        self.assertEqual(pdf_renderer.detect_columns(blocks, 400), [(0.0, 400)])

    def test_policy_and_mode_tables_cover_every_kind_and_mode(self) -> None:
        for kind in ("text", "heading", "caption", "table", "formula", "artifact"):
            self.assertIn(kind, pdf_renderer.POLICY)
        for mode in ("faithful", "adaptive", "bilingual"):
            self.assertIn(mode, pdf_renderer.MODE)
        self.assertTrue(pdf_renderer.POLICY["caption"].pin)  # captions stay with their figure
        self.assertFalse(pdf_renderer.MODE["bilingual"].redact)

    def test_bilingual_interleaves_original_and_translation_pages(self) -> None:
        doc = pymupdf.open(_FIXTURES / "docling-two-column-table.pdf")
        pages = [{
            "pageNumber": n + 1,
            "width": doc[n].rect.width,
            "height": doc[n].rect.height,
            "blocks": [_block(f"p{n}-b{i}", 60, 90 + i * 40, 240, 30,
                              f"這是第 {n + 1} 頁第 {i} 段的翻譯內容，字數足夠觀察換行。")
                       for i in range(4)],
        } for n in range(len(doc))]
        rendered = pdf_renderer.render_bilingual(doc.tobytes(), _plan(pages, mode="bilingual"))
        out = pymupdf.open(stream=rendered, filetype="pdf")
        self.assertGreaterEqual(len(out), 2 * len(doc))
        self.assertIn("這是第 1 頁第 0 段", out[1].get_text())  # page 2 is page 1's translation

    def test_bilingual_caps_continuation_pages(self) -> None:
        doc = pymupdf.open(_FIXTURES / "docling-two-column-table.pdf")
        pages = [{
            "pageNumber": 1,
            "width": doc[0].rect.width,
            "height": doc[0].rect.height,
            "blocks": [_block("huge", 50, 50, 400, 40, "超長內容需要很多頁。" * 3000)],
        }]
        stderr = io.StringIO()
        real, sys.stderr = sys.stderr, stderr
        try:
            rendered = pdf_renderer.render_bilingual(doc.tobytes(), _plan(pages, mode="bilingual"))
        finally:
            sys.stderr = real
        out = pymupdf.open(stream=rendered, filetype="pdf")
        # 2 originals + 1 translation + at most MAX_CONTINUATION_PAGES
        self.assertLessEqual(len(out), len(doc) + 1 + pdf_renderer.MAX_CONTINUATION_PAGES)
        self.assertIn("續頁上限", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
