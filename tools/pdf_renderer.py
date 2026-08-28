#!/usr/bin/env python3
"""PDF renderer that overlays translations onto the original PDF.

Consumes one versioned RenderPlan (src/lib/renderPlan.ts) as --plan-json and
the original PDF on stdin; writes the rendered PDF to stdout.

Render modes:
  - faithful:  original page count, original coordinates, translated text
               overlaid on redacted source glyphs (min font scale respected)
  - adaptive:  flow paragraphs within columns, allow page expansion
  - bilingual: original page + translation page interleaved

Only `faithful` is implemented here. `adaptive` / `bilingual` land with the
flow planner (docs/render-execution-plan.md PR-5 / PR-6); until then they
return a clear error instead of a broken PDF.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

SUPPORTED_PLAN_VERSION = 1

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


def render(pdf_bytes: bytes, plan: dict[str, Any]) -> bytes:
    version = plan.get("version")
    if version != SUPPORTED_PLAN_VERSION:
        raise ValueError(f"不支援的 render plan 版本：{version}（預期 {SUPPORTED_PLAN_VERSION}）")

    mode = plan.get("mode", "faithful")
    if mode == "faithful":
        return render_faithful(pdf_bytes, plan)

    label = {"adaptive": "自適應版", "bilingual": "雙語版"}.get(mode, mode)
    raise NotImplementedError(f"匯出模式「{label}」尚未實作，目前僅支援「忠實版」。")


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
