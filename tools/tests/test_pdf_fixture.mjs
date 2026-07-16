import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const fixture = new URL("./fixtures/docling-two-column-table.pdf", import.meta.url);
const standardFontDataUrl = `${fileURLToPath(new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url))}/`;

test("layout fixture covers columns, spanning content, tables, captions, and outline coordinates", async () => {
  const task = getDocument({ data: new Uint8Array(fs.readFileSync(fixture)), standardFontDataUrl });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 2);

    const pageOne = await document.getPage(1);
    const firstItems = (await pageOne.getTextContent()).items.filter((item) => "str" in item);
    const introduction = firstItems.find((item) => item.str === "1. Introduction");
    const results = firstItems.find((item) => item.str === "3. Results");
    assert.ok(introduction && results);
    assert.ok(introduction.transform[4] < pageOne.view[2] / 2);
    assert.ok(results.transform[4] > pageOne.view[2] / 2);
    assert.ok(firstItems.some((item) => item.str.startsWith("Table 1.")));

    const pageTwo = await document.getPage(2);
    const secondItems = (await pageTwo.getTextContent()).items.filter((item) => "str" in item);
    assert.ok(secondItems.some((item) => item.str === "2.1 Architecture Across Both Columns"));
    assert.ok(secondItems.some((item) => item.str.startsWith("Figure 1.")));
    assert.ok(secondItems.some((item) => item.str === "2.2 Contributions"));

    const outline = await document.getOutline();
    assert.deepEqual(outline?.map((item) => item.title), ["1 Introduction", "2 Method"]);
    assert.deepEqual(outline?.[1].items.map((item) => item.title), ["2.1 Architecture", "2.2 Contributions"]);
    const destination = outline?.[1].items[1].dest;
    assert.ok(Array.isArray(destination));
    assert.equal(destination[1].name, "XYZ");
    assert.equal(await document.getPageIndex(destination[0]), 1);
    assert.equal(destination[3], 354);
  } finally {
    await task.destroy();
  }
});
