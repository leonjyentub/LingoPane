#!/usr/bin/env python3
"""Generate the deterministic PDF used by the Docling integration smoke test."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


OUTPUT = Path(__file__).parent / "fixtures" / "docling-two-column-table.pdf"


def draw_wrapped_text(pdf: canvas.Canvas, text: str, x: float, y: float, width: float) -> float:
    words = text.split()
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if pdf.stringWidth(candidate, "Helvetica", 9) <= width:
            line = candidate
            continue
        pdf.drawString(x, y, line)
        y -= 12
        line = word
    if line:
        pdf.drawString(x, y, line)
        y -= 12
    return y


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(OUTPUT), pagesize=letter)
    width, height = letter
    pdf.setTitle("LingoPane Docling Layout Fixture")

    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawCentredString(width / 2, height - 48, "Layout-Aware Translation Benchmark")
    pdf.setFont("Helvetica", 9)
    pdf.drawCentredString(width / 2, height - 65, "A deterministic two-column document with a structured table")

    margin = 48
    gutter = 24
    column_width = (width - margin * 2 - gutter) / 2
    left_x = margin
    right_x = margin + column_width + gutter

    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(left_x, height - 96, "1. Introduction")
    pdf.setFont("Helvetica", 9)
    left_y = draw_wrapped_text(
        pdf,
        "Document translation quality depends on reliable reading order. "
        "The left column must remain separate from the right column, while headings "
        "and captions should provide context to the translation model.",
        left_x,
        height - 114,
        column_width,
    )
    left_y -= 8
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(left_x, left_y, "2. Method")
    pdf.setFont("Helvetica", 9)
    draw_wrapped_text(
        pdf,
        "The standard pipeline parses native PDF text, detects semantic layout regions, "
        "recognizes table structure, and applies OCR only when required.",
        left_x,
        left_y - 18,
        column_width,
    )

    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(right_x, height - 96, "3. Results")
    pdf.setFont("Helvetica", 9)
    right_y = draw_wrapped_text(
        pdf,
        "Stable bounding boxes let LingoPane place translated text over the original page. "
        "A versioned document contract keeps the React interface independent from Docling internals.",
        right_x,
        height - 114,
        column_width,
    )

    right_y -= 12
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(right_x, right_y, "Table 1. Expected pipeline responsibilities")
    table_top = right_y - 10
    row_height = 24
    columns = [right_x, right_x + 76, right_x + column_width]
    rows = [table_top - row_height * index for index in range(6)]
    pdf.setStrokeColor(colors.HexColor("#666666"))
    for x in columns:
        pdf.line(x, rows[-1], x, rows[0])
    for y in rows:
        pdf.line(columns[0], y, columns[-1], y)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(columns[0] + 5, rows[0] - 16, "Stage")
    pdf.drawString(columns[1] + 5, rows[0] - 16, "Responsibility")
    pdf.setFont("Helvetica", 8)
    values = [
        ("PDF parser", "Native text and coordinates"),
        ("Layout", "Semantic regions and order"),
        ("Table", "Rows, columns, and cells"),
        ("oMLX", "Local text translation"),
    ]
    for index, (stage, responsibility) in enumerate(values, start=1):
        baseline = rows[index] - 16
        pdf.drawString(columns[0] + 5, baseline, stage)
        pdf.drawString(columns[1] + 5, baseline, responsibility)

    pdf.setFont("Helvetica-Oblique", 8)
    pdf.drawCentredString(width / 2, 28, "LingoPane Docling integration fixture - page 1")
    pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    main()
