import { Util, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";

export type PdfTextBlock = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  kind: "text" | "heading" | "caption" | "table" | "formula" | "artifact";
  translatable: boolean;
  textAlign?: "left" | "center" | "right";
  emphasis?: "bold";
};

export type PdfPageLayout = {
  width: number;
  height: number;
  textRects: Array<Pick<PdfTextBlock, "left" | "top" | "width" | "height" | "fontSize">>;
  blocks: PdfTextBlock[];
};

type TextPiece = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
};

type PdfJsTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

function textPieceFromItem(item: PdfJsTextItem, viewport: ReturnType<PDFPageProxy["getViewport"]>): TextPiece {
  // Text-content matrices are expressed in PDF page coordinates. Applying the
  // viewport matrix is required for pages with a non-zero CropBox origin or a
  // rotation; using transform[4]/[5] directly only works for simple MediaBoxes.
  const transform = Util.transform(viewport.transform, item.transform);
  const horizontalLength = Math.hypot(transform[0], transform[1]);
  const verticalLength = Math.hypot(transform[2], transform[3]);
  const fontSize = Math.max(5, verticalLength || Math.abs(item.height) * viewport.scale);
  const advance = Math.max(item.width * viewport.scale, fontSize * 0.3);
  const horizontalX = horizontalLength ? (transform[0] / horizontalLength) * advance : advance;
  const horizontalY = horizontalLength ? (transform[1] / horizontalLength) * advance : 0;
  const verticalX = verticalLength ? (transform[2] / verticalLength) * fontSize : 0;
  const verticalY = verticalLength ? (transform[3] / verticalLength) * fontSize : -fontSize;
  const corners = [
    [transform[4], transform[5]],
    [transform[4] + horizontalX, transform[5] + horizontalY],
    [transform[4] + verticalX, transform[5] + verticalY],
    [transform[4] + horizontalX + verticalX, transform[5] + horizontalY + verticalY],
  ];
  const left = Math.min(...corners.map(([x]) => x));
  const right = Math.max(...corners.map(([x]) => x));
  const top = Math.min(...corners.map(([, y]) => y));
  const bottom = Math.max(...corners.map(([, y]) => y));
  return {
    text: item.str,
    left,
    top,
    width: Math.max(right - left, fontSize * 0.3),
    height: Math.max(bottom - top, fontSize),
    fontSize,
  };
}

type TextLine = TextPiece & { pieces: TextPiece[] };

type FlowColumn = "left" | "right" | "spanning";

type WorkingBlock = PdfTextBlock & {
  column: FlowColumn;
  hasDropCap: boolean;
  lastLineLeft: number;
  lastLineRight: number;
  lastLineText: string;
};

type BlockKind = PdfTextBlock["kind"];

const cache = new Map<string, Promise<PdfPageLayout>>();

type TextContentChunk = {
  items?: unknown[];
};

