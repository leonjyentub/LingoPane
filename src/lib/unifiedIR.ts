import type { DocumentAnalysis, AnalyzedPage } from "./docling";
import type { PdfPageLayout, PdfTextBlock } from "./pdfLayout";

export type BlockType =
  | "title"
  | "heading"
  | "paragraph"
  | "equation"
  | "figure"
  | "table"
  | "caption"
  | "footnote"
  | "reference"
  | "artifact";

export type ColumnId = "left" | "right" | "spanning";

export type Alignment = "left" | "center" | "right" | "justify";

export interface SourceStyle {
  fontFamily?: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  alignment: Alignment;
  lineHeight: number;
}

export interface LayoutPolicy {
  allowReflow: boolean;
  allowFontShrink: boolean;
  allowPageExpansion: boolean;
  preservePosition: boolean;
}

export interface BlockAnchors {
  before?: string;
  after?: string;
  captionOf?: string;
  continuationOf?: string;
}

export interface LayoutBlock {
  id: string;
  page: number;
  type: BlockType;
  sourceBBox: { x: number; y: number; width: number; height: number };
  columnId: ColumnId;
  readingOrder: number;
  sourceText?: string;
  translatedText?: string;
  sourceStyle: SourceStyle;
  layoutPolicy: LayoutPolicy;
  anchors: BlockAnchors;
  isObstacle: boolean;
}

export interface FlowRegion {
  id: string;
  type: "header" | "left-column" | "right-column" | "full-width" | "footnote" | "footer" | "figure-exclusion";
  bbox: { x: number; y: number; width: number; height: number };
  blockIds: string[];
}

export interface PageIR {
  pageNumber: number;
  width: number;
  height: number;
  blocks: LayoutBlock[];
  flowRegions: FlowRegion[];
}

export interface DocumentIR {
  documentHash: string;
  pageCount: number;
  analyzer: {
    name: string;
    version: string;
    modelVersions: Record<string, string>;
  };
  pages: PageIR[];
}

const layoutPolicyDefaults: Record<BlockType, LayoutPolicy> = {
  title: { allowReflow: true, allowFontShrink: true, allowPageExpansion: true, preservePosition: false },
  heading: { allowReflow: true, allowFontShrink: true, allowPageExpansion: true, preservePosition: false },
  paragraph: { allowReflow: true, allowFontShrink: true, allowPageExpansion: true, preservePosition: false },
  equation: { allowReflow: false, allowFontShrink: false, allowPageExpansion: false, preservePosition: true },
  figure: { allowReflow: false, allowFontShrink: false, allowPageExpansion: false, preservePosition: true },
  table: { allowReflow: false, allowFontShrink: true, allowPageExpansion: false, preservePosition: true },
  caption: { allowReflow: true, allowFontShrink: true, allowPageExpansion: false, preservePosition: false },
  footnote: { allowReflow: true, allowFontShrink: true, allowPageExpansion: false, preservePosition: false },
  reference: { allowReflow: true, allowFontShrink: true, allowPageExpansion: false, preservePosition: false },
  artifact: { allowReflow: false, allowFontShrink: false, allowPageExpansion: false, preservePosition: true },
};

function doclingKindToBlockType(kind: string): BlockType {
  switch (kind) {
    case "heading": return "heading";
    case "caption": return "caption";
    case "table": return "table";
    case "formula": return "equation";
    case "artifact": return "artifact";
    default: return "paragraph";
  }
}

function pdfLayoutKindToBlockType(kind: PdfTextBlock["kind"]): BlockType {
  switch (kind) {
    case "heading": return "heading";
    case "caption": return "caption";
    case "table": return "table";
    case "formula": return "equation";
    case "artifact": return "artifact";
    default: return "paragraph";
  }
}

function alignmentFromTextAlign(textAlign?: "left" | "center" | "right"): Alignment {
  return textAlign ?? "left";
}

function lineHeightEstimate(fontSize: number): number {
  return fontSize * 1.4;
}

