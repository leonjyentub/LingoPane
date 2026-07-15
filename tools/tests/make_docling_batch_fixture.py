#!/usr/bin/env python3
"""Generate a deterministic multi-page PDF for Docling page-range smoke tests."""

from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


OUTPUT = Path(__file__).parent / "fixtures" / "docling-seven-pages.pdf"


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(OUTPUT), pagesize=letter, invariant=1)
    width, height = letter
    for page_number in range(1, 8):
        pdf.setFont("Helvetica-Bold", 18)
        pdf.drawString(54, height - 72, f"Docling Batch Page {page_number}")
        pdf.setFont("Helvetica", 11)
        pdf.drawString(54, height - 104, f"Stable page marker: LINGOPANE-BATCH-{page_number}")
        pdf.drawString(54, height - 126, "This page verifies page-range ordering and original page numbers.")
        pdf.setFont("Helvetica", 9)
        pdf.drawCentredString(width / 2, 30, f"Page {page_number} of 7")
        pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    main()
