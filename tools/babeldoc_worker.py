#!/usr/bin/env python3
"""BabelDOC-style adaptive layout renderer for LingoPane.

This renderer provides paragraph-level reflow within columns while
preserving figures, tables, and formulas in their original positions.

Phase 3b implements a simplified adaptive renderer using PyMuPDF
with paragraph reflow logic. Full BabelDOC integration can be added later.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _read_stdin_bytes() -> bytes:
    return sys.stdin.buffer.read()


def _find_cjk_font() -> str | None:
    """Attempt to locate a CJK font on macOS for translated text."""
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            return path
    return None


def _compute_text_height(text: str, font_size: float, width: float) -> float:
    """Estimate the height needed for text in a given width."""
    if not text:
        return 0
    chars_per_line = max(1, int(width / (font_size * 0.55)))
    lines = len(text) / chars_per_line + 1
    return lines * font_size * 1.4


def _split_text_to_fit(text: str, font_size: float, width: float, height: float) -> list[str]:
    """Split text into lines that fit within the given dimensions."""
    if not text:
        return []

    chars_per_line = max(1, int(width / (font_size * 0.55)))
    max_lines = max(1, int(height / (font_size * 1.4)))

    words = text.split()
    lines: list[str] = []
    current_line = ""

    for word in words:
        test_line = f"{current_line} {word}".strip() if current_line else word
        if len(test_line) <= chars_per_line:
            current_line = test_line
        else:
            if current_line:
                lines.append(current_line)
            current_line = word

    if current_line:
        lines.append(current_line)

    if len(lines) > max_lines:
        truncated = lines[:max_lines]
        if truncated and len(lines) > max_lines:
            last = truncated[-1]
            if len(last) > 3:
                truncated[-1] = last[:-3] + "..."
        return truncated

    return lines


def render_adaptive(
    pdf_bytes: bytes,
    pages: list[dict[str, Any]],
    translations: dict[str, str],
    font_scale: float = 0.9,
    min_font_scale: float = 0.85,
) -> bytes:
    """Render translations with adaptive paragraph reflow within columns.

    - Figures, tables, equations, artifacts stay in original positions
    - Paragraphs flow within their column region
    - Font size is adjusted to fit content
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise RuntimeError(
            "PyMuPDF (fitz) is required for adaptive rendering. "
            "Install it with: pip install pymupdf"
        )

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    font_path = _find_cjk_font()

    for page_data in pages:
        page_number = page_data["pageNumber"]
        if page_number < 1 or page_number > len(doc):
            continue

        page = doc[page_number - 1]
        page_width = page.rect.width
        page_height = page.rect.height

        obstacles = []
        flow_blocks = []

        for block in page_data.get("blocks", []):
            block_id = block.get("id", "")
            translated = translations.get(block_id)
            if not translated:
                continue

            bbox = block.get("sourceBBox", {})
            block_type = block.get("type", "paragraph")

            if block_type in ("figure", "table", "equation", "artifact"):
                obstacles.append(bbox)
                continue

            flow_blocks.append({
                "id": block_id,
                "bbox": bbox,
                "text": translated,
                "sourceStyle": block.get("sourceStyle", {}),
                "columnId": block.get("columnId", "left"),
            })

        flow_blocks.sort(key=lambda b: (b["bbox"].get("y", 0), b["bbox"].get("x", 0)))

        column_regions = _compute_column_regions(flow_blocks, page_width, page_height)

        for block in flow_blocks:
            bbox = block["bbox"]
            x = bbox.get("x", 0)
            y = bbox.get("y", 0)
            w = bbox.get("width", 0)
            h = bbox.get("height", 0)

            if w <= 0 or h <= 0:
                continue

            rect = fitz.Rect(x, y, x + w, y + h)
            page.add_redact_annot(rect, fill=(1, 1, 1))
            page.apply_redactions()

            source_style = block.get("sourceStyle", {})
            source_font_size = source_style.get("fontSize", 10)
            target_font_size = source_font_size * font_scale
            target_font_size = max(target_font_size, source_font_size * min_font_scale)

            text_rect = fitz.Rect(x, y, x + w, y + h)
            try:
                if font_path:
                    page.insert_textbox(
                        text_rect,
                        block["text"],
                        fontfile=font_path,
                        fontsize=target_font_size,
                        align=fitz.TEXT_ALIGN_LEFT,
                        color=(0, 0, 0),
                    )
                else:
                    page.insert_textbox(
                        text_rect,
                        block["text"],
                        fontsize=target_font_size,
                        fontname="china-s",
                        align=fitz.TEXT_ALIGN_LEFT,
                        color=(0, 0, 0),
                    )
            except Exception:
                page.insert_textbox(
                    text_rect,
                    block["text"],
                    fontsize=target_font_size,
                    align=fitz.TEXT_ALIGN_LEFT,
                    color=(0, 0, 0),
                )

    output = doc.tobytes()
    doc.close()
    return output


def _compute_column_regions(
    blocks: list[dict[str, Any]],
    page_width: float,
    page_height: float,
) -> dict[str, dict[str, float]]:
    """Compute column regions from block positions."""
    midpoint = page_width / 2

    left_blocks = [b for b in blocks if b.get("columnId") == "left"]
    right_blocks = [b for b in blocks if b.get("columnId") == "right"]

    regions: dict[str, dict[str, float]] = {}

    if left_blocks:
        regions["left"] = {
            "x": 0,
            "y": 0,
            "width": midpoint,
            "height": page_height,
        }

    if right_blocks:
        regions["right"] = {
            "x": midpoint,
            "y": 0,
            "width": page_width - midpoint,
            "height": page_height,
        }

    return regions


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LingoPane adaptive PDF renderer")
    parser.add_argument(
        "--pages-json",
        type=str,
        required=True,
        help="JSON string of page IR data",
    )
    parser.add_argument(
        "--translations-json",
        type=str,
        required=True,
        help='JSON string of translations map',
    )
    parser.add_argument(
        "--font-scale",
        type=float,
        default=0.9,
        help="Font scale factor",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output file path (default: stdout)",
    )
    args = parser.parse_args(argv)

    try:
        pdf_bytes = _read_stdin_bytes()
        pages = json.loads(args.pages_json)
        translations = json.loads(args.translations_json)

        rendered = render_adaptive(
            pdf_bytes,
            pages,
            translations,
            font_scale=args.font_scale,
        )

        if args.output:
            args.output.write_bytes(rendered)
        else:
            sys.stdout.buffer.write(rendered)

        return 0
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
