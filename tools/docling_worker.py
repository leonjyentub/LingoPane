#!/usr/bin/env python3
"""Small, versioned bridge between LingoPane and Docling.

The worker intentionally keeps Docling imports inside the runtime functions so
`--probe` and the contract tests can report a missing optional dependency
without preventing the rest of LingoPane from starting.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable


WORKER_VERSION = "4"
SCHEMA_VERSION = 1


def _json_dump(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _docling_version() -> str:
    return importlib.metadata.version("docling")


def probe() -> dict[str, Any]:
    try:
        version = _docling_version()
        from docling.document_converter import DocumentConverter  # noqa: F401

        return {
            "available": True,
            "workerVersion": WORKER_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "doclingVersion": version,
            "pythonVersion": sys.version.split()[0],
            "error": None,
        }
    except Exception as error:  # Import failures vary across optional runtimes.
        return {
            "available": False,
            "workerVersion": WORKER_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "doclingVersion": None,
            "pythonVersion": sys.version.split()[0],
            "error": f"{type(error).__name__}: {error}",
        }


def normalized_label(value: Any) -> str:
    label = str(value or "text").strip().lower().replace("-", "_").replace(" ", "_")
    if "." in label:
        label = label.rsplit(".", 1)[-1]
    return label


def item_kind(label: str) -> str:
    if label in {"title", "section_header", "heading"}:
        return "heading"
    if label in {"caption", "footnote"}:
        return "caption"
    if label == "table":
        return "table"
    if label == "formula":
        return "formula"
    if label in {
        "page_header",
        "page_footer",
        "picture",
        "document_index",
        "checkbox_selected",
        "checkbox_unselected",
        "form",
        "key_value_region",
    }:
        return "artifact"
    return "text"


def is_translatable(label: str, text: str) -> bool:
    if not text.strip():
        return False
    return label not in {
        "formula",
        "page_header",
        "page_footer",
        "picture",
        "checkbox_selected",
        "checkbox_unselected",
    }


def estimate_font_size(text: str, bbox: dict[str, float], kind: str) -> float:
    """Estimate overlay text size without exposing Docling internals in the contract."""
    width = max(1.0, bbox["right"] - bbox["left"])
    height = max(1.0, bbox["bottom"] - bbox["top"])
    if kind == "heading":
        return max(8.0, min(18.0, height * 1.05))

    explicit_lines = max(1, len(text.splitlines()))
    wrapped_lines = max(1, math.ceil(len(" ".join(text.split())) * 4.5 / width))
    line_count = max(explicit_lines, wrapped_lines)
    return max(7.0, min(14.0, height * 0.8 / line_count))


def normalize_bbox(bbox: Any, page_height: float) -> dict[str, float] | None:
    try:
        left = float(bbox.l)
        right = float(bbox.r)
        top = float(bbox.t)
        bottom = float(bbox.b)
    except (AttributeError, TypeError, ValueError):
        return None

    origin = str(getattr(bbox, "coord_origin", "TOPLEFT")).upper()
    if origin.endswith("BOTTOMLEFT"):
        top, bottom = page_height - top, page_height - bottom

    normalized_top = min(top, bottom)
    normalized_bottom = max(top, bottom)
    normalized_left = min(left, right)
    normalized_right = max(left, right)
    return {
        "left": normalized_left,
        "top": normalized_top,
        "right": normalized_right,
        "bottom": normalized_bottom,
    }


def _page_size(document: Any, page_number: int) -> tuple[float, float]:
    pages = getattr(document, "pages", {})
    page = pages.get(page_number) if hasattr(pages, "get") else None
    size = getattr(page, "size", None)
    return float(getattr(size, "width", 0) or 0), float(getattr(size, "height", 0) or 0)


def _item_text(item: Any, document: Any, label: str) -> str:
    text = str(getattr(item, "text", "") or "").strip()
    if text or label != "table":
        return text
    exporter = getattr(item, "export_to_markdown", None)
    if callable(exporter):
        try:
            return str(exporter(doc=document) or "").strip()
        except Exception:
            return ""
    return ""


def _iterate_items(document: Any) -> Iterable[tuple[Any, int]]:
    iterator = getattr(document, "iterate_items", None)
    if not callable(iterator):
        return []
    return iterator()


def _grid_boundaries(
    cells: list[dict[str, Any]],
    count: int,
    outer_start: float,
    outer_end: float,
    axis: str,
) -> list[float]:
    boundaries = [outer_start]
    start_key = "columnStart" if axis == "x" else "rowStart"
    end_key = "columnEnd" if axis == "x" else "rowEnd"
    low_key = "left" if axis == "x" else "top"
    high_key = "right" if axis == "x" else "bottom"
    for boundary_index in range(1, count):
        before = [
            cell["contentBbox"][high_key]
            for cell in cells
            if cell[end_key] <= boundary_index
        ]
        after = [
            cell["contentBbox"][low_key]
            for cell in cells
            if cell[start_key] >= boundary_index
        ]
        fallback = outer_start + (outer_end - outer_start) * boundary_index / count
        candidate = (max(before) + min(after)) / 2 if before and after else fallback
        remaining = count - boundary_index
        maximum = outer_end - remaining
        boundaries.append(max(boundaries[-1] + 1.0, min(maximum, candidate)))
    boundaries.append(outer_end)
    return boundaries


def table_cell_items(item: Any, page_height: float, table_bbox: dict[str, float]) -> list[dict[str, Any]]:
    data = getattr(item, "data", None)
    source_cells = list(getattr(data, "table_cells", []) or [])
    if not source_cells:
        return []

    cells: list[dict[str, Any]] = []
    for cell in source_cells:
        content_bbox = normalize_bbox(getattr(cell, "bbox", None), page_height)
        text = str(getattr(cell, "text", "") or "").strip()
        if content_bbox is None or not text:
            continue
        cells.append(
            {
                "text": text,
                "contentBbox": content_bbox,
                "fontSize": max(
                    7.0,
                    min(12.0, (content_bbox["bottom"] - content_bbox["top"]) * 0.9),
                ),
                "rowStart": int(getattr(cell, "start_row_offset_idx", 0) or 0),
                "rowEnd": int(getattr(cell, "end_row_offset_idx", 1) or 1),
                "columnStart": int(getattr(cell, "start_col_offset_idx", 0) or 0),
                "columnEnd": int(getattr(cell, "end_col_offset_idx", 1) or 1),
                "isHeader": bool(
                    getattr(cell, "column_header", False)
                    or getattr(cell, "row_header", False)
                    or getattr(cell, "row_section", False)
                ),
            }
        )
    if not cells:
        return []

    row_count = max(int(getattr(data, "num_rows", 0) or 0), max(cell["rowEnd"] for cell in cells))
    column_count = max(
        int(getattr(data, "num_cols", 0) or 0),
        max(cell["columnEnd"] for cell in cells),
    )
    rows = _grid_boundaries(cells, row_count, table_bbox["top"], table_bbox["bottom"], "y")
    columns = _grid_boundaries(cells, column_count, table_bbox["left"], table_bbox["right"], "x")

    for cell in cells:
        left = columns[cell["columnStart"]]
        right = columns[cell["columnEnd"]]
        top = rows[cell["rowStart"]]
        bottom = rows[cell["rowEnd"]]
        padding_x = min(6.0, max(1.5, (right - left) * 0.035))
        padding_y = min(3.0, max(0.75, (bottom - top) * 0.06))
        cell_bbox = {
            "left": left + padding_x,
            "top": top + padding_y,
            "right": right - padding_x,
            "bottom": bottom - padding_y,
        }
        content = cell["contentBbox"]
        left_gap = max(0.0, content["left"] - left)
        right_gap = max(0.0, right - content["right"])
        centered_threshold = max(5.0, (right - left) * 0.08)
        if abs(left_gap - right_gap) <= centered_threshold:
            text_align = "center"
        elif right_gap < left_gap * 0.45:
            text_align = "right"
        else:
            text_align = "left"
        cell["bbox"] = cell_bbox
        cell["textAlign"] = text_align
        del cell["contentBbox"]
    return cells


def document_to_contract(document: Any, input_path: Path, docling_version: str) -> dict[str, Any]:
    document_hash = hashlib.sha256(input_path.read_bytes()).hexdigest()
    pages: dict[int, dict[str, Any]] = {}
    page_reading_orders: dict[int, int] = {}
    skipped_without_provenance = 0

    for entry in _iterate_items(document):
        item, level = entry if isinstance(entry, tuple) else (entry, 0)
        label = normalized_label(getattr(item, "label", item.__class__.__name__))
        text = _item_text(item, document, label)
        provenance = list(getattr(item, "prov", []) or [])
        if not provenance:
            skipped_without_provenance += 1
            continue

        for provenance_index, prov in enumerate(provenance):
            page_number = int(getattr(prov, "page_no", 0) or 0)
            if page_number <= 0:
                skipped_without_provenance += 1
                continue
            page_width, page_height = _page_size(document, page_number)
            bbox = normalize_bbox(getattr(prov, "bbox", None), page_height)
            if bbox is None:
                skipped_without_provenance += 1
                continue
            page_reading_order = page_reading_orders.get(page_number, 0)
            page_reading_orders[page_number] = page_reading_order + 1

            page = pages.setdefault(
                page_number,
                {
                    "pageNumber": page_number,
                    "width": page_width,
                    "height": page_height,
                    "items": [],
                },
            )
            if label == "table":
                cells = table_cell_items(item, page_height, bbox)
                if cells:
                    for cell_index, cell in enumerate(cells):
                        cell_text = cell["text"]
                        stable_source = (
                            f"{document_hash}:{page_number}:{page_reading_order}:{provenance_index}:"
                            f"table-cell:{cell['rowStart']}:{cell['columnStart']}:{cell_index}:"
                            f"{' '.join(cell_text.split())}"
                        )
                        item_id = "d-" + hashlib.sha256(stable_source.encode("utf-8")).hexdigest()[:20]
                        page["items"].append(
                            {
                                "id": item_id,
                                "pageNumber": page_number,
                                "kind": "table",
                                "sourceLabel": "table_cell_header" if cell["isHeader"] else "table_cell",
                                "text": cell_text,
                                "bbox": cell["bbox"],
                                "readingOrder": page_reading_order,
                                "level": int(level or 0) + 1,
                                "confidence": None,
                                "fontSize": cell["fontSize"],
                                "translatable": is_translatable("table_cell", cell_text),
                                "textAlign": cell["textAlign"],
                                "emphasis": "bold" if cell["isHeader"] else None,
                                "tableCell": {
                                    "rowStart": cell["rowStart"],
                                    "rowEnd": cell["rowEnd"],
                                    "columnStart": cell["columnStart"],
                                    "columnEnd": cell["columnEnd"],
                                },
                            }
                        )
                    continue
            stable_source = (
                f"{document_hash}:{page_number}:{page_reading_order}:{provenance_index}:"
                f"{label}:{' '.join(text.split())}"
            )
            item_id = "d-" + hashlib.sha256(stable_source.encode("utf-8")).hexdigest()[:20]
            kind = item_kind(label)
            page["items"].append(
                {
                    "id": item_id,
                    "pageNumber": page_number,
                    "kind": kind,
                    "sourceLabel": label,
                    "text": text,
                    "bbox": bbox,
                    "readingOrder": page_reading_order,
                    "level": int(level or 0),
                    "confidence": None,
                    "fontSize": estimate_font_size(text, bbox, kind),
                    "translatable": is_translatable(label, text),
                }
            )

    ordered_pages = [pages[key] for key in sorted(pages)]
    warnings = []
    if skipped_without_provenance:
        warnings.append(f"Skipped {skipped_without_provenance} items without usable provenance")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "documentHash": document_hash,
        "analyzer": {
            "name": "docling-standard",
            "version": docling_version,
            "workerVersion": WORKER_VERSION,
            "modelVersions": {
                "layout": "docling-default",
                "tableStructure": "docling-default",
            },
        },
        "pages": ordered_pages,
        "warnings": warnings,
    }


def create_converter(do_ocr: bool, layout_model: str = "heron") -> Any:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = do_ocr
    options.do_table_structure = True

    try:
        from docling.datamodel.pipeline_options import LayoutOptions
        from docling.datamodel.layout_model_specs import (  # type: ignore[import-untyped]
            DOCLING_LAYOUT_HERON,
            DOCLING_LAYOUT_EGRET_LARGE,
            DOCLING_LAYOUT_EGRET_XLARGE,
        )

        model_specs = {
            "heron": DOCLING_LAYOUT_HERON,
            "egret-large": DOCLING_LAYOUT_EGRET_LARGE,
            "egret-xlarge": DOCLING_LAYOUT_EGRET_XLARGE,
        }
        spec = model_specs.get(layout_model, DOCLING_LAYOUT_HERON)
        options.layout_options = LayoutOptions(model_spec=spec)
    except ImportError:
        pass

    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )


def analyze(
    input_path: Path,
    do_ocr: bool,
    page_range: tuple[int, int] | None = None,
    converter: Any | None = None,
    layout_model: str = "heron",
) -> dict[str, Any]:
    if not input_path.is_file():
        raise FileNotFoundError(f"PDF does not exist: {input_path}")

    active_converter = converter or create_converter(do_ocr, layout_model)
    arguments = {"page_range": page_range} if page_range else {}
    result = active_converter.convert(input_path, **arguments)
    return document_to_contract(result.document, input_path, _docling_version())


def prioritized_page_ranges(page_count: int, batch_size: int, priority_page: int) -> list[tuple[int, int]]:
    if page_count <= 0:
        raise ValueError("page_count must be greater than zero")
    if batch_size <= 0:
        raise ValueError("batch_size must be greater than zero")
    safe_priority = max(1, min(page_count, priority_page))
    ranges = [
        (start, min(page_count, start + batch_size - 1))
        for start in range(1, page_count + 1, batch_size)
    ]
    priority_index = (safe_priority - 1) // batch_size
    ordered = [ranges[priority_index]]
    for distance in range(1, len(ranges)):
        next_index = priority_index + distance
        previous_index = priority_index - distance
        if next_index < len(ranges):
            ordered.append(ranges[next_index])
        if previous_index >= 0:
            ordered.append(ranges[previous_index])
    return ordered


def analyze_in_batches(
    input_path: Path,
    do_ocr: bool,
    page_count: int,
    batch_size: int,
    priority_page: int,
    layout_model: str = "heron",
) -> None:
    converter = create_converter(do_ocr, layout_model)
    completed_pages = 0
    for batch_start, batch_end in prioritized_page_ranges(page_count, batch_size, priority_page):
        analysis = analyze(input_path, do_ocr, (batch_start, batch_end), converter)
        completed_pages += batch_end - batch_start + 1
        _json_dump(
            {
                "type": "batch",
                "batchStart": batch_start,
                "batchEnd": batch_end,
                "completedPages": completed_pages,
                "totalPages": page_count,
                "analysis": analysis,
            }
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LingoPane Docling bridge")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--page-count", type=int)
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--priority-page", type=int, default=1)
    parser.add_argument(
        "--layout-model",
        choices=["heron", "egret-large", "egret-xlarge"],
        default="heron",
    )
    args = parser.parse_args(argv)

    if args.probe:
        _json_dump(probe())
        return 0
    if args.input is None:
        parser.error("--input is required unless --probe is used")

    try:
        if args.page_count is not None:
            analyze_in_batches(
                args.input,
                args.ocr,
                args.page_count,
                args.batch_size,
                args.priority_page,
                args.layout_model,
            )
        else:
            _json_dump(analyze(args.input, args.ocr, layout_model=args.layout_model))
        return 0
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