// PDF.js 6 uses `for await...of` inside getTextContent(). Some WKWebView
// versions expose ReadableStream without Symbol.asyncIterator, so consume the
// same stream through its reader API instead.
async function readTextItems(page: PDFPageProxy): Promise<unknown[]> {
  const stream = page.streamTextContent({ includeMarkedContent: false });
  const reader = stream.getReader();
  const items: unknown[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value as TextContentChunk | undefined;
      if (!chunk || !Array.isArray(chunk.items)) continue;
      for (let index = 0; index < chunk.items.length; index += 1) {
        items.push(chunk.items[index]);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return items;
}

function isPdfJsTextItem(item: unknown): item is PdfJsTextItem {
  if (!item || typeof item !== "object") return false;
  const candidate = item as Record<string, unknown>;
  return typeof candidate.str === "string"
    && Array.isArray(candidate.transform)
    && candidate.transform.length >= 6
    && typeof candidate.width === "number"
    && typeof candidate.height === "number";
}

function documentKey(document: PDFDocumentProxy) {
  const fingerprints = Array.isArray(document.fingerprints) ? document.fingerprints : [];
  return fingerprints.filter(Boolean).join(":") || `pages-${document.numPages}`;
}

function lineFromPieces(pieces: TextPiece[]): TextLine {
  const ordered = pieces.slice().sort((a, b) => a.left - b.left);
  const left = Math.min(...ordered.map((piece) => piece.left));
  const top = Math.min(...ordered.map((piece) => piece.top));
  const right = Math.max(...ordered.map((piece) => piece.left + piece.width));
  let text = "";
  let previousRight = ordered[0]?.left ?? 0;
  for (const piece of ordered) {
    const gap = piece.left - previousRight;
    if (text && gap > Math.max(1.5, piece.fontSize * 0.18) && !text.endsWith(" ")) text += " ";
    text += piece.text;
    previousRight = piece.left + piece.width;
  }
  return {
    text: text.trim(),
    left,
    top,
    width: right - left,
    height: Math.max(...ordered.map((piece) => piece.height)),
    fontSize: Math.max(...ordered.map((piece) => piece.fontSize)),
    pieces: ordered,
  };
}

function splitBaseline(pieces: TextPiece[], pageWidth: number, tableMode = false): TextLine[] {
  const ordered = pieces.slice().sort((a, b) => a.left - b.left);
  const groups: TextPiece[][] = [];
  for (const piece of ordered) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    const gap = previous ? piece.left - (previous.left + previous.width) : 0;
    // PDF text streams commonly put the left- and right-column fragments on
    // the same baseline. A real inter-column gutter is much wider than a word
    // space, so split it before reconstructing the line.
    const previousRight = previous ? previous.left + previous.width : 0;
    const crossesPageMidpoint = previous
      ? previousRight < pageWidth / 2 && piece.left > pageWidth / 2
      : false;
    const splitGap = previous
      ? tableMode
        ? Math.max(6, Math.min(previous.fontSize, piece.fontSize) * 0.65)
        : crossesPageMidpoint
        ? Math.max(7.5, Math.min(previous.fontSize, piece.fontSize) * 0.82)
        : Math.max(20, Math.min(previous.fontSize, piece.fontSize) * 2)
      : Number.POSITIVE_INFINITY;
    if (!group || gap > splitGap) groups.push([piece]);
    else group.push(piece);
  }
  return groups.map(lineFromPieces).filter((line) => line.text);
}

function makeLines(pieces: TextPiece[], pageWidth: number): TextLine[] {
  const baselines: TextLine[] = [];
  const sorted = pieces.slice().sort((a, b) => a.top - b.top || a.left - b.left);

  for (let pieceIndex = 0; pieceIndex < sorted.length; pieceIndex += 1) {
    const piece = sorted[pieceIndex];
    const line = baselines.find((candidate) =>
      Math.abs(candidate.top - piece.top) <= Math.max(3, Math.min(candidate.fontSize, piece.fontSize) * 0.45),
    );
    if (line) {
      line.pieces.push(piece);
      const right = Math.max(line.left + line.width, piece.left + piece.width);
      line.left = Math.min(line.left, piece.left);
      line.top = Math.min(line.top, piece.top);
      line.width = right - line.left;
      line.height = Math.max(line.height, piece.height);
      line.fontSize = Math.max(line.fontSize, piece.fontSize);
    } else {
      baselines.push({ ...piece, pieces: [piece] });
    }
  }

  const provisional = baselines.flatMap((line) => splitBaseline(line.pieces, pageWidth));
  const provisionalTableLines = tableLines(provisional);
  const refined = provisional.flatMap((line) => provisionalTableLines.has(line)
    ? splitBaseline(line.pieces, pageWidth, true)
    : [line]);
  return mergeTableCellLines(refined, tableLines(refined));
}

function flowColumn(line: TextLine, pageWidth: number): FlowColumn {
  const midpoint = pageWidth / 2;
  const gutter = Math.max(9, pageWidth * 0.018);
  const right = line.left + line.width;
  // Large display titles frequently have a short final line which does not
  // geometrically cross the midpoint. They still belong to the full-width
  // title region rather than the left article column.
  if (line.fontSize >= 16 && line.top < 220) return "spanning";
  if (line.left < midpoint - gutter && right > midpoint + gutter) return "spanning";
  return (line.left + right) / 2 < midpoint ? "left" : "right";
}

function isArtifactText(text: string): boolean {
  const normalized = text.trim();
  return /^VOLUME\b/i.test(normalized)
    || /^This article has been accepted for publication\b/i.test(normalized)
    || /^This work is licensed under\b/i.test(normalized)
    || /^Date of publication\b/i.test(normalized)
    || /^Digital Object Identifier\b/i.test(normalized)
    || /^\d{4}-\d{4}\s+\(c\)/i.test(normalized);
}

function isHeadingText(text: string): boolean {
  const normalized = text.trim();
  return /^(?:[IVX]+\.|\d+(?:\.\d+)*|[A-Z]\.)\s+[A-Z][A-Z\s\-/]+$/.test(normalized)
    || /^(?:ABSTRACT|INDEX TERMS|REFERENCES|ACKNOWLEDGMENTS?)\b/.test(normalized);
}

function isCaptionText(text: string): boolean {
  return /^(?:FIG(?:URE)?|TABLE)\s*\d+\s*[.:]/i.test(text.trim());
}

function isNonLinguisticText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  if (!/[\p{L}]/u.test(normalized)) return true;
  if (/^[A-Z0-9+./-]{2,}$/.test(normalized)) return true;
  if (/^(?:char-BERT|word-BERT|CNN|RNN|LSTM|SVR|LR)$/i.test(normalized)) return true;
  const bareToken = normalized.replace(/[\s,.;:()[\]]+/g, "");
  if (/^(?:[QKVPWX]|emb|enc|att|word|char|mod)$/i.test(bareToken)) return true;
  const letters = normalized.match(/[\p{L}]/gu)?.length ?? 0;
  const formulaMarks = normalized.match(/[=∑Σσμλ±×÷√∞∂∫<>]/g)?.length ?? 0;
  return normalized.length < 80 && formulaMarks >= 1
    || normalized.length < 90 && formulaMarks >= 1 && letters / normalized.length < 0.55;
}

