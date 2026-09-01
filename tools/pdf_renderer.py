#!/usr/bin/env python3
"""PDF renderer that overlays translations onto the original PDF.

Consumes one versioned RenderPlan (src/lib/renderPlan.ts) as --plan-json and
the original PDF on stdin; writes the rendered PDF to stdout.

Render modes:
  - faithful:  original page count, original coordinates, translated text
               overlaid on redacted source glyphs (min font scale respected)
  - bilingual: original page followed by a reflowed translation page
               (+ continuation pages), original left untouched
  - adaptive:  flow paragraphs within columns over the redacted original —
               not implemented yet (PR-6)
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
_CJK_FONTNAME = "china-t"
_CJK_FONT: Any | None = None

# Absolute floor for shrink-to-fit. `minFontScale` is the *preferred* floor;
# we only drop below it (down to this value) to keep an overflowing translation
# visible rather than silently dropped. Real line-aware fitting + continuation
# pages arrive with the flow planner (PR-6).
_HARD_MIN_FONT_PT = 5.0


def _read_stdin_bytes() -> bytes:
    return sys.stdin.buffer.read()


def _cjk_font() -> Any:
    global _CJK_FONT
    if _CJK_FONT is None:
        import pymupdf

        _CJK_FONT = pymupdf.Font(_CJK_FONTNAME)
    return _CJK_FONT


def _fitted_font_size(
    text: str,
    width: float,
    height: float,
    ideal_size: float,
    floor_size: float,
) -> float:
    """One-shot size estimate.

    Returns `ideal_size` when the text plausibly fits, otherwise shrinks it
    toward `floor_size` (never below). This is a coarse guard so `faithful`
    output does not massively overflow; real line-aware fitting arrives with
    the flow planner in PR-6.
    """
    collapsed = " ".join(text.split())
    if not collapsed or width <= 0 or height <= 0:
        return ideal_size

    font = _cjk_font()
    total_width = font.text_length(collapsed, ideal_size)
    line_height = ideal_size * 1.4
    # +1 accounts for the trailing partial line after greedy wrapping.
    estimated_lines = total_width / width + 1
    needed_height = estimated_lines * line_height
    if needed_height <= height:
        return ideal_size

    # Area-style scale so both the extra lines and the per-line width ease off.
    scale = (height / needed_height) ** 0.5
    return max(floor_size, ideal_size * scale)


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


def render_faithful(pdf_bytes: bytes, plan: dict[str, Any]) -> bytes:
    """Overlay translations onto the original PDF, preserving page count/layout."""
    try:
        import pymupdf  # PyMuPDF
    except ImportError:
        raise RuntimeError("需要 PyMuPDF 才能渲染 PDF，請執行 pip install pymupdf")

    font_scale = float(plan.get("fontScale", 0.9) or 0.9)
    min_font_scale = float(plan.get("minFontScale", 0.85) or 0.85)

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

        # Pass 1 — redact every source glyph rect for this page, then apply once.
        # Applying inside the block loop rewrites the whole content stream N
        # times; doing it per page is dramatically faster. Keep images and
        # vector line art (table rules!) untouched — only remove the text.
        for item in renderable:
            for mask_rect in item["mask_rects"]:
                page.add_redact_annot(mask_rect, fill=(1, 1, 1))
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
        )

        # Pass 2 — drop the translated text into the original block boxes.
        for item in renderable:
            overflow_id = _insert_translation(page, item, font_scale, min_font_scale)
            if overflow_id:
                dropped.append(f"p{page_number}:{overflow_id}")

    if dropped:
        print(
            "以下區塊的譯文超出原方框，已縮到最小仍無法完整顯示：" + ", ".join(dropped),
            file=sys.stderr,
        )

    output = doc.tobytes()
    doc.close()
    return output


def _insert_translation(
    page: Any,
    item: dict[str, Any],
    font_scale: float,
    min_font_scale: float,
) -> str | None:
    """Insert one translated block, shrinking to fit. Returns the block id if
    the text still overflowed at the hard minimum size (nothing was written)."""
    import pymupdf

    rect = item["rect"]
    source_size = item["source_font_size"]
    ideal = source_size * font_scale
    soft_floor = source_size * min_font_scale
    size = max(
        _fitted_font_size(item["text"], rect.width, rect.height, ideal, soft_floor),
        soft_floor,
    )

    # insert_textbox writes nothing (and returns a negative value) on overflow,
    # so retrying at smaller sizes never double-prints.
    overflow = page.insert_textbox(
        rect, item["text"], fontsize=size, fontname=_CJK_FONTNAME,
        align=pymupdf.TEXT_ALIGN_LEFT, color=(0, 0, 0),
    )
    while overflow < 0 and size > _HARD_MIN_FONT_PT:
        size = max(_HARD_MIN_FONT_PT, size * 0.85)
        overflow = page.insert_textbox(
            rect, item["text"], fontsize=size, fontname=_CJK_FONTNAME,
            align=pymupdf.TEXT_ALIGN_LEFT, color=(0, 0, 0),
        )
    return item["id"] if overflow < 0 else None


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


def wrap(text: str, font: Any, size: float, width: float) -> list[str]:
    """Greedy wrap using real glyph widths. ASCII runs only break at spaces;
    CJK breaks anywhere except before a leading-forbidden character."""
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
            unit_width = font.text_length(unit, size)
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
    "bilingual": ModeConfig(allow_reflow=True, allow_expansion=True, use_obstacles=False, redact=False),
}


@dataclass
class Remainder:
    block_id: str
    lines: list[str]
    size: float
    kind: str


def _emit_lines(page: Any, lines: list[str], x: float, top: float, size: float, line_height: float) -> None:
    baseline = top + size
    for line in lines:
        if line:
            page.insert_text(
                (x, baseline), line, fontname=_CJK_FONTNAME, fontsize=size, color=(0, 0, 0)
            )
        baseline += line_height


def _place_block(
    page: Any,
    lines: list[str],
    size: float,
    kind: str,
    block_id: str,
    x0: float,
    cursor: float,
    bottom: float,
    line_height: float,
) -> tuple[float, Remainder | None]:
    """Write as many lines as fit from `cursor`; return (new_cursor, remainder)."""
    room = bottom - cursor
    fits = max(0, int(room / line_height))
    if fits >= len(lines):
        _emit_lines(page, lines, x0, cursor, size, line_height)
        return cursor + len(lines) * line_height + _GAP_AFTER.get(kind, 4.0), None
    if fits > 0:
        _emit_lines(page, lines[:fits], x0, cursor, size, line_height)
        return bottom, Remainder(block_id, lines[fits:], size, kind)
    return bottom, Remainder(block_id, lines, size, kind)


def _flow_blocks(
    page: Any,
    blocks: list[dict[str, Any]],
    columns: list[tuple[float, float]],
    bands: list[tuple[float, float]],
    font: Any,
    line_height: float,
    font_scale: float,
    min_font_scale: float,
) -> list[Remainder]:
    top, bottom = _PAGE_MARGIN, page.rect.height - _PAGE_MARGIN
    cursors = [top] * len(columns)
    remainders: list[Remainder] = []

    def column_of(block: dict[str, Any]) -> int | None:
        width = block["bbox"]["width"]
        if len(columns) == 1 or width > page.rect.width * 0.7:
            return None  # spanning
        center = block["bbox"]["x"] + width / 2
        return min(
            range(len(bands)),
            key=lambda i: abs(center - (bands[i][0] + bands[i][1]) / 2),
        )

    full_width_column = (_PAGE_MARGIN, page.rect.width - _PAGE_MARGIN)
    for block in blocks:
        kind = block.get("kind", "text")
        if not POLICY[kind].render:
            continue
        size = block.get("fontSize", 10) * font_scale
        column_index = column_of(block)
        x0, x1 = full_width_column if column_index is None else columns[column_index]
        width = x1 - x0

        lines = wrap(block.get("text", ""), font, size, width)
        needed = len(lines) * size * line_height
        start_cursor = max(cursors) if column_index is None else cursors[column_index]
        if POLICY[kind].shrink and start_cursor + needed > bottom:
            shrunk = block.get("fontSize", 10) * min_font_scale
            shrunk_lines = wrap(block.get("text", ""), font, shrunk, width)
            if len(shrunk_lines) * shrunk * line_height <= bottom - start_cursor:
                size, lines = shrunk, shrunk_lines

        new_cursor, remainder = _place_block(
            page, lines, size, kind, block.get("id", ""), x0, start_cursor, bottom, size * line_height
        )
        if remainder is not None:
            remainders.append(remainder)
        if column_index is None:
            cursors = [new_cursor] * len(columns)
        else:
            cursors[column_index] = new_cursor

    return remainders


def _flow_remainders(page: Any, remainders: list[Remainder], line_height: float) -> list[Remainder]:
    """Continuation page: one full-width column, no reflow decisions left."""
    top, bottom = _PAGE_MARGIN, page.rect.height - _PAGE_MARGIN
    x0 = _PAGE_MARGIN
    cursor = top
    still: list[Remainder] = []
    for remainder in remainders:
        if still:
            still.append(remainder)
            continue
        cursor, leftover = _place_block(
            page, remainder.lines, remainder.size, remainder.kind, remainder.block_id,
            x0, cursor, bottom, remainder.size * line_height,
        )
        if leftover is not None:
            still.append(leftover)
    return still


def render_bilingual(pdf_bytes: bytes, plan: dict[str, Any]) -> bytes:
    """Original page, then a reflowed translation page (+ continuation pages)."""
    import pymupdf

    source = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    output = pymupdf.open()
    font = _cjk_font()
    line_height = line_height_ratio(plan.get("targetLanguage", ""))
    font_scale = float(plan.get("fontScale", 0.9) or 0.9)
    min_font_scale = float(plan.get("minFontScale", 0.85) or 0.85)
    plan_by_page = {int(page["pageNumber"]): page for page in plan.get("pages", [])}
    overflowed: list[int] = []

    for page_index in range(len(source)):
        page_number = page_index + 1
        output.insert_pdf(source, from_page=page_index, to_page=page_index)

        page_plan = plan_by_page.get(page_number)
        if not page_plan:
            continue
        source_page = source[page_index]
        _assert_same_coordinate_system(source_page, page_plan, page_number)

        width, height = source_page.rect.width, source_page.rect.height
        bands = detect_columns(page_plan["blocks"], width)
        columns = _bands_to_columns(bands, width)

        translation_page = output.new_page(width=width, height=height)
        remainders = _flow_blocks(
            translation_page, page_plan["blocks"], columns, bands,
            font, line_height, font_scale, min_font_scale,
        )

        continuation = 0
        while remainders and continuation < MAX_CONTINUATION_PAGES:
            continuation += 1
            cont_page = output.new_page(width=width, height=height)
            remainders = _flow_remainders(cont_page, remainders, line_height)
        if remainders:
            overflowed.append(page_number)

    if overflowed:
        print(
            f"以下頁面的譯文超過 {MAX_CONTINUATION_PAGES} 頁續頁上限，尾段未輸出："
            + ", ".join(str(n) for n in overflowed),
            file=sys.stderr,
        )

    result = output.tobytes()
    output.close()
    source.close()
    return result


def _bands_to_columns(bands: list[tuple[float, float]], page_width: float) -> list[tuple[float, float]]:
    """Map detected bands into the page's margin box."""
    if len(bands) <= 1:
        return [(_PAGE_MARGIN, page_width - _PAGE_MARGIN)]
    usable = page_width - 2 * _PAGE_MARGIN
    span_start, span_end = bands[0][0], bands[-1][1]
    total = max(1.0, span_end - span_start)
    gutter = 12.0
    columns = []
    for start, end in bands:
        left = _PAGE_MARGIN + (start - span_start) / total * usable
        right = _PAGE_MARGIN + (end - span_start) / total * usable
        columns.append((left + gutter / 2, right - gutter / 2))
    return columns


def render(pdf_bytes: bytes, plan: dict[str, Any]) -> bytes:
    version = plan.get("version")
    if version != SUPPORTED_PLAN_VERSION:
        raise ValueError(f"不支援的 render plan 版本：{version}（預期 {SUPPORTED_PLAN_VERSION}）")

    mode = plan.get("mode", "faithful")
    if mode == "faithful":
        return render_faithful(pdf_bytes, plan)
    if mode == "bilingual":
        return render_bilingual(pdf_bytes, plan)

    label = {"adaptive": "自適應版"}.get(mode, mode)
    raise NotImplementedError(f"匯出模式「{label}」尚未實作。")


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
