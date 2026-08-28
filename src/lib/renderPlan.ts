import type { PdfPageLayout, PdfTextBlock } from "./pdfLayout";
import type { TranslatedBlock } from "../components/TranslationPage";

// Versioned wire contract between the React export flow and the Python
// renderer. Bump RENDER_PLAN_VERSION whenever the shape below changes; the
// Rust command and pdf_renderer.py both check it.
export const RENDER_PLAN_VERSION = 1;

export type RenderMode = "faithful" | "adaptive" | "bilingual";

export type RenderRect = { x: number; y: number; width: number; height: number };

export type RenderPlanBlock = {
  id: string;
  // The same 6 kinds pdfLayout.ts produces — no second taxonomy.
  kind: PdfTextBlock["kind"];
  // PDF user-space coordinates, scale 1, top-left origin.
  bbox: RenderRect;
  fontSize: number;
  textAlign?: "left" | "center" | "right";
  emphasis?: "bold";
  // The translation. Blocks without one never reach the plan.
  text: string;
  // Tight per-glyph rects inside this block to redact — never the loose merged
  // bbox, which spans gutters and table rules that must survive.
  maskRects: RenderRect[];
};

export type RenderPagePlan = {
  pageNumber: number;
  // Page geometry so the Python side can assert its coordinate system matches
  // (rotation / non-zero CropBox origin would otherwise misplace everything).
  width: number;
  height: number;
  blocks: RenderPlanBlock[];
};

export type RenderPlan = {
  version: number;
  mode: RenderMode;
  targetLanguage: string;
  fontScale: number;
  minFontScale: number;
  pages: RenderPagePlan[];
};

export type BuildRenderPlanOptions = {
  mode: RenderMode;
  targetLanguage: string;
  fontScale: number;
  minFontScale?: number;
};

const DEFAULT_MIN_FONT_SCALE = 0.85;

function maskRectsForBlock(layout: PdfPageLayout, block: PdfTextBlock): RenderRect[] {
  const right = block.left + block.width;
  const bottom = block.top + block.height;
  return layout.textRects
    .filter((rect) => {
      const overlapWidth = Math.min(rect.left + rect.width, right) - Math.max(rect.left, block.left);
      const overlapHeight = Math.min(rect.top + rect.height, bottom) - Math.max(rect.top, block.top);
      return overlapWidth > 0
        && overlapHeight > 0
        && overlapWidth * overlapHeight > rect.width * rect.height * 0.3;
    })
    .map((rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));
}

export function buildRenderPlan(
  layouts: Record<number, PdfPageLayout>,
  translations: Record<number, TranslatedBlock[]>,
  pageCount: number,
  options: BuildRenderPlanOptions,
): RenderPlan {
  const pages: RenderPagePlan[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const layout = layouts[pageNumber];
    if (!layout) continue;

    const translatedById = new Map((translations[pageNumber] ?? []).map((entry) => [entry.id, entry.text]));
    if (translatedById.size === 0) continue;

    const blocks: RenderPlanBlock[] = [];
    for (const block of layout.blocks) {
      if (!block.translatable || block.kind === "formula" || block.kind === "artifact") continue;
      const text = translatedById.get(block.id);
      if (!text) continue;
      blocks.push({
        id: block.id,
        kind: block.kind,
        bbox: { x: block.left, y: block.top, width: block.width, height: block.height },
        fontSize: block.fontSize,
        textAlign: block.textAlign,
        emphasis: block.emphasis,
        text,
        maskRects: maskRectsForBlock(layout, block),
      });
    }
    if (blocks.length === 0) continue;

    pages.push({ pageNumber, width: layout.width, height: layout.height, blocks });
  }

  return {
    version: RENDER_PLAN_VERSION,
    mode: options.mode,
    targetLanguage: options.targetLanguage,
    fontScale: options.fontScale,
    minFontScale: options.minFontScale ?? DEFAULT_MIN_FONT_SCALE,
    pages,
  };
}
