import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Translator } from "../i18n";

type PdfPageProps = {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  t: Translator;
};

export function PdfPage({ document, pageNumber, scale, t }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(pageNumber <= 2);
  const [size, setSize] = useState({ width: 612 * scale, height: 792 * scale });

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
    let renderTask: RenderTask | undefined;
    let cancelled = false;

    document.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      setSize({ width: viewport.width, height: viewport.height });
      if (!visible || !canvasRef.current) return;

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
      renderTask.promise.catch((error) => {
        if (error?.name !== "RenderingCancelledException") console.error(error);
      });
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, scale, visible]);

  return (
    <article ref={hostRef} className="pdf-page" data-page={pageNumber} style={{ width: size.width, height: size.height }}>
      {visible && <canvas ref={canvasRef} aria-label={t("pdfPage", { page: pageNumber })} />}
      <span className="page-number-badge">{pageNumber}</span>
    </article>
  );
}
