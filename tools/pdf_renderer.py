#!/usr/bin/env python3
"""PDF renderer that overlays translations onto the original PDF.

Consumes one versioned RenderPlan (src/lib/renderPlan.ts) as --plan-json and
the original PDF on stdin; writes the rendered PDF to stdout.

Render modes:
  - faithful: original page count and coordinates; each translation is written
              back into its own source box, shrinking to fit
  - adaptive: paragraphs reflow within their detected column over the redacted
              original, flowing around figures / tables / formulas, spilling
              onto continuation pages

Both share one text-measurement path (`wrap` on real glyph widths, per-run
fonts) and one column/obstacle model; they differ only in the ModeConfig they
run under.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Any

SUPPORTED_PLAN_VERSION = 1

# A page that still overflows after this many continuation pages is a layout
# failure; stop rather than grow the document without bound (PR-5 2-5).
MAX_CONTINUATION_PAGES = 3
_PAGE_MARGIN = 40.0

# The bundled CJK code covers Traditional/Simplified Chinese, Japanese and
# Korean glyphs via MuPDF's fallback font (verified on PyMuPDF 1.28). The old
# fontfile lookup pointed at /System/Library/Fonts/PingFang.ttc, which does not
# exist on modern macOS, so every fontfile call silently fell through.
#
# Latin runs use Helvetica instead. Two reasons, and the second is a
# correctness one: `page.insert_text(fontname="china-t")` gives *every* glyph a
# full-width CID advance — "Manabu Ito 2022" renders 150pt wide while
# `Font("china-t").text_length()` reports 76.8pt for the same string. Measuring
# with one metric and drawing with another overflowed every line containing
# Latin text. Everything is drawn through a TextWriter with these Font objects
# now, so the width used to wrap is the width that reaches the page.
_CJK_FONTNAME = "china-t"
_LATIN_FONTNAME = "helv"
_FONT_CACHE: dict[str, Any] = {}

# Absolute floor for shrink-to-fit. `minFontScale` is the *preferred* floor;
# we only drop below it (down to this value) to keep an overflowing translation
# visible rather than silently dropped.
_HARD_MIN_FONT_PT = 5.0
# Leading for text written back into a fixed source box, which was laid out for
# single-spaced original text. Reflowed text uses the language ratio instead.
_TIGHT_LINE_HEIGHT = 1.25


def _read_stdin_bytes() -> bytes:
    return sys.stdin.buffer.read()


def _font(name: str) -> Any:
    import pymupdf

    if name not in _FONT_CACHE:
        _FONT_CACHE[name] = pymupdf.Font(name)
    return _FONT_CACHE[name]


def _cjk_font() -> Any:
    return _font(_CJK_FONTNAME)


def _font_for(unit: str) -> Any:
    """Pick the face for one wrap unit. CJK always goes to the fallback font;
    Latin prefers Helvetica but defers to the fallback for anything Helvetica
    cannot draw (accented forms outside its encoding, symbols, …)."""
    cjk = _cjk_font()
    if any(_is_cjk(ch) for ch in unit):
        return cjk
    latin = _font(_LATIN_FONTNAME)
    return latin if all(latin.has_glyph(ord(ch)) for ch in unit) else cjk


def _runs(line: str) -> list[tuple[str, Any]]:
    """Group a rendered line into consecutive same-font runs."""
    runs: list[tuple[str, Any]] = []
    for unit in _tokenize(line):
        font = _font_for(unit)
        if runs and runs[-1][1] is font:
            runs[-1] = (runs[-1][0] + unit, font)
        else:
            runs.append((unit, font))
    return runs


def _text_width(text: str, size: float) -> float:
    return sum(font.text_length(run, size) for run, font in _runs(text))


class TextCanvas:
    """One TextWriter per page.

    Writing per block would append a content stream per block; batching keeps
    the output small and the run order stable.
    """

    def __init__(self, page: Any):
        import pymupdf

        self.page = page
        self.writer = pymupdf.TextWriter(page.rect)
        self._used = False

    @property
    def rect(self) -> Any:
        return self.page.rect

    def draw(self, text: str, x: float, baseline: float, size: float) -> None:
        cursor = x
        for run, font in _runs(text):
            if not run:
                continue
            self.writer.append((cursor, baseline), run, font=font, fontsize=size)
            cursor += font.text_length(run, size)
            self._used = True

    def flush(self) -> None:
        if self._used:
            self.writer.write_text(self.page, color=(0, 0, 0))
            self._used = False


def _iter_renderable_blocks(page_plan: dict[str, Any]):
    import pymupdf

    for block in page_plan.get("blocks", []):
        text = block.get("text", "")
        bbox = block.get("bbox", {})
        x = bbox.get("x", 0)
        y = bbox.get("y", 0)
        w = bbox.get("width", 0)
        h = bbox.get("height", 0)
        if not text or w <= 0 or h <= 0:
            continue

        raw_masks = block.get("maskRects") or [{"x": x, "y": y, "width": w, "height": h}]
        mask_rects = []
        for mask in raw_masks:
            mw = mask.get("width", 0)
            mh = mask.get("height", 0)
            if mw <= 0 or mh <= 0:
                continue
            mx = mask.get("x", 0)
            my = mask.get("y", 0)
            mask_rects.append(pymupdf.Rect(mx, my, mx + mw, my + mh))
        if not mask_rects:
            mask_rects = [pymupdf.Rect(x, y, x + w, y + h)]

        yield {
            "id": block.get("id", ""),
            "text": text,
            "rect": pymupdf.Rect(x, y, x + w, y + h),
            "mask_rects": mask_rects,
            "source_font_size": float(block.get("fontSize", 10) or 10),
        }


def _assert_same_coordinate_system(page: Any, page_plan: dict[str, Any], page_number: int) -> None:
    """PDF.js viewport (scale 1) and PyMuPDF page.rect are both top-left origin,
    y-down — but a /Rotate entry or a non-zero CropBox origin makes them
    diverge. Fail loudly instead of misplacing every block."""
    plan_w = float(page_plan.get("width", 0) or 0)
    plan_h = float(page_plan.get("height", 0) or 0)
    if plan_w <= 0 or plan_h <= 0:
        return
    if abs(page.rect.width - plan_w) > 1 or abs(page.rect.height - plan_h) > 1:
        raise ValueError(
            f"第 {page_number} 頁座標系不一致："
            f"plan {plan_w:.0f}x{plan_h:.0f} vs page {page.rect.width:.0f}x{page.rect.height:.0f}"
        )


def _redact_source_text(page: Any, mask_rects: list[Any]) -> None:
    """White out the source glyphs, once per page.

    Applying inside a per-block loop rewrites the whole content stream N times.
    `images` / `graphics` must both be set: the defaults erase intersecting
    images *and* vector line art, which would take the table rules with them.
    """
    import pymupdf

    for rect in mask_rects:
        page.add_redact_annot(rect, fill=(1, 1, 1))
    page.apply_redactions(
        images=pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
    )


def render_faithful(pdf_bytes: bytes, plan: dict[str, Any]) -> bytes:
    """Overlay translations onto the original PDF, preserving page count/layout."""
    try:
        import pymupdf  # PyMuPDF
    except ImportError:
        raise RuntimeError("需要 PyMuPDF 才能渲染 PDF，請執行 pip install pymupdf")

    font_scale = float(plan.get("fontScale", 0.9) or 0.9)
    min_font_scale = float(plan.get("minFontScale", 0.85) or 0.85)
    ratio = line_height_ratio(plan.get("targetLanguage", ""))

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    dropped: list[str] = []

    for page_plan in plan.get("pages", []):
        page_number = int(page_plan.get("pageNumber", 0) or 0)
        if page_number < 1 or page_number > len(doc):
            continue

        page = doc[page_number - 1]
        _assert_same_coordinate_system(page, page_plan, page_number)

        renderable = list(_iter_renderable_blocks(page_plan))
        if not renderable:
            continue

        _redact_source_text(page, [r for item in renderable for r in item["mask_rects"]])

        canvas = TextCanvas(page)
        for item in renderable:
            overflowed = _insert_at_rect(
                canvas, item["text"], item["rect"], item["source_font_size"],
                ratio, font_scale, min_font_scale,
            )
            if overflowed:
                dropped.append(f"p{page_number}:{item['id']}")
        canvas.flush()

    if dropped:
        print(
            "以下區塊的譯文超出原方框，已縮到最小仍無法完整顯示：" + ", ".join(dropped),
            file=sys.stderr,
        )

    output = doc.tobytes()
    doc.close()
    return output


def _insert_at_rect(
    canvas: TextCanvas,
    text: str,
    rect: Any,
    source_size: float,
    line_height_ratio_value: float,
    font_scale: float,
    min_font_scale: float,
) -> bool:
    """Write `text` inside its original bbox, shrinking until the wrapped lines
    fit. Returns True if some text still did not fit (what fits is written).

    Shared by `faithful` and by `adaptive`'s pinned blocks so there is a single
    text-measurement path (PR-6 2-8); the old `insert_textbox` call did its own
    wrapping, which meant two different line-breaking implementations and no
    CJK 行首禁則 in faithful.
    """
    if not text or rect.width <= 0 or rect.height <= 0:
        return False

    # The original box was laid out for single-spaced source text, so in-place
    # placement uses tighter leading than reflowed text gets.
    ratio = min(line_height_ratio_value, _TIGHT_LINE_HEIGHT)
    size = source_size * font_scale
    soft_floor = max(_HARD_MIN_FONT_PT, source_size * min_font_scale)
    lines = wrap(text, size, rect.width)

    for floor in (soft_floor, _HARD_MIN_FONT_PT):
        while len(lines) * size * ratio > rect.height and size > floor:
            size = max(floor, size * 0.9)
            lines = wrap(text, size, rect.width)

    line_height = size * ratio
    fits = max(0, int(rect.height / line_height)) if line_height > 0 else 0
    _emit_lines(canvas, lines[:fits], rect.x0, rect.y0, size, line_height)
    return fits < len(lines)


# --------------------------------------------------------------------------- #
# Flow planner (PR-5): text measurement, column detection, block policy.
# --------------------------------------------------------------------------- #
_LINE_HEIGHT_BY_LANG = {"zh-tw": 1.5, "zh": 1.5, "zh-hant": 1.5, "ja": 1.5, "ko": 1.5}
_DEFAULT_LINE_HEIGHT = 1.35
# Characters that must not start a wrapped line (CJK 行首禁則).
_LEADING_FORBIDDEN = set("。，、；：？！）」』》〉】〕｝”’…—～%")
_GAP_AFTER = {"heading": 7.0, "text": 4.0, "caption": 3.0, "table": 4.0}


def line_height_ratio(target_language: str) -> float:
    return _LINE_HEIGHT_BY_LANG.get((target_language or "").lower(), _DEFAULT_LINE_HEIGHT)


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x3000 <= o <= 0x9FFF  # CJK punctuation + kana + unified ideographs
        or 0xAC00 <= o <= 0xD7A3  # hangul
        or 0xF900 <= o <= 0xFAFF  # compatibility ideographs
        or 0xFF00 <= o <= 0xFFEF  # fullwidth / halfwidth forms
    )


def _tokenize(text: str) -> list[str]:
    """Break a paragraph into wrap units: whole ASCII words, single spaces, and
    individual CJK characters."""
    units: list[str] = []
    buf = ""
    for ch in text:
        if ch == " ":
            if buf:
                units.append(buf)
                buf = ""
            units.append(" ")
        elif _is_cjk(ch):
            if buf:
                units.append(buf)
                buf = ""
            units.append(ch)
        else:
            buf += ch
    if buf:
        units.append(buf)
    return units


def wrap(text: str, size: float, width: float) -> list[str]:
    """Greedy wrap using real glyph widths. ASCII runs only break at spaces;
    CJK breaks anywhere except before a leading-forbidden character.

    Each unit is measured with the face it will actually be drawn in, so the
    width computed here is the width that reaches the page.
    """
    if not text:
        return []
    if width <= 0 or size <= 0:
        return text.split("\n")

    lines: list[str] = []
    for paragraph in text.split("\n"):
        units = _tokenize(paragraph)
        if not units:
            lines.append("")
            continue
        line = ""
        line_width = 0.0
        for unit in units:
            unit_width = _font_for(unit).text_length(unit, size)
            if line and line_width + unit_width > width and unit != " ":
                if unit in _LEADING_FORBIDDEN:
                    line += unit  # keep the punctuation on this line
                    lines.append(line.rstrip())
                    line, line_width = "", 0.0
                    continue
                lines.append(line.rstrip())
                line, line_width = "", 0.0
            if unit == " " and not line:
                continue  # no leading space on a fresh line
            line += unit
            line_width += unit_width
        if line.strip() or not lines:
            lines.append(line.rstrip())
    return lines


def detect_columns(blocks: list[dict[str, Any]], page_width: float) -> list[tuple[float, float]]:
    """Column bands as [(x_start, x_end), ...] via a coverage histogram of
    flowable block x-extents: a gutter is a vertical strip that almost no line
    crosses. Falls back to one full-width column when the result is unreliable
    (PR-5 2-2). A stray line crossing the gutter no longer merges the columns."""
    single = [(0.0, page_width)]
    # Blocks at least half the page wide are spanning candidates (titles,
    # full-width intro lines) — they must not vote on where the gutter is.
    spans = [
        (block["bbox"]["x"], block["bbox"]["x"] + block["bbox"]["width"])
        for block in blocks
        if POLICY[block.get("kind", "text")].reflow
        and block["bbox"]["width"] < page_width * 0.5
    ]
    if len(spans) < 6:
        return single

    bins = 80
    bin_width = page_width / bins
    coverage = [0] * bins
    for start, end in spans:
        for index in range(max(0, int(start / bin_width)), min(bins, int(end / bin_width) + 1)):
            coverage[index] += 1
    peak = max(coverage)
    if peak == 0:
        return single

    # A true gutter still catches the odd centred subtitle or running head, so
    # judge "covered" against a share of the column peak, not zero.
    covered = [count > peak * 0.25 for count in coverage]
    bands: list[tuple[float, float]] = []
    index = 0
    while index < bins:
        if covered[index]:
            run_start = index
            while index < bins and covered[index]:
                index += 1
            bands.append((run_start * bin_width, index * bin_width))
        else:
            index += 1

    # Merge bands separated by only a hairline gutter.
    gap_min = max(9.0, page_width * 0.02)
    merged: list[tuple[float, float]] = []
    for band in bands:
        if merged and band[0] - merged[-1][1] < gap_min:
            merged[-1] = (merged[-1][0], band[1])
        else:
            merged.append(band)

    if len(merged) < 2 or len(merged) > 4:
        return single
    if any((end - start) < page_width * 0.12 for start, end in merged):
        return single
    return merged


@dataclass(frozen=True)
class Policy:
    reflow: bool  # may leave its original y position
    shrink: bool  # may drop below the ideal font size to fit
    pin: bool  # an obstacle other text must avoid (only when use_obstacles)
    render: bool = True


POLICY: dict[str, Policy] = {
    "text": Policy(reflow=True, shrink=True, pin=False),
    "heading": Policy(reflow=True, shrink=True, pin=False),
    "caption": Policy(reflow=False, shrink=True, pin=True),
    "table": Policy(reflow=False, shrink=True, pin=True),
    "formula": Policy(reflow=False, shrink=False, pin=True),
    "artifact": Policy(reflow=False, shrink=False, pin=True, render=False),
}


@dataclass(frozen=True)
class ModeConfig:
    allow_reflow: bool
    allow_expansion: bool
    use_obstacles: bool
    redact: bool


MODE: dict[str, ModeConfig] = {
    "faithful": ModeConfig(allow_reflow=False, allow_expansion=False, use_obstacles=True, redact=True),
    "adaptive": ModeConfig(allow_reflow=True, allow_expansion=True, use_obstacles=True, redact=True),
}


@dataclass
class Remainder:
    block_id: str
    lines: list[str]
    size: float
    kind: str


def _emit_lines(
    canvas: TextCanvas, lines: list[str], x: float, top: float, size: float, line_height: float
) -> None:
    baseline = top + size
    for line in lines:
        if line:
            canvas.draw(line, x, baseline, size)
        baseline += line_height


# --------------------------------------------------------------------------- #
# Obstacles (PR-6 2-6)
#
# The RenderPlan only carries *translated text* — buildRenderPlan() drops
# formulas, artifacts and anything untranslated. So the things reflowed text
# must not land on are derived from the page itself, which also works in fast
# mode where pdfLayout.ts never sees figures at all.
# --------------------------------------------------------------------------- #
_OBSTACLE_GAP = 6.0
_MAX_DRAWINGS_SCANNED = 2000


def _merge_rects(rects: list[Any], pad: float = 2.0) -> list[Any]:
    """Union overlapping/touching rects into clusters (a figure is drawn as many
    small strokes; only the cluster is a meaningful obstacle)."""
    import pymupdf

    clusters: list[Any] = []
    for rect in rects:
        grown = pymupdf.Rect(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad)
        merged_into = None
        for index, cluster in enumerate(clusters):
            if cluster.intersects(grown):
                clusters[index] = cluster | grown
                merged_into = index
                break
        if merged_into is None:
            clusters.append(grown)
        else:
            # One merge can bridge two existing clusters; collapse again.
            changed = True
            while changed:
                changed = False
                for other in range(len(clusters) - 1, -1, -1):
                    if other != merged_into and clusters[other].intersects(clusters[merged_into]):
                        clusters[merged_into] = clusters[merged_into] | clusters[other]
                        del clusters[other]
                        if other < merged_into:
                            merged_into -= 1
                        changed = True
                        break
    return clusters


def page_obstacles(page: Any, mask_rects: list[Any]) -> list[Any]:
    """Regions reflowed text must avoid: images, sizeable vector art, and any
    source text that is *not* being redacted (formulas, headers, untranslated
    blocks)."""
    import pymupdf

    obstacles: list[Any] = []
    preserved_text: list[Any] = []
    page_area = max(1.0, page.rect.width * page.rect.height)

    def is_masked(rect: Any) -> bool:
        # Compare against the *union* of the masks, not each one alone: a mask
        # rect is per text item, so several of them together cover one span and
        # none of them covers it on its own.
        rect_area = max(1.0, rect.width * rect.height)
        covered = 0.0
        for mask in mask_rects:
            overlap = rect & mask
            if not overlap.is_empty:
                covered += overlap.width * overlap.height
                if covered > rect_area * 0.3:
                    return True
        return False

    for block in page.get_text("dict")["blocks"]:
        if block.get("type") == 1:  # image
            obstacles.append(pymupdf.Rect(block["bbox"]))
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                span_rect = pymupdf.Rect(span["bbox"])
                if span_rect.is_empty or not span["text"].strip() or is_masked(span_rect):
                    continue
                preserved_text.append(span_rect)

    # Adjacent leftover spans belong to one region (a formula, a running head);
    # cluster them so the flow sees a few blocks rather than dozens of slivers.
    obstacles.extend(_merge_rects(preserved_text, pad=3.0))

    drawings = page.get_drawings()[:_MAX_DRAWINGS_SCANNED]
    for cluster in _merge_rects([d["rect"] for d in drawings if not d["rect"].is_empty]):
        # Ignore hairlines (table rules, underlines, page borders); they carry no
        # content of their own and would otherwise fence off whole columns.
        if cluster.width < 12 or cluster.height < 12:
            continue
        if cluster.width * cluster.height < page_area * 0.005:
            continue
        obstacles.append(cluster)

    return obstacles


def free_segments(
    top: float,
    bottom: float,
    obstacles: list[Any],
    x0: float,
    x1: float,
) -> list[tuple[float, float]]:
    """Vertical runs of [top, bottom] left usable in the column [x0, x1] once the
    obstacles overlapping it horizontally are cut out."""
    column_width = max(1.0, x1 - x0)
    blocked: list[list[float]] = []
    for obstacle in obstacles:
        overlap = min(obstacle.x1, x1) - max(obstacle.x0, x0)
        if overlap <= 0:
            continue
        if overlap / min(column_width, max(1.0, obstacle.width)) <= 0.4:
            continue
        blocked.append([obstacle.y0 - _OBSTACLE_GAP, obstacle.y1 + _OBSTACLE_GAP])

    blocked.sort()
    merged: list[list[float]] = []
    for start, end in blocked:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    segments: list[tuple[float, float]] = []
    cursor = top
    for start, end in merged:
        if start > cursor:
            segments.append((cursor, min(start, bottom)))
        cursor = max(cursor, end)
        if cursor >= bottom:
            break
    if cursor < bottom:
        segments.append((cursor, bottom))
    return [(a, b) for a, b in segments if b - a > 1]


class ColumnFlow:
    """A column plus the free vertical segments text may occupy in it."""

    def __init__(self, x0: float, x1: float, segments: list[tuple[float, float]]):
        self.x0 = x0
        self.x1 = x1
        self.segments = segments or [(0.0, 0.0)]
        self.index = 0
        self.cursor = self.segments[0][0]

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    def remaining(self) -> float:
        """Total height still available across this column's segments."""
        if self.index >= len(self.segments):
            return 0.0
        total = self.segments[self.index][1] - self.cursor
        for start, end in self.segments[self.index + 1 :]:
            total += end - start
        return max(0.0, total)

    def place(
        self, canvas: TextCanvas, lines: list[str], size: float, kind: str, block_id: str, line_height: float
    ) -> Remainder | None:
        """Fill segments in order; return whatever did not fit in this column."""
        pending = list(lines)
        while pending and self.index < len(self.segments):
            _, segment_end = self.segments[self.index]
            fits = max(0, int((segment_end - self.cursor) / line_height))
            if fits == 0:
                self.index += 1
                if self.index < len(self.segments):
                    self.cursor = self.segments[self.index][0]
                continue
            take = pending[:fits]
            _emit_lines(canvas, take, self.x0, self.cursor, size, line_height)
            self.cursor += len(take) * line_height
            pending = pending[fits:]
            if pending:
                self.index += 1
                if self.index < len(self.segments):
                    self.cursor = self.segments[self.index][0]
        if pending:
            return Remainder(block_id, pending, size, kind)
        self.cursor += _GAP_AFTER.get(kind, 4.0)
        return None


