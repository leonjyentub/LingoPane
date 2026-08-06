#!/usr/bin/env python3
"""PDF renderer that overlays translations onto the original PDF.

Supports three render modes:
  - faithful: Original page count, original coordinates, font shrink (min 85%)
  - adaptive: Flow paragraphs within columns, allow page expansion (Phase 3b)
  - bilingual: Original page + translation page interleaved (Phase 3b)

Phase 3a implements faithful mode only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _read_stdin_bytes() -> bytes:
    return sys.stdin.buffer.read()


def _json_load(stdin_str: str) -> Any:
    return json.loads(stdin_str)


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


def render_faithful(
    pdf_bytes: bytes,
    pages: list[dict[str, Any]],
    translations: dict[str, str],
    font_scale: float = 0.9,
    min_font_scale: float = 0.85,
) -> bytes:
    """Overlay translations onto the original PDF, preserving page count and layout.

    Args:
        pdf_bytes: Original PDF file bytes.
        pages: List of page IR data, each containing blocks with sourceBBox and id.
        translations: Map of block id → translated text.
        font_scale: Initial scale factor for translated text size relative to source.
        min_font_scale: Minimum allowed font scale before clipping.

    Returns:
        Rendered PDF bytes.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise RuntimeError(
            "PyMuPDF (fitz) is required for PDF rendering. "
            "Install it with: pip install pymupdf"
        )

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    font_path = _find_cjk_font()

    for page_data in pages:
        page_number = page_data["pageNumber"]
        if page_number < 1 or page_number > len(doc):
            continue

        page = doc[page_number - 1]

        for block in page_data.get("blocks", []):
            block_id = block.get("id", "")
            translated = translations.get(block_id)
            if not translated:
                continue

            bbox = block.get("sourceBBox", {})
            x = bbox.get("x", 0)
            y = bbox.get("y", 0)
            w = bbox.get("width", 0)
            h = bbox.get("height", 0)

            if w <= 0 or h <= 0:
                continue

            rect = fitz.Rect(x, y, x + w, y + h)

            # Redact original text
            page.add_redact_annot(rect, fill=(1, 1, 1))
            page.apply_redactions()

            # Calculate font size
            source_style = block.get("sourceStyle", {})
            source_font_size = source_style.get("fontSize", 10)
            target_font_size = source_font_size * font_scale
            target_font_size = max(target_font_size, source_font_size * min_font_scale)

            # Insert translated text
            text_rect = fitz.Rect(x, y, x + w, y + h)
            try:
                if font_path:
                    page.insert_textbox(
                        text_rect,
                        translated,
                        fontfile=font_path,
                        fontsize=target_font_size,
                        align=fitz.TEXT_ALIGN_LEFT,
                        color=(0, 0, 0),
                    )
                else:
                    page.insert_textbox(
                        text_rect,
                        translated,
                        fontsize=target_font_size,
                        fontname="china-s",
                        align=fitz.TEXT_ALIGN_LEFT,
                        color=(0, 0, 0),
                    )
            except Exception:
                # Fallback: try without fontfile
                page.insert_textbox(
                    text_rect,
                    translated,
                    fontsize=target_font_size,
                    align=fitz.TEXT_ALIGN_LEFT,
                    color=(0, 0, 0),
                )

    output = doc.tobytes()
    doc.close()
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LingoPane PDF renderer")
    parser.add_argument(
        "--mode",
        choices=["faithful", "adaptive", "bilingual"],
        default="faithful",
        help="Render mode",
    )
    parser.add_argument(
        "--pages-json",
        type=str,
        required=True,
        help="JSON string of page IR data (pages array)",
    )
    parser.add_argument(
        "--translations-json",
        type=str,
        required=True,
        help='JSON string of translations map {"blockId": "translated text", ...}',
    )
    parser.add_argument(
        "--font-scale",
        type=float,
        default=0.9,
        help="Font scale factor for translated text (default: 0.9)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output file path (default: stdout)",
    )
    args = parser.parse_args(argv)

    if args.mode != "faithful":
        print(
            f"Render mode '{args.mode}' is not yet implemented. Only 'faithful' is available.",
            file=sys.stderr,
        )
        return 1

    try:
        pdf_bytes = _read_stdin_bytes()
        pages = json.loads(args.pages_json)
        translations = json.loads(args.translations_json)

        rendered = render_faithful(
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
