"""Contract tests for tools/pdf_renderer.py (RenderPlan, faithful + adaptive).

Guards:
  - an unsupported plan version or unknown mode is rejected
  - redaction keeps vector line art (table rules) and images
  - translated text is extractable, CJK and Latin each in their own face
  - the width `wrap` measures is the width TextCanvas actually draws
  - blocks that overflow shrink toward the minimum instead of vanishing silently
  - a page whose geometry disagrees with the plan is rejected, not misplaced
  - adaptive flows around figures, pins non-reflowable blocks, and caps
    continuation pages
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
    def test_unknown_mode_is_rejected(self) -> None:
        with self.assertRaises(NotImplementedError):
            pdf_renderer.render(b"", _plan([], mode="sideways"))

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
        cjk_face = pdf_renderer._cjk_font().name
        font_names = {name for _, _, _, name, _, _ in p.get_fonts()}
        self.assertTrue(any(cjk_face in n for n in font_names), f"got {font_names}")
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
    def test_wrap_ascii_breaks_only_at_spaces(self) -> None:
        lines = pdf_renderer.wrap("the quick brown fox jumps over", 10, 70)
        self.assertGreater(len(lines), 1)
        for line in lines:
            self.assertNotIn(" ", (line[:1] + line[-1:]))  # no leading/trailing space
            self.assertLessEqual(pdf_renderer._text_width(line, 10), 70 + 1e-6)

    def test_wrap_cjk_breaks_anywhere_but_not_before_forbidden_punct(self) -> None:
        lines = pdf_renderer.wrap("結尾標點測試，句號。逗號，不能在行首", 10, 52)
        self.assertGreater(len(lines), 1)
        for line in lines[1:]:
            self.assertNotIn(line[0], pdf_renderer._LEADING_FORBIDDEN)

    def test_wrap_keeps_ascii_words_whole_in_mixed_text(self) -> None:
        lines = pdf_renderer.wrap("這是 mixed 中英 content 測試", 10, 60)
        self.assertIn("mixed", "".join(lines))
        for word in ("mixed", "content"):
            self.assertTrue(any(word in line for line in lines))

    def test_latin_runs_use_the_latin_face(self) -> None:
        latin = pdf_renderer._font(pdf_renderer._LATIN_FONTNAME)
        cjk = pdf_renderer._cjk_font()
        self.assertIs(pdf_renderer._font_for("Manabu"), latin)
        self.assertIs(pdf_renderer._font_for("中文"), cjk)
        runs = pdf_renderer._runs("中文 Manabu 混排")
        self.assertGreaterEqual(len(runs), 3)
        self.assertTrue(any(run.strip() == "Manabu" and font is latin for run, font in runs))

    def test_measured_width_matches_what_is_drawn(self) -> None:
        # page.insert_text(fontname="china-t") gives Latin a full-width CID
        # advance, so measuring one way and drawing the other overflowed every
        # line containing Latin. TextCanvas must render at the measured width.
        text = "Manabu Ito 2022 混排"
        expected = pdf_renderer._text_width(text, 10)
        doc = pymupdf.open()
        page = doc.new_page(width=500, height=200)
        canvas = pdf_renderer.TextCanvas(page)
        canvas.draw(text, 20, 100, 10)
        canvas.flush()
        spans = [s for b in page.get_text("dict")["blocks"] if b["type"] == 0
                 for line in b["lines"] for s in line["spans"]]
        drawn = max(s["bbox"][2] for s in spans) - min(s["bbox"][0] for s in spans)
        self.assertAlmostEqual(drawn, expected, delta=1.5)

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
        self.assertEqual(set(pdf_renderer.MODE), {"faithful", "adaptive"})
        self.assertTrue(pdf_renderer.POLICY["caption"].pin)  # captions stay with their figure
        self.assertFalse(pdf_renderer.MODE["faithful"].allow_reflow)
        self.assertTrue(pdf_renderer.MODE["adaptive"].allow_expansion)

    def test_free_segments_cuts_the_obstacle_out_of_the_column(self) -> None:
        obstacle = pymupdf.Rect(60, 300, 260, 400)
        segments = pdf_renderer.free_segments(50, 700, [obstacle], 50, 280)
        self.assertEqual(len(segments), 2)
        self.assertLess(segments[0][1], 300)  # ends above the obstacle
        self.assertGreater(segments[1][0], 400)  # resumes below it

    def test_free_segments_ignores_an_obstacle_in_the_other_column(self) -> None:
        obstacle = pymupdf.Rect(330, 300, 560, 400)
        segments = pdf_renderer.free_segments(50, 700, [obstacle], 50, 280)
        self.assertEqual(segments, [(50, 700)])

    def test_merge_rects_clusters_overlapping_strokes(self) -> None:
        strokes = [pymupdf.Rect(10, 10, 40, 12), pymupdf.Rect(38, 11, 70, 13), pymupdf.Rect(200, 200, 220, 220)]
        clusters = pdf_renderer._merge_rects(strokes)
        self.assertEqual(len(clusters), 2)

    def test_page_obstacles_finds_images_and_unmasked_text(self) -> None:
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=400)
        page.insert_text((50, 60), "translated away", fontsize=11)
        page.insert_text((50, 200), "preserved formula", fontsize=11)
        masked = [pymupdf.Rect(45, 48, 200, 64)]  # only the first line
        obstacles = pdf_renderer.page_obstacles(page, masked)
        self.assertTrue(any(o.y0 > 180 for o in obstacles), "preserved text must be an obstacle")
        self.assertFalse(any(o.y1 < 70 for o in obstacles), "masked text must not be an obstacle")

    def test_adaptive_flows_text_around_a_figure(self) -> None:
        doc = pymupdf.open(_FIXTURES / "2022_Ito_Sentence_Embedding_Emotion_Recognition.pdf")
        page = doc[0]
        figure = next(pymupdf.Rect(b["bbox"]) for b in page.get_text("dict")["blocks"] if b["type"] == 1)

        # Right-column paragraphs, one of them starting inside the figure band.
        blocks = [
            _block(f"p1-b{i}", 320, 170 + i * 30, 240, 24,
                   "這是一段會重新流動的譯文內容，長度足以產生數行。" * 2)
            for i in range(6)
        ]
        pages = [{"pageNumber": 1, "width": page.rect.width, "height": page.rect.height, "blocks": blocks}]
        rendered = pdf_renderer.render_adaptive(doc.tobytes(), _plan(pages, mode="adaptive"))
        out = pymupdf.open(stream=rendered, filetype="pdf")

        written = [
            pymupdf.Rect(span["bbox"])
            for block in out[0].get_text("dict")["blocks"] if block["type"] == 0
            for line in block["lines"] for span in line["spans"]
            if "重新流動" in span["text"]
        ]
        self.assertTrue(written, "adaptive must write the translations")
        for rect in written:
            overlap = rect & figure
            self.assertTrue(overlap.is_empty or overlap.get_area() < 1,
                            f"translated text at {rect} landed on the figure {figure}")

    def test_adaptive_pins_non_reflowable_blocks_at_their_bbox(self) -> None:
        doc = pymupdf.open(_FIXTURES / "docling-two-column-table.pdf")
        page = doc[0]
        pinned = dict(_block("t0", 323, 200, 120, 14, "表格儲存格"), kind="table")
        pages = [{
            "pageNumber": 1, "width": page.rect.width, "height": page.rect.height,
            "blocks": [pinned, _block("b0", 48, 100, 240, 40, "會流動的段落內容。" * 3)],
        }]
        rendered = pdf_renderer.render_adaptive(doc.tobytes(), _plan(pages, mode="adaptive"))
        out = pymupdf.open(stream=rendered, filetype="pdf")
        cell = next(
            pymupdf.Rect(span["bbox"])
            for block in out[0].get_text("dict")["blocks"] if block["type"] == 0
            for line in block["lines"] for span in line["spans"]
            if "表格儲存格" in span["text"]
        )
        self.assertAlmostEqual(cell.x0, 323, delta=4)
        self.assertAlmostEqual(cell.y0, 200, delta=8)

    def test_adaptive_keeps_the_page_count_when_nothing_overflows(self) -> None:
        doc = pymupdf.open(_FIXTURES / "docling-two-column-table.pdf")
        pages = [{
            "pageNumber": 1, "width": doc[0].rect.width, "height": doc[0].rect.height,
            "blocks": [_block("b0", 48, 100, 240, 40, "短短的譯文。")],
        }]
        rendered = pdf_renderer.render_adaptive(doc.tobytes(), _plan(pages, mode="adaptive"))
        self.assertEqual(len(pymupdf.open(stream=rendered, filetype="pdf")), len(doc))

    def test_adaptive_adds_continuation_pages_right_after_their_source(self) -> None:
        doc = pymupdf.open(_FIXTURES / "docling-two-column-table.pdf")
        pages = [{
            "pageNumber": 1, "width": doc[0].rect.width, "height": doc[0].rect.height,
            "blocks": [_block("huge", 48, 100, 240, 40, "續頁測試內容。" * 800)],
        }]
        rendered = pdf_renderer.render_adaptive(doc.tobytes(), _plan(pages, mode="adaptive"))
        out = pymupdf.open(stream=rendered, filetype="pdf")
        self.assertGreater(len(out), len(doc))
        self.assertLessEqual(len(out), len(doc) + pdf_renderer.MAX_CONTINUATION_PAGES)
        self.assertIn("續頁測試內容", out[1].get_text())  # continuation follows page 1

    def test_adaptive_caps_continuation_pages_and_says_so(self) -> None:
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
            rendered = pdf_renderer.render_adaptive(doc.tobytes(), _plan(pages, mode="adaptive"))
        finally:
            sys.stderr = real
        out = pymupdf.open(stream=rendered, filetype="pdf")
        self.assertLessEqual(len(out), len(doc) + pdf_renderer.MAX_CONTINUATION_PAGES)
        self.assertIn("續頁上限", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