def _flow_blocks(
    canvas: TextCanvas,
    blocks: list[dict[str, Any]],
    columns: list[tuple[float, float]],
    bands: list[tuple[float, float]],
    line_height: float,
    font_scale: float,
    min_font_scale: float,
    obstacles: list[Any],
) -> list[Remainder]:
    """Flow the plan's blocks down `columns`, skipping `obstacles`.

    Blocks whose policy says they must not move are written back at their own
    bbox and become one more obstacle for everything that does flow.
    """
    import pymupdf

    obstacles = list(obstacles)
    page_rect = canvas.rect
    top, bottom = _PAGE_MARGIN, page_rect.height - _PAGE_MARGIN
    remainders: list[Remainder] = []

    for block in blocks:
        kind = block.get("kind", "text")
        if POLICY[kind].reflow or not POLICY[kind].render:
            continue
        bbox = block["bbox"]
        rect = pymupdf.Rect(bbox["x"], bbox["y"], bbox["x"] + bbox["width"], bbox["y"] + bbox["height"])
        _insert_at_rect(canvas, block.get("text", ""), rect, block.get("fontSize", 10) or 10,
                        line_height, font_scale, min_font_scale)
        obstacles.append(rect)

    flows = [ColumnFlow(x0, x1, free_segments(top, bottom, obstacles, x0, x1)) for x0, x1 in columns]
    span_x0, span_x1 = _PAGE_MARGIN, page_rect.width - _PAGE_MARGIN
    span_flow_segments = free_segments(top, bottom, obstacles, span_x0, span_x1)

    def column_of(block: dict[str, Any]) -> int | None:
        width = block["bbox"]["width"]
        if len(columns) == 1 or width > page_rect.width * 0.7:
            return None  # spanning
        center = block["bbox"]["x"] + width / 2
        return min(
            range(len(bands)),
            key=lambda i: abs(center - (bands[i][0] + bands[i][1]) / 2),
        )

    for block in blocks:
        kind = block.get("kind", "text")
        if not POLICY[kind].render or not POLICY[kind].reflow:
            continue  # pinned blocks were placed at their own bbox above

        column_index = column_of(block)
        if column_index is None:
            # A spanning block resumes below whatever the columns have used.
            flow = ColumnFlow(span_x0, span_x1, span_flow_segments)
            lowest = max((f.cursor for f in flows), default=top)
            while flow.index < len(flow.segments) and flow.segments[flow.index][1] <= lowest:
                flow.index += 1
            if flow.index < len(flow.segments):
                flow.cursor = max(flow.segments[flow.index][0], lowest)
        else:
            flow = flows[column_index]

        source_size = block.get("fontSize", 10) or 10
        size = source_size * font_scale
        lines = wrap(block.get("text", ""), size, flow.width)
        if POLICY[kind].shrink and len(lines) * size * line_height > flow.remaining():
            shrunk = source_size * min_font_scale
            shrunk_lines = wrap(block.get("text", ""), shrunk, flow.width)
            if len(shrunk_lines) * shrunk * line_height <= flow.remaining():
                size, lines = shrunk, shrunk_lines

        remainder = flow.place(canvas, lines, size, kind, block.get("id", ""), size * line_height)
        if remainder is not None:
            remainders.append(remainder)
        if column_index is None:
            for other in flows:
                if other.cursor < flow.cursor:
                    other.cursor = flow.cursor

    return remainders


