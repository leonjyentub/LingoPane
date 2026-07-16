import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { getPageLayout, type PdfPageLayout } from "../lib/pdfLayout";
import type { Translator } from "../i18n";

export type TranslatedBlock = { id: string; text: string };
export type TranslationStatus = "idle" | "loading" | "success" | "error";

type TranslationPageProps = {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  layoutOverride?: PdfPageLayout;
  translationFontScale?: number;
  translationLineHeightScale?: number;
  translations?: TranslatedBlock[];
  status?: TranslationStatus;
  error?: string;
  onLayoutResolved?: (pageNumber: number, layout: PdfPageLayout) => void;
  t: Translator;
};

type FittedTextBlockProps = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  kind: "text" | "heading" | "caption" | "table" | "formula" | "artifact";
  textAlign?: "left" | "center" | "right";
  emphasis?: "bold";
  lineHeightScale: number;
  t: Translator;
};

function FittedTextBlock({ text, left, top, width, height, fontSize, kind, textAlign, emphasis, lineHeightScale, t }: FittedTextBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let attempts = 0;
    const minimum = Math.max(5.5, fontSize * 0.58);
    setOverflowing(false);
    setExpanded(false);
    element.style.fontSize = `${fontSize}px`;

    const fit = () => {
      const heightRatio = element.clientHeight / Math.max(element.clientHeight, element.scrollHeight);
      const widthRatio = element.clientWidth / Math.max(element.clientWidth, element.scrollWidth);
      const ratio = Math.min(heightRatio, widthRatio);
      const current = Number.parseFloat(element.style.fontSize) || fontSize;
      if (ratio < 0.995 && current > minimum && attempts < 6) {
        attempts += 1;
        element.style.fontSize = `${Math.max(minimum, current * ratio * 0.97)}px`;
        frame = requestAnimationFrame(fit);
      } else {
        setOverflowing(element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);
      }
    };
    frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fontSize, height, lineHeightScale, text, width]);

  return (
    <div
      ref={ref}
      className={`translated-block is-${kind}${overflowing ? " has-overflow" : ""}${expanded ? " is-expanded" : ""}`}
      style={{
        left,
        top,
        width: expanded ? Math.max(width, 280) : width,
        height: expanded ? "auto" : height,
        minHeight: height,
        maxHeight: expanded ? 320 : undefined,
        fontSize,
        lineHeight: (kind === "table" ? 1.15 : 1.22) * lineHeightScale,
        textAlign,
        fontWeight: emphasis === "bold" ? 700 : undefined,
      }}
    >
      {text}
      {overflowing && (
        <button
          className="overflow-reader-button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          title={t(expanded ? "collapseTranslation" : "expandTranslationHelp")}
        >{t(expanded ? "collapse" : "expand")}</button>
      )}
    </div>
  );
}

export function TranslationPage({ document, pageNumber, scale, layoutOverride, translationFontScale = 1.8, translationLineHeightScale = 1, translations, status = "idle", error, onLayoutResolved, t }: TranslationPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(pageNumber <= 2);
  const [layout, setLayout] = useState<PdfPageLayout>({ width: 612, height: 792, textRects: [], blocks: [] });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "700px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (layoutOverride) {
      setLayout(layoutOverride);
      return;
    }
    let cancelled = false;
    document.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1 });
      setLayout((current) => ({ ...current, width: viewport.width, height: viewport.height }));
      if (visible) {
        getPageLayout(document, pageNumber).then((nextLayout) => {
          if (!cancelled) {
            setLayout(nextLayout);
            onLayoutResolved?.(pageNumber, nextLayout);
          }
        }).catch(console.error);
      }
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [document, layoutOverride, onLayoutResolved, pageNumber, visible]);

  useEffect(() => {
    let renderTask: RenderTask | undefined;
    let cancelled = false;
    document.getPage(pageNumber).then((page) => {
      if (cancelled || !visible || !canvasRef.current) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      renderTask = page.render({
        canvas,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      renderTask.promise.catch((cause) => {
        if (cause?.name !== "RenderingCancelledException") console.error(cause);
      });
    });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [document, pageNumber, scale, visible]);

  const translatedById = new Map(translations?.map((block) => [block.id, block.text]) ?? []);
  const translated = status === "success" && translatedById.size > 0;
  const preservedSourceBlocks = layout.blocks.filter((block) =>
    block.kind === "formula" || (block.kind === "table" && !block.translatable),
  );

  return (
    <article
      ref={hostRef}
      className={`pdf-page translation-page is-${status}`}
      data-page={pageNumber}
      style={{ width: layout.width * scale, height: layout.height * scale }}
    >
      {visible && <canvas ref={canvasRef} aria-hidden="true" />}

      {translated && (
        <div className="translated-layer">
          <div className="source-text-mask" aria-hidden="true">
            {layout.textRects.map((rect, index) => (
              <span
                key={index}
                style={{
                  left: rect.left * scale - 1.5,
                  top: rect.top * scale - 1.5,
                  width: Math.max(6, rect.width * scale + 3),
                  height: Math.max(rect.fontSize * scale * 1.08, rect.height * scale + 3),
                }}
              />
            ))}
          </div>

          <div className="preserved-source-layer" aria-hidden="true">
            {preservedSourceBlocks.map((block) => (
              <span
                key={block.id}
                className={`preserved-source-block is-${block.kind}`}
                style={{
                  left: block.left * scale,
                  top: block.top * scale,
                  width: Math.max(10, block.width * scale),
                  minHeight: Math.max(block.fontSize * scale * 1.15, block.height * scale),
                  fontSize: Math.max(6.5, block.fontSize * scale),
                }}
              >
                {block.text}
              </span>
            ))}
          </div>

          {layout.blocks.filter((block) => translatedById.has(block.id)).map((block) => (
            <FittedTextBlock
              key={block.id}
              text={translatedById.get(block.id) ?? ""}
              left={block.left * scale - 2}
              top={block.top * scale - 2}
              width={Math.max(24, block.width * scale + 4)}
              height={Math.max(block.fontSize * scale * 1.25, block.height * scale + 4)}
              fontSize={Math.max(7, block.fontSize * scale * translationFontScale)}
              kind={block.kind}
              textAlign={block.textAlign}
              emphasis={block.emphasis}
              lineHeightScale={translationLineHeightScale}
              t={t}
            />
          ))}
        </div>
      )}

      {!translated && (
        <div className="translation-mask">
          <div className="layout-skeleton" aria-hidden="true">
            {layout.blocks.map((block) => (
              <span key={block.id} style={{ left: block.left * scale, top: block.top * scale, width: block.width * scale, height: Math.max(3, block.height * scale * 0.55) }} />
            ))}
          </div>
          <div className="translation-status">
            {status === "loading" ? <><span className="spinner" /><strong>{t("translatingPage", { page: pageNumber })}</strong><span>{t("localModelWait")}</span></> :
              status === "error" ? <><strong>{t("translationFailed")}</strong><span className="translation-error">{error}</span></> :
              <><strong>{t("notTranslated")}</strong><span>{t("translateStartHint")}</span></>}
          </div>
        </div>
      )}
      <span className="page-number-badge">{pageNumber}</span>
    </article>
  );
}
