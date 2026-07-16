import type { PDFDocumentProxy } from "pdfjs-dist";
import { getPageLayout, type PdfPageLayout, type PdfTextBlock } from "./pdfLayout";

export type AnalysisMode = "fast" | "docling";

export type DoclingStatus = {
  available: boolean;
  workerVersion: string;
  schemaVersion: number;
  doclingVersion?: string;
  pythonVersion: string;
  pythonExecutable?: string;
  error?: string;
};

export type DocumentAnalysis = {
  schemaVersion: number;
  documentHash: string;
  analyzer: {
    name: string;
    version: string;
    workerVersion: string;
    modelVersions: Record<string, string>;
  };
  pages: AnalyzedPage[];
  warnings: string[];
};

export type AnalyzedPage = {
  pageNumber: number;
  width: number;
  height: number;
  items: AnalyzedItem[];
};

type AnalyzedItem = {
  id: string;
  pageNumber: number;
  kind: string;
  sourceLabel: string;
  text: string;
  bbox: { left: number; top: number; right: number; bottom: number };
  readingOrder: number;
  level: number;
  confidence?: number;
  fontSize: number;
  translatable: boolean;
  textAlign?: "left" | "center" | "right";
  emphasis?: "bold";
  tableCell?: {
    rowStart: number;
    rowEnd: number;
    columnStart: number;
    columnEnd: number;
  };
};

const supportedKinds = new Set<PdfTextBlock["kind"]>([
  "text",
  "heading",
  "caption",
  "table",
  "formula",
  "artifact",
]);

function blockKind(kind: string): PdfTextBlock["kind"] {
  return supportedKinds.has(kind as PdfTextBlock["kind"])
    ? kind as PdfTextBlock["kind"]
    : "text";
}