function tableLines(lines: TextLine[]): Set<TextLine> {
  const ordered = lines.slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const captions = ordered.filter((line) => /^TABLE\s*\d+\s*[.:]/i.test(line.text.trim()));
  const result = new Set<TextLine>();
  for (let captionIndex = 0; captionIndex < captions.length; captionIndex += 1) {
    const caption = captions[captionIndex];
    const nextCaption = captions[captionIndex + 1];
    let previousTop = caption.top;
    for (const line of ordered) {
      if (line.top <= caption.top + 1) continue;
      if (nextCaption && line.top >= nextCaption.top - 1) break;
      if (isArtifactText(line.text)) break;
      // A large blank band marks the end of a table when body text follows it.
      if (line.top - previousTop > 30) break;
      result.add(line);
      previousTop = line.top;
    }
  }
  return result;
}

function mergeTableCellLines(lines: TextLine[], tableLineSet: Set<TextLine>): TextLine[] {
  const ordinary = lines.filter((line) => !tableLineSet.has(line));
  const merged: TextLine[] = [];
  const table = lines.filter((line) => tableLineSet.has(line)).sort((a, b) => a.top - b.top || a.left - b.left);
  for (const line of table) {
    const candidate = merged.find((previous) => {
      const gap = line.top - (previous.top + previous.height);
      const centerDistance = Math.abs(
        (line.left + line.width / 2) - (previous.left + previous.width / 2),
      );
      return gap >= -1 && gap <= 4
        && centerDistance < Math.max(7, Math.min(line.width, previous.width) * 0.28)
        && /[\p{L}]/u.test(line.text)
        && /[\p{L}]/u.test(previous.text);
    });
    if (candidate) {
      const right = Math.max(candidate.left + candidate.width, line.left + line.width);
      candidate.text = `${candidate.text}\n${line.text}`;
      candidate.left = Math.min(candidate.left, line.left);
      candidate.width = right - candidate.left;
      candidate.height = line.top + line.height - candidate.top;
      candidate.pieces.push(...line.pieces);
    } else {
      merged.push({ ...line, pieces: line.pieces.slice() });
    }
  }
  return [...ordinary, ...merged];
}

function formulaLines(lines: TextLine[]): Set<TextLine> {
  const anchors = lines.filter((line) => {
    const text = line.text.trim();
    return /^\(\d+[a-z]?\)$/.test(text)
      || (text.length < 180 && /\(\d+[a-z]?\)$/.test(text));
  });
  const result = new Set<TextLine>();
  for (const anchor of anchors) {
    for (const line of lines) {
      const belongsToEquation = line.left < anchor.left + 20
        && line.left + line.width <= anchor.left + anchor.width + 20;
      if (belongsToEquation && line.top >= anchor.top - 7 && line.top <= anchor.top + 14) result.add(line);
    }
  }
  return result;
}