function doclingItemToLayoutBlock(item: AnalyzedPage["items"][number], pageNumber: number): LayoutBlock {
  const type = doclingKindToBlockType(item.kind);
  const bbox = item.bbox;
  const width = bbox.right - bbox.left;
  const height = bbox.bottom - bbox.top;

  const columnId: ColumnId =
    item.kind === "heading" || (width > 400 && bbox.left < 50 && bbox.right > 500)
      ? "spanning"
      : bbox.left < 300
        ? "left"
        : "right";

  return {
    id: item.id,
    page: pageNumber,
    type,
    sourceBBox: { x: bbox.left, y: bbox.top, width, height },
    columnId,
    readingOrder: item.readingOrder,
    sourceText: item.text,
    sourceStyle: {
      fontSize: item.fontSize,
      fontWeight: item.emphasis === "bold" ? 700 : 400,
      italic: false,
      alignment: alignmentFromTextAlign(item.textAlign),
      lineHeight: lineHeightEstimate(item.fontSize),
    },
    layoutPolicy: layoutPolicyDefaults[type],
    anchors: {},
    isObstacle: type === "figure" || type === "table" || type === "equation" || type === "artifact",
  };
}

function pdfLayoutBlockToLayoutBlock(block: PdfTextBlock, pageNumber: number, pageWidth: number): LayoutBlock {
  const type = pdfLayoutKindToBlockType(block.kind);
  const midpoint = pageWidth / 2;
  const gutter = Math.max(9, pageWidth * 0.018);
  const right = block.left + block.width;
  let columnId: ColumnId = "left";
  if (block.fontSize >= 16 && block.top < 220) {
    columnId = "spanning";
  } else if (block.left < midpoint - gutter && right > midpoint + gutter) {
    columnId = "spanning";
  } else if ((block.left + right) / 2 >= midpoint) {
    columnId = "right";
  }

  return {
    id: block.id,
    page: pageNumber,
    type,
    sourceBBox: { x: block.left, y: block.top, width: block.width, height: block.height },
    columnId,
    readingOrder: 0,
    sourceText: block.text,
    sourceStyle: {
      fontSize: block.fontSize,
      fontWeight: block.emphasis === "bold" ? 700 : 400,
      italic: false,
      alignment: alignmentFromTextAlign(block.textAlign),
      lineHeight: lineHeightEstimate(block.fontSize),
    },
    layoutPolicy: layoutPolicyDefaults[type],
    anchors: {},
    isObstacle: type === "figure" || type === "table" || type === "equation" || type === "artifact",
  };
}

function buildFlowRegions(blocks: LayoutBlock[], pageWidth: number, pageHeight: number): FlowRegion[] {
  const regions: FlowRegion[] = [];
  const leftBlocks = blocks.filter((b) => b.columnId === "left").map((b) => b.id);
  const rightBlocks = blocks.filter((b) => b.columnId === "right").map((b) => b.id);
  const spanningBlocks = blocks.filter((b) => b.columnId === "spanning").map((b) => b.id);
  const midpoint = pageWidth / 2;

  if (leftBlocks.length > 0) {
    regions.push({
      id: "left-column",
      type: "left-column",
      bbox: { x: 0, y: 0, width: midpoint, height: pageHeight },
      blockIds: leftBlocks,
    });
  }
  if (rightBlocks.length > 0) {
    regions.push({
      id: "right-column",
      type: "right-column",
      bbox: { x: midpoint, y: 0, width: pageWidth - midpoint, height: pageHeight },
      blockIds: rightBlocks,
    });
  }
  if (spanningBlocks.length > 0) {
    regions.push({
      id: "full-width",
      type: "full-width",
      bbox: { x: 0, y: 0, width: pageWidth, height: pageHeight },
      blockIds: spanningBlocks,
    });
  }

  return regions;
}

function assignReadingOrder(blocks: LayoutBlock[]): void {
  const sorted = blocks
    .slice()
    .sort((a, b) => {
      const columnOrder = { left: 0, spanning: 1, right: 2 };
      const colDiff = (columnOrder[a.columnId] ?? 0) - (columnOrder[b.columnId] ?? 0);
      if (colDiff !== 0) return colDiff;
      return a.sourceBBox.y - b.sourceBBox.y || a.sourceBBox.x - b.sourceBBox.x;
    });

  sorted.forEach((block, index) => {
    block.readingOrder = index;
  });
}