def _flow_remainders(canvas: TextCanvas, remainders: list[Remainder], line_height: float) -> list[Remainder]:
    """Continuation page: one full-width column, no reflow decisions left."""
    top, bottom = _PAGE_MARGIN, canvas.rect.height - _PAGE_MARGIN
    flow = ColumnFlow(_PAGE_MARGIN, canvas.rect.width - _PAGE_MARGIN, [(top, bottom)])
    still: list[Remainder] = []
    for remainder in remainders:
        if still:
            still.append(remainder)
            continue
        leftover = flow.place(
            canvas, remainder.lines, remainder.size, remainder.kind,
            remainder.block_id, remainder.size * line_height,
        )
        if leftover is not None:
            still.append(leftover)
    return still


def render_adaptive(pdf_bytes: bytes, plan: dict[str, Any]) -> bytes:
    """Reflow paragraphs within their column over the redacted original page.

    Figures, tables, formulas and any untranslated source text stay exactly
    where they are; body text flows around them and spills onto continuation
    pages inserted right after the page it came from.
    """
    import pymupdf

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    ratio = line_height_ratio(plan.get("targetLanguage", ""))
    font_scale = float(plan.get("fontScale", 0.9) or 0.9)
    min_font_scale = float(plan.get("minFontScale", 0.85) or 0.85)

    # (page_index, remainders) — continuation pages are inserted afterwards, in
    # reverse order, so earlier page indices stay valid while we do it.
    pending: list[tuple[int, list[Remainder]]] = []
    overflowed: list[int] = []

    for page_plan in plan.get("pages", []):
        page_number = int(page_plan.get("pageNumber", 0) or 0)
        if page_number < 1 or page_number > len(doc):
            continue

        page = doc[page_number - 1]
        _assert_same_coordinate_system(page, page_plan, page_number)
        renderable = list(_iter_renderable_blocks(page_plan))
        if not renderable:
            continue

        masks = [rect for item in renderable for rect in item["mask_rects"]]
        # Obstacles must be read before redaction, while the source text that is
        # *not* being replaced is still on the page.
        obstacles = page_obstacles(page, masks)
        _redact_source_text(page, masks)

        bands = detect_columns(page_plan["blocks"], page.rect.width)
        # Text is written back onto the original page, so the detected bands are
        # used as-is rather than remapped into the page margins.
        columns = (
            [(_PAGE_MARGIN, page.rect.width - _PAGE_MARGIN)] if len(bands) <= 1 else list(bands)
        )

        canvas = TextCanvas(page)
        remainders = _flow_blocks(
            canvas, page_plan["blocks"], columns, bands, ratio,
            font_scale, min_font_scale, obstacles,
        )
        canvas.flush()
        if remainders:
            pending.append((page_number - 1, remainders))

    for page_index, remainders in reversed(pending):
        source_rect = doc[page_index].rect
        continuation = 0
        while remainders and continuation < MAX_CONTINUATION_PAGES:
            continuation += 1
            cont_page = doc.new_page(
                pno=page_index + continuation,
                width=source_rect.width,
                height=source_rect.height,
            )
            cont_canvas = TextCanvas(cont_page)
            remainders = _flow_remainders(cont_canvas, remainders, ratio)
            cont_canvas.flush()
        if remainders:
            overflowed.append(page_index + 1)

    if overflowed:
        print(
            f"以下頁面的譯文超過 {MAX_CONTINUATION_PAGES} 頁續頁上限，尾段未輸出："
            + ", ".join(str(n) for n in sorted(overflowed)),
            file=sys.stderr,
        )

    output = doc.tobytes()
    doc.close()
    return output


def render(pdf_bytes: bytes, plan: dict[str, Any]) -> bytes:
    version = plan.get("version")
    if version != SUPPORTED_PLAN_VERSION:
        raise ValueError(f"不支援的 render plan 版本：{version}（預期 {SUPPORTED_PLAN_VERSION}）")

    mode = plan.get("mode", "faithful")
    renderers = {
        "faithful": render_faithful,
        "adaptive": render_adaptive,
    }
    if mode not in renderers:
        raise NotImplementedError(f"未知的匯出模式「{mode}」。")
    return renderers[mode](pdf_bytes, plan)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LingoPane PDF renderer")
    parser.add_argument("--plan-json", type=str, required=True, help="RenderPlan as a JSON string")
    args = parser.parse_args(argv)

    try:
        pdf_bytes = _read_stdin_bytes()
        plan = json.loads(args.plan_json)
        sys.stdout.buffer.write(render(pdf_bytes, plan))
        return 0
    except NotImplementedError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