function comparableText(text: string) {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function pdfFragmentsForTableCell(
  pdfLayout: PdfPageLayout,
  item: AnalyzedItem,
  cellBlock: PdfTextBlock,
): PdfTextBlock[] {
  if (!item.tableCell) return [];
  const cellRight = cellBlock.left + cellBlock.width;
  const cellBottom = cellBlock.top + cellBlock.height;
  const cellText = comparableText(item.text);
  if (!cellText) return [];

  return pdfLayout.blocks
    .filter((block) => {
      if (!block.text.trim() || block.kind === "artifact") return false;
      const right = block.left + block.width;
      const bottom = block.top + block.height;
      const intersectionWidth = Math.max(0, Math.min(right, cellRight) - Math.max(block.left, cellBlock.left));
      const intersectionHeight = Math.max(0, Math.min(bottom, cellBottom) - Math.max(block.top, cellBlock.top));
      const overlap = intersectionWidth * intersectionHeight / Math.max(1, block.width * block.height);
      if (overlap < 0.55) return false;
      const fragmentText = comparableText(block.text);
      return fragmentText.length > 0
        && (cellText.includes(fragmentText) || fragmentText.includes(cellText));
    })
    .sort((left, right) => left.top - right.top || left.left - right.left)
    .map((block, _index, matches) => ({
      ...block,
      id: `${item.id}:pdf:${block.id}`,
      kind: "table",
      translatable: item.translatable && block.translatable,
      textAlign: matches.length === 1 ? item.textAlign : block.textAlign,
      emphasis: item.emphasis,
    }));
}

function alignBlockToPdfText(pdfLayout: PdfPageLayout, item: AnalyzedItem, block: PdfTextBlock): PdfTextBlock {
  const itemText = comparableText(item.text);
  if (!itemText || block.kind === "formula") return block;
  const blockRight = block.left + block.width;
  const blockBottom = block.top + block.height;
  const nearbyMatches = pdfLayout.blocks.filter((candidate) => {
    if (!candidate.text.trim() || candidate.kind === "artifact") return false;
    const candidateText = comparableText(candidate.text);
    if (!candidateText || !(itemText.includes(candidateText) || candidateText.includes(itemText))) return false;
    const right = candidate.left + candidate.width;
    const bottom = candidate.top + candidate.height;
    const intersectionWidth = Math.max(0, Math.min(right, blockRight) - Math.max(candidate.left, block.left));
    const intersectionHeight = Math.max(0, Math.min(bottom, blockBottom) - Math.max(candidate.top, block.top));
    const overlaps = intersectionWidth > 0 && intersectionHeight > 0;
    const centerDistance = Math.hypot(
      candidate.left + candidate.width / 2 - (block.left + block.width / 2),
      candidate.top + candidate.height / 2 - (block.top + block.height / 2),
    );
    return overlaps || centerDistance < Math.max(18, Math.min(pdfLayout.width, pdfLayout.height) * 0.045);
  });
  if (!nearbyMatches.length) return block;

  const left = Math.min(...nearbyMatches.map((candidate) => candidate.left));
  const top = Math.min(...nearbyMatches.map((candidate) => candidate.top));
  const right = Math.max(...nearbyMatches.map((candidate) => candidate.left + candidate.width));
  const bottom = Math.max(...nearbyMatches.map((candidate) => candidate.top + candidate.height));
  const medianFontSize = nearbyMatches
    .map((candidate) => candidate.fontSize)
    .sort((a, b) => a - b)[Math.floor(nearbyMatches.length / 2)];
  return {
    ...block,
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    fontSize: Math.max(6, medianFontSize),
  };
}

function hasReliableDoclingGeometry(blocks: PdfTextBlock[]): boolean {
  const longTextLocations = new Map<string, PdfTextBlock>();
  for (const block of blocks) {
    if (!block.translatable) continue;
    const normalized = comparableText(block.text);
    if (!normalized) continue;

    // Docling can represent a paragraph that continues from the bottom of the
    // left column to the top of the right column as two regions containing the
    // complete paragraph text. Rendering both regions duplicates the entire
    // translation and makes either box overflow, so use PDF.js for that page.
    if (normalized.length >= 160) {
      const duplicate = longTextLocations.get(normalized);
      if (duplicate) return false;
      longTextLocations.set(normalized, block);
    }

    // A generous character-capacity estimate catches compound Docling regions
    // whose text covers several disconnected columns while the bbox covers
    // only a line or two. The generous glyph width avoids rejecting ordinary
    // dense paragraphs, captions, or narrow table cells.
    const glyphWidth = Math.max(2.5, block.fontSize * 0.42);
    const lineHeight = Math.max(6, block.fontSize * 1.08);
    const capacity = Math.max(1, block.width / glyphWidth) * Math.max(1, block.height / lineHeight);
    if (normalized.length >= 120 && normalized.length > capacity * 3.2) return false;
  }
  return true;
}

export function mergeDoclingPage(pdfLayout: PdfPageLayout, page: AnalyzedPage): PdfPageLayout {
  if (!page.items.length) return pdfLayout;
  const scaleX = page.width > 0 ? pdfLayout.width / page.width : 1;
  const scaleY = page.height > 0 ? pdfLayout.height / page.height : 1;
  const blocks = page.items
    .slice()
    .sort((left, right) => left.readingOrder - right.readingOrder)
    .flatMap<PdfTextBlock>((item) => {
      const block: PdfTextBlock = {
        id: item.id,
        text: item.text,
        left: item.bbox.left * scaleX,
        top: item.bbox.top * scaleY,
        width: Math.max(1, (item.bbox.right - item.bbox.left) * scaleX),
        height: Math.max(1, (item.bbox.bottom - item.bbox.top) * scaleY),
        fontSize: Math.max(6, item.fontSize * Math.min(scaleX, scaleY)),
        kind: blockKind(item.kind),
        translatable: item.translatable,
        textAlign: item.textAlign,
        emphasis: item.emphasis,
      };
      const fragments = pdfFragmentsForTableCell(pdfLayout, item, block);
      return fragments.length ? fragments : [alignBlockToPdfText(pdfLayout, item, block)];
    });

  return hasReliableDoclingGeometry(blocks) ? { ...pdfLayout, blocks } : pdfLayout;
}

export async function buildDoclingLayouts(
  document: PDFDocumentProxy,
  analysis: DocumentAnalysis,
): Promise<Record<number, PdfPageLayout>> {
  const layouts: Record<number, PdfPageLayout> = {};
  await Promise.all(analysis.pages.map(async (page) => {
    if (page.pageNumber < 1 || page.pageNumber > document.numPages) return;
    const pdfLayout = await getPageLayout(document, page.pageNumber);
    layouts[page.pageNumber] = mergeDoclingPage(pdfLayout, page);
  }));
  return layouts;
}