export function doclingToDocumentIR(analysis: DocumentAnalysis, pdfHash: string): DocumentIR {
  const pages: PageIR[] = analysis.pages.map((page: AnalyzedPage) => {
    const blocks = page.items.map((item) => doclingItemToLayoutBlock(item, page.pageNumber));
    assignReadingOrder(blocks);
    const flowRegions = buildFlowRegions(blocks, page.width, page.height);

    return {
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      blocks,
      flowRegions,
    };
  });

  return {
    documentHash: pdfHash || analysis.documentHash,
    pageCount: pages.length,
    analyzer: {
      name: analysis.analyzer.name,
      version: analysis.analyzer.version,
      modelVersions: analysis.analyzer.modelVersions,
    },
    pages,
  };
}

export function pdfLayoutToDocumentIR(
  layouts: Record<number, PdfPageLayout>,
  totalPages: number,
  pdfHash: string,
): DocumentIR {
  const pages: PageIR[] = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const layout = layouts[pageNumber];
    if (!layout) continue;

    const blocks = layout.blocks.map((block) => pdfLayoutBlockToLayoutBlock(block, pageNumber, layout.width));
    assignReadingOrder(blocks);
    const flowRegions = buildFlowRegions(blocks, layout.width, layout.height);

    pages.push({
      pageNumber,
      width: layout.width,
      height: layout.height,
      blocks,
      flowRegions,
    });
  }

  return {
    documentHash: pdfHash,
    pageCount: pages.length,
    analyzer: {
      name: "pdfjs-fast",
      version: "1.0",
      modelVersions: {},
    },
    pages,
  };
}

export function mergeDoclingIRIntoPdfLayout(
  pdfLayouts: Record<number, PdfPageLayout>,
  doclingAnalysis: DocumentAnalysis,
): Record<number, PdfPageLayout> {
  const merged: Record<number, PdfPageLayout> = {};

  for (const doclingPage of doclingAnalysis.pages) {
    const pdfLayout = pdfLayouts[doclingPage.pageNumber];
    if (!pdfLayout) continue;

    const pdfBlocks = new Map(pdfLayout.blocks.map((b) => [b.id, { ...b }]));
    const doclingBlocks = new Map<string, PdfTextBlock>();

    for (const item of doclingPage.items) {
      if (item.kind === "formula" || item.kind === "artifact") continue;

      const existing = pdfBlocks.get(item.id);
      if (existing) {
        existing.kind = item.kind === "heading" ? "heading" : item.kind === "caption" ? "caption" : existing.kind;
        existing.textAlign = item.textAlign ?? existing.textAlign;
        existing.emphasis = item.emphasis ?? existing.emphasis;
        doclingBlocks.set(item.id, existing);
      } else {
        const block: PdfTextBlock = {
          id: item.id,
          text: item.text,
          left: item.bbox.left,
          top: item.bbox.top,
          width: item.bbox.right - item.bbox.left,
          height: item.bbox.bottom - item.bbox.top,
          fontSize: item.fontSize,
          kind: item.kind === "heading" ? "heading" : item.kind === "caption" ? "caption" : "text",
          translatable: item.translatable,
          textAlign: item.textAlign,
          emphasis: item.emphasis,
        };
        doclingBlocks.set(item.id, block);
      }
    }

    const resultBlocks: PdfTextBlock[] = [];
    const seen = new Set<string>();

    for (const item of doclingPage.items) {
      const block = doclingBlocks.get(item.id);
      if (block && !seen.has(block.id)) {
        resultBlocks.push(block);
        seen.add(block.id);
      }
    }

    for (const block of pdfLayout.blocks) {
      if (!seen.has(block.id)) {
        resultBlocks.push(block);
        seen.add(block.id);
      }
    }

    merged[doclingPage.pageNumber] = {
      width: pdfLayout.width,
      height: pdfLayout.height,
      textRects: pdfLayout.textRects,
      blocks: resultBlocks,
    };
  }

  for (const pageNumber of Object.keys(pdfLayouts).map(Number)) {
    if (!merged[pageNumber]) {
      merged[pageNumber] = pdfLayouts[pageNumber];
    }
  }

  return merged;
}
