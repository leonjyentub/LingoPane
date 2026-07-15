from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


MODULE_PATH = Path(__file__).parents[1] / "docling_worker.py"
SPEC = importlib.util.spec_from_file_location("docling_worker", MODULE_PATH)
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class DoclingWorkerTests(unittest.TestCase):
    def test_prioritizes_current_batch_then_adjacent_batches(self) -> None:
        self.assertEqual(
            worker.prioritized_page_ranges(page_count=12, batch_size=5, priority_page=7),
            [(6, 10), (11, 12), (1, 5)],
        )

    def test_normalizes_bottom_left_coordinates(self) -> None:
        bbox = SimpleNamespace(l=10, t=90, r=60, b=70, coord_origin="BOTTOMLEFT")
        self.assertEqual(
            worker.normalize_bbox(bbox, 100),
            {"left": 10.0, "top": 10.0, "right": 60.0, "bottom": 30.0},
        )

    def test_maps_docling_labels_to_lingopane_kinds(self) -> None:
        self.assertEqual(worker.item_kind("section_header"), "heading")
        self.assertEqual(worker.item_kind("table"), "table")
        self.assertEqual(worker.item_kind("page_footer"), "artifact")
        self.assertFalse(worker.is_translatable("formula", "x = y"))

    def test_estimates_multiline_body_text_without_using_block_height_as_font_size(self) -> None:
        bbox = {"left": 0.0, "top": 0.0, "right": 240.0, "bottom": 48.0}
        text = "A paragraph with enough words to occupy several ordinary PDF text lines. " * 3
        self.assertLessEqual(worker.estimate_font_size(text, bbox, "text"), 10.0)
        self.assertGreater(worker.estimate_font_size("Short heading", bbox, "heading"), 14.0)

    def test_expands_table_into_positioned_cells_instead_of_markdown(self) -> None:
        def cell(row: int, column: int, text: str, left: float, top: float, header: bool = False):
            return SimpleNamespace(
                text=text,
                bbox=SimpleNamespace(l=left, t=top, r=left + 20, b=top + 10, coord_origin="TOPLEFT"),
                start_row_offset_idx=row,
                end_row_offset_idx=row + 1,
                start_col_offset_idx=column,
                end_col_offset_idx=column + 1,
                column_header=header,
                row_header=False,
                row_section=False,
            )

        item = SimpleNamespace(data=SimpleNamespace(
            num_rows=2,
            num_cols=2,
            table_cells=[
                cell(0, 0, "Header A", 15, 10, True),
                cell(0, 1, "Header B", 65, 10, True),
                cell(1, 0, "Value A", 15, 60),
                cell(1, 1, "Value B", 65, 60),
            ],
        ))
        cells = worker.table_cell_items(
            item,
            100,
            {"left": 0.0, "top": 0.0, "right": 100.0, "bottom": 100.0},
        )

        self.assertEqual([entry["text"] for entry in cells], ["Header A", "Header B", "Value A", "Value B"])
        self.assertTrue(cells[0]["isHeader"])
        self.assertLess(cells[0]["bbox"]["right"], cells[1]["bbox"]["left"])
        self.assertLess(cells[0]["bbox"]["bottom"], cells[2]["bbox"]["top"])

    def test_builds_versioned_contract_with_stable_ids(self) -> None:
        bbox = SimpleNamespace(l=20, t=30, r=180, b=54, coord_origin="TOPLEFT")
        item = SimpleNamespace(
            label="DocItemLabel.TEXT",
            text="A stable paragraph",
            prov=[SimpleNamespace(page_no=1, bbox=bbox)],
        )
        page = SimpleNamespace(size=SimpleNamespace(width=200, height=300))
        document = SimpleNamespace(
            pages={1: page},
            iterate_items=lambda: iter([(item, 0)]),
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pdf"
            path.write_bytes(b"fake-pdf")
            first = worker.document_to_contract(document, path, "test")
            second = worker.document_to_contract(document, path, "test")

        self.assertEqual(first["schemaVersion"], 1)
        self.assertEqual(first["pages"][0]["items"][0]["id"], second["pages"][0]["items"][0]["id"])
        self.assertEqual(first["pages"][0]["items"][0]["bbox"]["top"], 30.0)

    def test_page_ids_do_not_change_when_analyzed_in_a_different_batch(self) -> None:
        def item(page_number: int, text: str):
            return SimpleNamespace(
                label="DocItemLabel.TEXT",
                text=text,
                prov=[SimpleNamespace(
                    page_no=page_number,
                    bbox=SimpleNamespace(l=20, t=30, r=180, b=54, coord_origin="TOPLEFT"),
                )],
            )

        page = SimpleNamespace(size=SimpleNamespace(width=200, height=300))
        page_one = item(1, "First page")
        page_two = item(2, "Second page")
        full = SimpleNamespace(pages={1: page, 2: page}, iterate_items=lambda: iter([(page_one, 0), (page_two, 0)]))
        partial = SimpleNamespace(pages={2: page}, iterate_items=lambda: iter([(page_two, 0)]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pdf"
            path.write_bytes(b"fake-pdf")
            full_contract = worker.document_to_contract(full, path, "test")
            partial_contract = worker.document_to_contract(partial, path, "test")

        full_page_two_id = full_contract["pages"][1]["items"][0]["id"]
        partial_page_two_id = partial_contract["pages"][0]["items"][0]["id"]
        self.assertEqual(full_page_two_id, partial_page_two_id)


if __name__ == "__main__":
    unittest.main()