function blockKind(line: TextLine, tableLineSet: Set<TextLine>, formulaLineSet: Set<TextLine>): BlockKind {
  if (isArtifactText(line.text)) return "artifact";
  if (isCaptionText(line.text)) return "caption";
  if (tableLineSet.has(line)) return "table";
  if (formulaLineSet.has(line)) return "formula";
  if (isHeadingText(line.text) || line.fontSize >= 16) return "heading";
  return "text";
}

function mergeOverlappingTextBlocks(blocks: WorkingBlock[]): WorkingBlock[] {
  const merged: WorkingBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "text" || !block.translatable) {
      merged.push(block);
      continue;
    }
    const previous = merged.slice().reverse().find((candidate) =>
      candidate.kind === "text" && candidate.translatable && candidate.column === block.column,
    );
    if (!previous) {
      merged.push(block);
      continue;
    }
    const overlapWidth = Math.min(previous.left + previous.width, block.left + block.width)
      - Math.max(previous.left, block.left);
    const overlapHeight = Math.min(previous.top + previous.height, block.top + block.height)
      - Math.max(previous.top, block.top);
    const sameParagraphLane = overlapWidth > Math.min(previous.width, block.width) * 0.45;
    if (overlapHeight > 2 && sameParagraphLane) {
      const right = Math.max(previous.left + previous.width, block.left + block.width);
      previous.text = `${previous.text}\n${block.text}`;
      previous.left = Math.min(previous.left, block.left);
      previous.width = right - previous.left;
      previous.height = Math.max(previous.top + previous.height, block.top + block.height) - previous.top;
      previous.lastLineLeft = block.lastLineLeft;
      previous.lastLineRight = block.lastLineRight;
      previous.lastLineText = block.lastLineText;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function orderColumnBand(lines: TextLine[], pageWidth: number): TextLine[] {
  const sorted = (column: FlowColumn) => lines
    .filter((line) => flowColumn(line, pageWidth) === column)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  return [...sorted("left"), ...sorted("right")];
}

function readingOrder(lines: TextLine[], pageWidth: number): TextLine[] {
  const anchors = lines
    .filter((line) => flowColumn(line, pageWidth) === "spanning")
    .sort((a, b) => a.top - b.top || a.left - b.left);
  let remaining = lines.filter((line) => flowColumn(line, pageWidth) !== "spanning");
  const ordered: TextLine[] = [];

  for (const anchor of anchors) {
    const before = remaining.filter((line) => line.top < anchor.top - 1);
    const sameBaseline = remaining
      .filter((line) => Math.abs(line.top - anchor.top) <= 1)
      .sort((a, b) => a.left - b.left);
    ordered.push(
      ...orderColumnBand(before, pageWidth),
      ...[anchor, ...sameBaseline].sort((a, b) => a.left - b.left),
    );
    const consumed = new Set([...before, ...sameBaseline]);
    remaining = remaining.filter((line) => !consumed.has(line));
  }
  ordered.push(...orderColumnBand(remaining, pageWidth));
  return ordered;
}

function makeBlocks(lines: TextLine[], pageNumber: number, pageWidth: number): PdfTextBlock[] {
  const blocks: WorkingBlock[] = [];
  const sorted = readingOrder(lines, pageWidth);
  const tableLineSet = tableLines(lines);
  const formulaLineSet = formulaLines(lines);

  for (let lineIndex = 0; lineIndex < sorted.length; lineIndex += 1) {
    const line = sorted[lineIndex];
    const previous = blocks[blocks.length - 1];
    const column = flowColumn(line, pageWidth);
    const kind = blockKind(line, tableLineSet, formulaLineSet);
    const verticalGap = previous ? line.top - (previous.top + previous.height) : Number.POSITIVE_INFINITY;
    const sameColumn = previous?.column === column;
    const similarFont = previous ? Math.abs(previous.fontSize - line.fontSize) < Math.max(1, previous.fontSize * 0.12) : false;
    const startsNumberedEntry = /^\s*(?:\[\d+\]|\d+[.)])\s+/.test(line.text);
    const startsNewParagraph = startsNumberedEntry || (previous
      ? line.left - previous.lastLineLeft > Math.max(6, line.fontSize * 0.65)
        && /[.!?]["')\]]?$/.test(previous.lastLineText.trim())
      : false);
    const isDropCap = previous?.column === column
      && /^[A-Z]$/.test(previous.text.trim())
      && previous.fontSize > line.fontSize * 1.45
      && line.top < previous.top + previous.height
      && line.left < previous.lastLineRight + line.fontSize * 4;
    if (previous && isDropCap) {
      const right = Math.max(previous.left + previous.width, line.left + line.width);
      previous.text = `${previous.text}${line.text}`;
      previous.width = right - previous.left;
      previous.height = Math.max(previous.height, line.top + line.height - previous.top);
      previous.fontSize = line.fontSize;
      previous.hasDropCap = true;
      previous.lastLineLeft = line.left;
      previous.lastLineRight = line.left + line.width;
      previous.lastLineText = line.text;
      continue;
    }
    const captionContinuation = previous?.kind === "caption"
      && kind === "text"
      && line.top - (previous.top + previous.height) < Math.max(9, line.fontSize * 1.2)
      && line.left >= previous.left - 3
      && line.left + line.width <= previous.left + previous.width + 3;
    const displayHeadingContinuation = previous?.kind === "heading"
      && kind === "heading"
      && previous.fontSize >= 15
      && sameColumn
      && similarFont;
    const overlappingLineContinuation = previous
      && verticalGap < -2
      && verticalGap >= -line.fontSize
      && Math.abs(line.left - previous.lastLineLeft) < line.fontSize * 1.5;
    const canMerge = previous
      && kind !== "table"
      && kind !== "formula"
      && previous.kind !== "table"
      && previous.kind !== "formula"
      && (previous.kind !== "heading" || displayHeadingContinuation)
      && (captionContinuation || displayHeadingContinuation || (sameColumn && similarFont && !startsNewParagraph))
      && (verticalGap >= -2 || previous.hasDropCap || overlappingLineContinuation)
      && verticalGap < Math.max(7, line.fontSize * 0.9)
      && previous.text.length < 1200;

    if (canMerge) {
      const right = Math.max(previous.left + previous.width, line.left + line.width);
      previous.text = `${previous.text}\n${line.text}`;
      previous.width = right - previous.left;
      previous.height = Math.max(previous.height, line.top + line.height - previous.top);
      previous.lastLineLeft = line.left;
      previous.lastLineRight = line.left + line.width;
      previous.lastLineText = line.text;
      if (captionContinuation) previous.kind = "caption";
    } else {
      const translatable = kind !== "artifact" && kind !== "formula" && !isNonLinguisticText(line.text);
      blocks.push({
        id: `p${pageNumber}-b${blocks.length + 1}`,
        text: line.text,
        left: line.left,
        top: line.top,
        width: line.width,
        height: line.height,
        fontSize: line.fontSize,
        kind,
        translatable,
        column,
        hasDropCap: false,
        lastLineLeft: line.left,
        lastLineRight: line.left + line.width,
        lastLineText: line.text,
      });
    }
  }
  return mergeOverlappingTextBlocks(blocks).map(({
    column: _column,
    hasDropCap: _dropCap,
    lastLineLeft: _left,
    lastLineRight: _right,
    lastLineText: _text,
    ...block
  }, index) => ({ ...block, id: `p${pageNumber}-b${index + 1}` }));
}

export function getPageLayout(document: PDFDocumentProxy, pageNumber: number): Promise<PdfPageLayout> {
  const key = `${documentKey(document)}:${pageNumber}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textItems = await readTextItems(page);
    const pieces = textItems
      .filter((item): item is PdfJsTextItem => isPdfJsTextItem(item) && Boolean(item.str.trim()))
      .map<TextPiece>((item) => textPieceFromItem(item, viewport));

    return {
      width: viewport.width,
      height: viewport.height,
      // Keep the original PDF.js text-item geometry separate from the merged
      // translation blocks. The merged blocks are useful for translation, but
      // their bounds can omit short runs, superscripts and split column text.
      textRects: pieces.map(({ left, top, width, height, fontSize }) => ({ left, top, width, height, fontSize })),
      blocks: makeBlocks(makeLines(pieces, viewport.width), pageNumber, viewport.width),
    };
  })();

  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}
