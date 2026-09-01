import { ChangeEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PdfPage } from "./components/PdfPage";
import { OutlineSidebar, type PdfOutlineItem } from "./components/OutlineSidebar";
import { ExportDialog } from "./components/ExportDialog";
import { TranslationPage, type TranslatedBlock, type TranslationStatus } from "./components/TranslationPage";
import { buildDoclingLayouts, type AnalysisMode, type DoclingStatus, type DocumentAnalysis } from "./lib/docling";
import { getPageLayout } from "./lib/pdfLayout";
import type { PdfPageLayout } from "./lib/pdfLayout";
import { buildRenderPlan, type RenderMode } from "./lib/renderPlan";
import { createTranslator, resolveInterfaceLanguage, type InterfaceLanguage } from "./i18n";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerUrl;

type Provider = "omlx" | "ollama" | "openai-compatible";
type ReaderSettings = {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  translationFontScale: number;
  analysisMode: AnalysisMode;
  layoutModel: "heron" | "egret-large" | "egret-xlarge";
  renderMode: RenderMode;
  doclingPythonPath: string;
  doclingOcr: boolean;
  cacheDocumentLimit: number;
  interfaceLanguage: InterfaceLanguage;
};

const providerDefaults: Record<Provider, string> = {
  omlx: "http://127.0.0.1:8000/v1",
  ollama: "http://localhost:11434/v1",
  "openai-compatible": "https://api.openai.com/v1",
};

const settingsVersion = 8;

const initialSettings: ReaderSettings = {
  provider: "omlx",
  baseUrl: providerDefaults.omlx,
  apiKey: "",
  model: "",
  sourceLanguage: "auto",
  targetLanguage: "zh-TW",
  translationFontScale: 1.8,
  analysisMode: "fast",
  layoutModel: "egret-large",
  renderMode: "faithful",
  doclingPythonPath: "",
  doclingOcr: false,
  cacheDocumentLimit: 30,
  interfaceLanguage: "system",
};

type TranslationResult = {
  blocks: TranslatedBlock[];
  model: string;
  missingIds: string[];
};

type PageTranslationState = {
  status: TranslationStatus;
  error?: string;
  restoredFromCache?: boolean;
  missingIds?: string[];
};

type BatchTranslationState = {
  running: boolean;
  completed: number;
  total: number;
  currentPage?: number;
};

type AnalysisState = {
  status: "idle" | "loading" | "success" | "error";
  message: string;
  pageCount?: number;
  totalPages?: number;
};

type DoclingAnalysisBatchEvent = {
  analysisId: number;
  batchStart: number;
  batchEnd: number;
  completedPages: number;
  totalPages: number;
  analysis: DocumentAnalysis;
};

type OpenedCachedDocument = {
  documentId: string;
};

type CachedDocumentData = {
  layouts: Array<{ pageNumber: number; layout: PdfPageLayout }>;
  translations: Array<{ pageNumber: number; blocks: TranslatedBlock[] }>;
};

type ClearedCache = {
  documents: number;
  layouts: number;
  translations: number;
};

type DroppedPdf = {
  fileName: string;
  pdfBytes: number[];
};

type RecentDocument = {
  documentId: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  lastAccessed: number;
};

type AnalysisSettings = Pick<ReaderSettings, "analysisMode" | "layoutModel" | "doclingPythonPath" | "doclingOcr">;

type WebKitGestureEvent = Event & {
  scale?: number;
};

function errorMessage(cause: unknown, fallback = "發生未預期的錯誤") {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return fallback;
}

function analysisCacheKey(settings: Pick<ReaderSettings, "analysisMode" | "doclingOcr" | "layoutModel">) {
  return settings.analysisMode === "docling"
    ? `layout-v5:docling:ocr-${settings.doclingOcr ? "on" : "off"}:layout-${settings.layoutModel}`
    : "layout-v5:pdfjs";
}

// Bump when the translation prompt or request strategy in src-tauri/src/llm.rs
// changes, so cached translations from the old prompt stop matching.
const TRANSLATION_PROMPT_VERSION = 2;

function translationCacheKey(settings: ReaderSettings) {
  return JSON.stringify({
    version: 1,
    promptVersion: TRANSLATION_PROMPT_VERSION,
    provider: settings.provider,
    baseUrl: settings.baseUrl.trim().replace(/\/+$/, ""),
    model: settings.model.trim(),
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
  });
}

function loadSettings(): ReaderSettings {
  try {
    const saved = localStorage.getItem("parallel-pdf-settings");
    if (!saved) return initialSettings;
    const parsed = JSON.parse(saved) as Partial<ReaderSettings> & { settingsVersion?: number };
    const savedProvider = parsed.provider as string | undefined;
    if (savedProvider === "openrouter") {
      parsed.provider = "openai-compatible";
    } else if (savedProvider !== "omlx" && savedProvider !== "ollama" && savedProvider !== "openai-compatible") {
      parsed.provider = initialSettings.provider;
      parsed.baseUrl = initialSettings.baseUrl;
      parsed.model = initialSettings.model;
    }
    if (parsed.provider === "omlx" && parsed.baseUrl === "http://localhost:8000/v1") {
      parsed.baseUrl = providerDefaults.omlx;
    }
    if (!parsed.settingsVersion || parsed.settingsVersion < 2) {
      parsed.translationFontScale = initialSettings.translationFontScale;
    } else if (typeof parsed.translationFontScale !== "number" || !Number.isFinite(parsed.translationFontScale)) {
      parsed.translationFontScale = initialSettings.translationFontScale;
    }
    if (parsed.analysisMode !== "fast" && parsed.analysisMode !== "docling") {
      parsed.analysisMode = initialSettings.analysisMode;
    }
    if (parsed.layoutModel !== "heron" && parsed.layoutModel !== "egret-large" && parsed.layoutModel !== "egret-xlarge") {
      parsed.layoutModel = initialSettings.layoutModel;
    }
    if (parsed.renderMode !== "faithful" && parsed.renderMode !== "adaptive" && parsed.renderMode !== "bilingual") {
      parsed.renderMode = initialSettings.renderMode;
    }
    // adaptive / bilingual export is not wired up yet; pin older profiles to the
    // only mode that produces a valid PDF (see docs/render-execution-plan.md).
    if (!parsed.settingsVersion || parsed.settingsVersion < 8) {
      parsed.renderMode = "faithful";
    }
    if (typeof parsed.doclingPythonPath !== "string") parsed.doclingPythonPath = "";
    if (typeof parsed.doclingOcr !== "boolean") parsed.doclingOcr = initialSettings.doclingOcr;
    if (typeof parsed.cacheDocumentLimit !== "number" || !Number.isFinite(parsed.cacheDocumentLimit)) {
      parsed.cacheDocumentLimit = initialSettings.cacheDocumentLimit;
    }
    if (parsed.interfaceLanguage !== "system" && parsed.interfaceLanguage !== "zh-TW" && parsed.interfaceLanguage !== "en") {
      parsed.interfaceLanguage = initialSettings.interfaceLanguage;
    }
    parsed.cacheDocumentLimit = Math.max(1, Math.min(500, Math.round(parsed.cacheDocumentLimit)));
    parsed.translationFontScale = Math.max(0.8, Math.min(2, parsed.translationFontScale));
    return { ...initialSettings, ...parsed, apiKey: "" };
  } catch {
    return initialSettings;
  }
}

function App() {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [split, setSplit] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [syncScroll, setSyncScroll] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const interfaceLanguage = resolveInterfaceLanguage(settings.interfaceLanguage);
  const t = useMemo(() => createTranslator(interfaceLanguage), [interfaceLanguage]);
  const [models, setModels] = useState<string[]>([]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [cacheClearConfirming, setCacheClearConfirming] = useState(false);
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [translations, setTranslations] = useState<Record<number, TranslatedBlock[]>>({});
  const [translationStates, setTranslationStates] = useState<Record<number, PageTranslationState>>({});
  const [batchTranslation, setBatchTranslation] = useState<BatchTranslationState>({ running: false, completed: 0, total: 0 });
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ status: "idle", message: "" });
  const [enhancedLayouts, setEnhancedLayouts] = useState<Record<number, PdfPageLayout>>({});
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [showOutline, setShowOutline] = useState(false);
  const [cacheNotice, setCacheNotice] = useState("");
  const [draggingPdf, setDraggingPdf] = useState(false);
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>([]);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfBytesRef = useRef<Uint8Array | null>(null);
  const documentCacheIdRef = useRef("");
  const activeTranslationKeyRef = useRef(translationCacheKey(settings));
  const analysisRunRef = useRef(0);
  const activeAnalysisSettingsRef = useRef<AnalysisSettings>({
    analysisMode: settings.analysisMode,
    layoutModel: settings.layoutModel,
    doclingPythonPath: settings.doclingPythonPath.trim(),
    doclingOcr: settings.doclingOcr,
  });
  const sourceScrollRef = useRef<HTMLDivElement>(null);
  const translationScrollRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollLockRef = useRef(false);
  const unlockTimerRef = useRef<number | undefined>(undefined);
  const autoTranslateTimerRef = useRef<number | undefined>(undefined);
  const autoTranslatePageRef = useRef<(page: number) => void>(() => undefined);
  const openPdfPathRef = useRef<(path: string) => void>(() => undefined);
  const translationJobsRef = useRef<Record<number, number>>({});
  const translationJobSequenceRef = useRef(0);
  const batchJobRef = useRef(0);
  const batchActivePageRef = useRef<number | undefined>(undefined);
  const zoomRef = useRef(zoom);
  const gestureStartZoomRef = useRef(zoom);
  const zoomAnchorRef = useRef<{ page: number; ratio: number } | null>(null);

  useEffect(() => {
    return () => {
      loadingTaskRef.current?.destroy();
      analysisRunRef.current += 1;
      void invoke("cancel_docling_analysis");
      batchJobRef.current += 1;
      for (const translationId of Object.values(translationJobsRef.current)) {
        void invoke("cancel_translation", { translationId });
      }
      if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
      if (autoTranslateTimerRef.current) window.clearTimeout(autoTranslateTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!cacheNotice) return;
    const timer = window.setTimeout(() => setCacheNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [cacheNotice]);

  useEffect(() => {
    void invoke<RecentDocument[]>("list_recent_documents", { limit: 10 }).then(setRecentDocuments).catch(console.error);
  }, []);

  const runDoclingAnalysis = useCallback(async (
    nextDocument: PDFDocumentProxy,
    pdfBytes: Uint8Array,
    options: Pick<ReaderSettings, "doclingPythonPath" | "doclingOcr" | "layoutModel">,
    priorityPage: number,
  ) => {
    const run = ++analysisRunRef.current;
    const cacheDocumentId = documentCacheIdRef.current;
    const cacheAnalysisKey = analysisCacheKey({ analysisMode: "docling", doclingOcr: options.doclingOcr, layoutModel: options.layoutModel });
    await invoke("cancel_docling_analysis").catch(() => false);
    if (analysisRunRef.current !== run) return;
    setEnhancedLayouts({});
    setAnalysisState({ status: "loading", message: t("doclingPreparing"), pageCount: 0, totalPages: nextDocument.numPages });
    let workerCompleted = false;
    const unlisten = await listen<DoclingAnalysisBatchEvent>("docling-analysis-batch", (event) => {
      const payload = event.payload;
      if (workerCompleted || payload.analysisId !== run || analysisRunRef.current !== run) return;
      void buildDoclingLayouts(nextDocument, payload.analysis).then((layouts) => {
        if (workerCompleted || analysisRunRef.current !== run) return;
        setEnhancedLayouts((current) => ({ ...current, ...layouts }));
        if (cacheDocumentId) {
          void Promise.all(Object.entries(layouts).map(([pageNumber, layout]) => invoke("save_cached_layout", {
            request: {
              documentId: cacheDocumentId,
              analysisKey: cacheAnalysisKey,
              pageNumber: Number(pageNumber),
              layout,
            },
          }))).catch(console.error);
        }
        setAnalysisState({
          status: "loading",
          message: t("doclingBatchCompleted", { start: payload.batchStart, end: payload.batchEnd, completed: payload.completedPages, total: payload.totalPages }),
          pageCount: payload.completedPages,
          totalPages: payload.totalPages,
        });
      }).catch(console.error);
    }).catch((cause) => {
      setAnalysisState({
        status: "error",
        message: t("doclingListenFailed", { error: errorMessage(cause, t("unexpectedError")) }),
      });
      return null;
    });
    if (!unlisten) return;
    try {
      const analysis = await invoke<DocumentAnalysis>("analyze_pdf_with_docling", {
        analysisId: run,
        pdfBytes: Array.from(pdfBytes),
        pythonPath: options.doclingPythonPath.trim() || null,
        doOcr: options.doclingOcr,
        pageCount: nextDocument.numPages,
        priorityPage,
        layoutModel: options.layoutModel,
      });
      workerCompleted = true;
      const layouts = await buildDoclingLayouts(nextDocument, analysis);
      if (analysisRunRef.current !== run) return;
      setEnhancedLayouts(layouts);
      if (cacheDocumentId) {
        void Promise.all(Object.entries(layouts).map(([pageNumber, layout]) => invoke("save_cached_layout", {
          request: {
            documentId: cacheDocumentId,
            analysisKey: cacheAnalysisKey,
            pageNumber: Number(pageNumber),
            layout,
          },
        }))).catch(console.error);
      }
      setAnalysisState({
        status: "success",
        message: t("doclingResult", { version: analysis.analyzer.version, count: Object.keys(layouts).length }),
        pageCount: Object.keys(layouts).length,
        totalPages: nextDocument.numPages,
      });
    } catch (cause) {
      workerCompleted = true;
      if (analysisRunRef.current !== run) return;
      setEnhancedLayouts({});
      setAnalysisState({
        status: "error",
        message: t("doclingFailedFallback", { error: errorMessage(cause, t("unexpectedError")) }),
      });
    } finally {
      unlisten();
    }
  }, [t]);

  const loadPdf = async (sourceBytes: Uint8Array, nextFileName: string, filePath?: string) => {
    setLoading(true);
    setError("");
    setCacheNotice("");
    try {
      const data = sourceBytes.slice();
      await loadingTaskRef.current?.destroy();
      const loadingTask = getDocument({ data });
      loadingTaskRef.current = loadingTask;
      const nextDocument = await loadingTask.promise;
      pdfBytesRef.current = sourceBytes;
      let cachedLayouts: Record<number, PdfPageLayout> = {};
      let cachedTranslations: Record<number, TranslatedBlock[]> = {};
      try {
        const opened = await invoke<OpenedCachedDocument>("open_cached_document", {
          pdfBytes: Array.from(sourceBytes),
          fileName: nextFileName,
          filePath: filePath ?? "",
          pageCount: nextDocument.numPages,
          maxDocuments: settings.cacheDocumentLimit,
        });
        documentCacheIdRef.current = opened.documentId;
        const cached = await invoke<CachedDocumentData>("load_cached_document", {
          documentId: opened.documentId,
          analysisKey: analysisCacheKey(settings),
          translationKey: translationCacheKey(settings),
        });
        cachedLayouts = Object.fromEntries(cached.layouts.map((entry) => [entry.pageNumber, entry.layout]));
        cachedTranslations = Object.fromEntries(cached.translations.map((entry) => [entry.pageNumber, entry.blocks]));
      } catch (cacheError) {
        documentCacheIdRef.current = "";
        console.error("無法載入文件快取", cacheError);
      }
      setDocument(nextDocument);
      setFileName(nextFileName);
      setOutline([]);
      setOutlineLoading(true);
      setShowOutline(false);
      setCurrentPage(1);
      for (const translationId of Object.values(translationJobsRef.current)) {
        void invoke("cancel_translation", { translationId }).catch(console.error);
      }
      translationJobsRef.current = {};
      setTranslations(cachedTranslations);
      setTranslationStates(Object.fromEntries(
        Object.keys(cachedTranslations).map((page) => [Number(page), { status: "success" as const, restoredFromCache: true }]),
      ));
      const restoredTranslationCount = Object.keys(cachedTranslations).length;
      const restoredLayoutCount = Object.keys(cachedLayouts).length;
      setCacheNotice(restoredTranslationCount || restoredLayoutCount
        ? t("cacheRestored", { translations: restoredTranslationCount, layouts: restoredLayoutCount })
        : t("cacheMissing"));
      void nextDocument.getOutline()
        .then((items) => {
          if (loadingTaskRef.current === loadingTask) setOutline((items ?? []) as PdfOutlineItem[]);
        })
        .catch((cause) => {
          console.error("無法讀取 PDF 目錄", cause);
          if (loadingTaskRef.current === loadingTask) setOutline([]);
        })
        .finally(() => {
          if (loadingTaskRef.current === loadingTask) setOutlineLoading(false);
        });
      batchJobRef.current += 1;
      batchActivePageRef.current = undefined;
      setBatchTranslation({ running: false, completed: 0, total: 0 });
      analysisRunRef.current += 1;
      void invoke("cancel_docling_analysis");
      activeAnalysisSettingsRef.current = {
        analysisMode: settings.analysisMode,
        layoutModel: settings.layoutModel,
        doclingPythonPath: settings.doclingPythonPath.trim(),
        doclingOcr: settings.doclingOcr,
      };
      activeTranslationKeyRef.current = translationCacheKey(settings);
      setEnhancedLayouts(cachedLayouts);
      if (settings.analysisMode === "docling") {
        if (Object.keys(cachedLayouts).length === nextDocument.numPages) {
          setAnalysisState({
            status: "success",
            message: t("doclingCache", { count: nextDocument.numPages }),
            pageCount: nextDocument.numPages,
            totalPages: nextDocument.numPages,
          });
        } else {
          void runDoclingAnalysis(nextDocument, sourceBytes, settings, 1);
        }
      } else {
        setAnalysisState({
          status: "idle",
          message: Object.keys(cachedLayouts).length
            ? t("quickCache", { count: Object.keys(cachedLayouts).length })
            : t("fastAnalysis"),
        });
      }
      sourceScrollRef.current?.scrollTo({ top: 0 });
      translationScrollRef.current?.scrollTo({ top: 0 });
    } catch (cause) {
      console.error(cause);
      setError(t("invalidPdf"));
    } finally {
      setLoading(false);
    }
  };

  const openPdf = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await loadPdf(new Uint8Array(await file.arrayBuffer()), file.name);
    } finally {
      event.target.value = "";
    }
  };

  const openDroppedPdf = async (path: string) => {
    setDraggingPdf(false);
    setLoading(true);
    setError("");
    try {
      const dropped = await invoke<DroppedPdf>("read_dropped_pdf", { path });
      await loadPdf(new Uint8Array(dropped.pdfBytes), dropped.fileName, path);
    } catch (cause) {
      console.error(cause);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  openPdfPathRef.current = (path: string) => {
    void openDroppedPdf(path);
  };

  const openRecentDocument = async (doc: RecentDocument) => {
    if (!doc.filePath) return;
    setLoading(true);
    setError("");
    try {
      const dropped = await invoke<DroppedPdf>("read_dropped_pdf", { path: doc.filePath });
      await loadPdf(new Uint8Array(dropped.pdfBytes), dropped.fileName, doc.filePath);
    } catch (cause) {
      console.error(cause);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const closePdf = async () => {
    setDocument(null);
    setFileName("");
    setError("");
    setCacheNotice("");
    setDraggingPdf(false);
    setCurrentPage(1);
    setZoom(1);
    setOutline([]);
    setOutlineLoading(false);
    setShowOutline(false);
    setTranslations({});
    setTranslationStates({});
    setEnhancedLayouts({});
    setAnalysisState({ status: "idle", message: t("fastAnalysis") });
    setBatchTranslation({ running: false, completed: 0, total: 0 });
    batchJobRef.current += 1;
    batchActivePageRef.current = undefined;
    analysisRunRef.current += 1;
    for (const translationId of Object.values(translationJobsRef.current)) {
      void invoke("cancel_translation", { translationId }).catch(console.error);
    }
    translationJobsRef.current = {};
    if (autoTranslateTimerRef.current) window.clearTimeout(autoTranslateTimerRef.current);
    void invoke("cancel_docling_analysis").catch(console.error);
    const loadingTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    pdfBytesRef.current = null;
    documentCacheIdRef.current = "";
    await loadingTask?.destroy().catch(console.error);
    void invoke<RecentDocument[]>("list_recent_documents", { limit: 10 }).then(setRecentDocuments).catch(console.error);
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (document || loading) return;
      if (event.payload.type === "over") {
        setDraggingPdf(true);
      } else if (event.payload.type === "leave") {
        setDraggingPdf(false);
      } else if (event.payload.type === "drop") {
        setDraggingPdf(false);
        const pdfPath = event.payload.paths.find((path) => path.toLocaleLowerCase().endsWith(".pdf"));
        if (pdfPath) void openDroppedPdf(pdfPath);
        else setError(t("dropPdfOnly"));
      }
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
      setDraggingPdf(false);
    };
  }, [document, loading, settings]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const consumeOpenedPdf = async () => {
      const paths = await invoke<string[]>("take_opened_pdf_paths");
      const path = paths[paths.length - 1];
      if (path) openPdfPathRef.current(path);
    };
    void listen("opened-pdf", () => {
      void consumeOpenedPdf().catch(console.error);
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      void consumeOpenedPdf().catch(console.error);
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const findAnchor = (container: HTMLDivElement) => {
    const pages = Array.from(container.querySelectorAll<HTMLElement>("[data-page]"));
    if (!pages.length) return null;

    const containerRect = container.getBoundingClientRect();
    const focusY = containerRect.top + containerRect.height * 0.42;
    let selected = pages[0];

    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      if (focusY >= rect.top) selected = page;
      if (focusY >= rect.top && focusY <= rect.bottom) break;
    }

    const rect = selected.getBoundingClientRect();
    return {
      page: Number(selected.dataset.page ?? 1),
      ratio: Math.max(0, Math.min(1, (focusY - rect.top) / Math.max(rect.height, 1))),
    };
  };

  const scrollToAnchor = (container: HTMLDivElement, page: number, ratio: number) => {
    const target = container.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (!target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const nextTop = container.scrollTop + targetRect.top - containerRect.top + targetRect.height * ratio - containerRect.height * 0.42;
    container.scrollTop = Math.max(0, nextTop);
  };

  zoomRef.current = zoom;

  const captureZoomAnchor = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    const hoveredPane = element?.closest<HTMLDivElement>(".page-scroll");
    const anchor = hoveredPane ? findAnchor(hoveredPane) : null;
    zoomAnchorRef.current = anchor
      ?? (sourceScrollRef.current ? findAnchor(sourceScrollRef.current) : null)
      ?? (translationScrollRef.current ? findAnchor(translationScrollRef.current) : null);
  };

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !document) return;
      event.preventDefault();
      captureZoomAnchor(event.target);
      const factor = Math.exp(-event.deltaY * 0.01);
      setZoom((current) => Math.max(0.5, Math.min(2, current * factor)));
    };
    const onGestureStart = (event: Event) => {
      if (!document) return;
      event.preventDefault();
      gestureStartZoomRef.current = zoomRef.current;
      captureZoomAnchor(event.target);
    };
    const onGestureChange = (event: Event) => {
      if (!document) return;
      event.preventDefault();
      const gesture = event as WebKitGestureEvent;
      const scale = typeof gesture.scale === "number" ? gesture.scale : 1;
      setZoom(Math.max(0.5, Math.min(2, gestureStartZoomRef.current * scale)));
    };

    shell.addEventListener("wheel", onWheel, { passive: false });
    shell.addEventListener("gesturestart", onGestureStart, { passive: false });
    shell.addEventListener("gesturechange", onGestureChange, { passive: false });
    return () => {
      shell.removeEventListener("wheel", onWheel);
      shell.removeEventListener("gesturestart", onGestureStart);
      shell.removeEventListener("gesturechange", onGestureChange);
    };
  }, [document]);

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    const frame = requestAnimationFrame(() => {
      if (sourceScrollRef.current) scrollToAnchor(sourceScrollRef.current, anchor.page, anchor.ratio);
      if (translationScrollRef.current) scrollToAnchor(translationScrollRef.current, anchor.page, anchor.ratio);
    });
    return () => cancelAnimationFrame(frame);
  }, [zoom]);

  const syncFrom = useCallback((from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || scrollLockRef.current) return;
    const anchor = findAnchor(from);
    if (!anchor) return;

    setCurrentPage(anchor.page);
    if (!syncScroll) return;

    scrollLockRef.current = true;
    scrollToAnchor(to, anchor.page, anchor.ratio);
    if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = window.setTimeout(() => {
      scrollLockRef.current = false;
    }, 40);
  }, [syncScroll]);

  const jumpToPage = (page: number) => {
    if (!document) return;
    const safePage = Math.max(1, Math.min(document.numPages, page));
    setCurrentPage(safePage);
    for (const container of [sourceScrollRef.current, translationScrollRef.current]) {
      const target = container?.querySelector<HTMLElement>(`[data-page="${safePage}"]`);
      if (container && target) container.scrollTo({ top: target.offsetTop - 24, behavior: "smooth" });
    }
  };

  const jumpToAnchor = (page: number, ratio: number) => {
    if (!document) return;
    const safePage = Math.max(1, Math.min(document.numPages, page));
    const safeRatio = Math.max(0, Math.min(1, ratio));
    setCurrentPage(safePage);
    requestAnimationFrame(() => {
      if (sourceScrollRef.current) scrollToAnchor(sourceScrollRef.current, safePage, safeRatio);
      if (translationScrollRef.current) scrollToAnchor(translationScrollRef.current, safePage, safeRatio);
    });
  };

  const openOutlineDestination = async (item: PdfOutlineItem) => {
    if (!document) return;
    if (!item.dest) {
      if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const destination = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
      if (!destination?.length) throw new Error(t("outlineNoDestination"));
      const pageIndex = typeof destination[0] === "number"
        ? destination[0]
        : await document.getPageIndex(destination[0] as { num: number; gen: number });
      const pageNumber = pageIndex + 1;
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const destinationKind = (destination[1] as { name?: string } | undefined)?.name;
      let pdfTop: number | null = null;
      let pdfLeft = 0;
      if (destinationKind === "XYZ") {
        if (typeof destination[2] === "number") pdfLeft = destination[2];
        if (typeof destination[3] === "number") pdfTop = destination[3];
      } else if (destinationKind === "FitH" || destinationKind === "FitBH") {
        if (typeof destination[2] === "number") pdfTop = destination[2];
      } else if (destinationKind === "FitR") {
        if (typeof destination[2] === "number") pdfLeft = destination[2];
        if (typeof destination[5] === "number") pdfTop = destination[5];
      }
      const viewportTop = pdfTop === null ? 0 : viewport.convertToViewportPoint(pdfLeft, pdfTop)[1];
      jumpToAnchor(pageNumber, viewportTop / Math.max(1, viewport.height));
    } catch (cause) {
      setError(t("outlineNavigationFailed", { title: item.title, error: errorMessage(cause, t("unexpectedError")) }));
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      const percent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setSplit(Math.max(28, Math.min(72, percent)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const openSettings = () => {
    setConnectionMessage("");
    setCacheClearConfirming(false);
    setShowSettings(true);
  };

  const updateProvider = (provider: Provider) => {
    setSettings((current) => ({ ...current, provider, baseUrl: providerDefaults[provider], model: "", apiKey: "" }));
    setModels([]);
    setConnectionMessage("");
    setApiKeyDirty(false);
  };

  const providerConfig = () => ({
    providerId: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
  });

  const persistSettings = async () => {
    if (apiKeyDirty) {
      await invoke("save_api_key", { providerId: settings.provider, apiKey: settings.apiKey });
    }
    const { apiKey: _secret, ...safeSettings } = settings;
    localStorage.setItem("parallel-pdf-settings", JSON.stringify({ ...safeSettings, settingsVersion }));
    await invoke("set_document_cache_limit", { maxDocuments: settings.cacheDocumentLimit });
    setSettings((current) => ({ ...current, apiKey: "" }));
    setApiKeyDirty(false);
  };

  const clearDatabaseCache = async () => {
    setSettingsBusy(true);
    setConnectionMessage(t("clearingCache"));
    try {
      const cleared = await invoke<ClearedCache>("clear_document_cache");
      documentCacheIdRef.current = "";

      const currentBytes = pdfBytesRef.current;
      if (document && currentBytes) {
        try {
          const opened = await invoke<OpenedCachedDocument>("open_cached_document", {
            pdfBytes: Array.from(currentBytes),
            fileName,
            pageCount: document.numPages,
            maxDocuments: settings.cacheDocumentLimit,
          });
          documentCacheIdRef.current = opened.documentId;
        } catch (cause) {
          console.error("無法在清除後重新建立目前文件的快取索引", cause);
        }
      }

      setTranslationStates((current) => Object.fromEntries(
        Object.entries(current).map(([page, state]) => [page, { ...state, restoredFromCache: false }]),
      ));
      setCacheClearConfirming(false);
      setConnectionMessage(t("cacheCleared", cleared));
    } catch (cause) {
      setConnectionMessage(errorMessage(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const testProvider = async () => {
    setSettingsBusy(true);
    setConnectionMessage(t("connecting"));
    try {
      await persistSettings();
      const availableModels = await invoke<string[]>("list_models", { config: providerConfig() });
      setModels(availableModels);
      if (!settings.model && availableModels.length) {
        setSettings((current) => ({ ...current, model: availableModels[0] }));
      }
      setConnectionMessage(t("connectionSuccess", { count: availableModels.length }));
    } catch (cause) {
      setConnectionMessage(errorMessage(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const testDocling = async () => {
    setSettingsBusy(true);
    setConnectionMessage(t("checkingDocling"));
    try {
      const status = await invoke<DoclingStatus>("probe_docling", {
        pythonPath: settings.doclingPythonPath.trim() || null,
      });
      if (!status.available) {
        setConnectionMessage(
          t("doclingUnavailable", { version: status.pythonVersion, path: status.pythonExecutable ?? t("unknownPath"), error: status.error ?? t("unknownError") }),
        );
        return;
      }
      setConnectionMessage(
        t("doclingAvailable", { docling: status.doclingVersion ?? "–", python: status.pythonVersion, path: status.pythonExecutable ?? t("unknownPath") }),
      );
    } catch (cause) {
      setConnectionMessage(errorMessage(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const cancelDoclingAnalysis = async () => {
    analysisRunRef.current += 1;
    await invoke("cancel_docling_analysis").catch(() => false);
    const completed = Object.keys(enhancedLayouts).length;
    if (completed > 0) {
      setAnalysisState({
        status: "success",
        message: t("doclingStoppedPartial", { count: completed }),
        pageCount: completed,
        totalPages: document?.numPages,
      });
    } else {
      setEnhancedLayouts({});
      setAnalysisState({ status: "error", message: t("doclingStoppedFallback") });
    }
  };

  const saveSettings = async () => {
    setSettingsBusy(true);
    try {
      await persistSettings();
      const currentDocument = document;
      const currentBytes = pdfBytesRef.current;
      const nextAnalysisSettings: AnalysisSettings = {
        analysisMode: settings.analysisMode,
        layoutModel: settings.layoutModel,
        doclingPythonPath: settings.doclingPythonPath.trim(),
        doclingOcr: settings.doclingOcr,
      };
      const active = activeAnalysisSettingsRef.current;
      const analysisSettingsChanged = active.analysisMode !== nextAnalysisSettings.analysisMode
        || active.layoutModel !== nextAnalysisSettings.layoutModel
        || active.doclingPythonPath !== nextAnalysisSettings.doclingPythonPath
        || active.doclingOcr !== nextAnalysisSettings.doclingOcr;
      activeAnalysisSettingsRef.current = nextAnalysisSettings;
      const nextTranslationKey = translationCacheKey(settings);
      const translationSettingsChanged = activeTranslationKeyRef.current !== nextTranslationKey;
      activeTranslationKeyRef.current = nextTranslationKey;

      let cachedLayouts: Record<number, PdfPageLayout> = {};
      let cachedTranslations: Record<number, TranslatedBlock[]> = {};
      if (documentCacheIdRef.current && (analysisSettingsChanged || translationSettingsChanged)) {
        const cached = await invoke<CachedDocumentData>("load_cached_document", {
          documentId: documentCacheIdRef.current,
          analysisKey: analysisCacheKey(settings),
          translationKey: translationCacheKey(settings),
        });
        cachedLayouts = Object.fromEntries(cached.layouts.map((entry) => [entry.pageNumber, entry.layout]));
        cachedTranslations = Object.fromEntries(cached.translations.map((entry) => [entry.pageNumber, entry.blocks]));
      }
      if (analysisSettingsChanged || translationSettingsChanged) {
        translationJobsRef.current = {};
        batchJobRef.current += 1;
        batchActivePageRef.current = undefined;
        setTranslations(cachedTranslations);
        setTranslationStates(Object.fromEntries(
          Object.keys(cachedTranslations).map((page) => [Number(page), { status: "success" as const, restoredFromCache: true }]),
        ));
        setBatchTranslation({ running: false, completed: 0, total: 0 });
      }

      if (analysisSettingsChanged) {
        if (settings.analysisMode === "docling" && currentDocument && currentBytes) {
          if (Object.keys(cachedLayouts).length === currentDocument.numPages) {
            setEnhancedLayouts(cachedLayouts);
            setAnalysisState({
              status: "success",
              message: t("doclingCache", { count: currentDocument.numPages }),
              pageCount: currentDocument.numPages,
              totalPages: currentDocument.numPages,
            });
          } else {
            void runDoclingAnalysis(currentDocument, currentBytes, settings, currentPage);
          }
        } else if (settings.analysisMode === "fast") {
          analysisRunRef.current += 1;
          void invoke("cancel_docling_analysis");
          setEnhancedLayouts(cachedLayouts);
          setAnalysisState({
            status: "idle",
            message: Object.keys(cachedLayouts).length
              ? t("quickCache", { count: Object.keys(cachedLayouts).length })
              : t("fastAnalysis"),
          });
        }
      }
      setShowSettings(false);
    } catch (cause) {
      setConnectionMessage(errorMessage(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const clearApiKey = async () => {
    setSettingsBusy(true);
    try {
      await invoke("save_api_key", { providerId: settings.provider, apiKey: "" });
      setSettings((current) => ({ ...current, apiKey: "" }));
      setApiKeyDirty(false);
      setConnectionMessage(t("apiKeyRemoved"));
    } catch (cause) {
      setConnectionMessage(errorMessage(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const translatePage = async (page: number, job: number): Promise<"success" | "error" | "cancelled"> => {
    if (!document) return "cancelled";
    const cacheDocumentId = documentCacheIdRef.current;
    const cacheAnalysisKey = analysisCacheKey(settings);
    translationJobsRef.current[page] = job;
    setTranslationStates((current) => ({ ...current, [page]: { status: "loading" } }));

    let phase = t("analyzingPdf");
    try {
      const layout = enhancedLayouts[page] ?? await getPageLayout(document, page);
      if (!Array.isArray(layout.blocks)) throw new Error(t("invalidTextBlocks"));
      if (cacheDocumentId) {
        void invoke("save_cached_layout", {
          request: {
            documentId: cacheDocumentId,
            analysisKey: cacheAnalysisKey,
            pageNumber: page,
            layout,
          },
        }).catch(console.error);
      }
      phase = t("translatingLlm");
      const result = await invoke<TranslationResult>("translate_blocks", {
        translationId: job,
        request: {
          config: providerConfig(),
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage,
          blocks: layout.blocks.filter((block) => block.translatable).map(({ id, text }) => ({ id, text })),
        },
      });
      if (translationJobsRef.current[page] !== job) return "cancelled";
      const translatedBlocks = result.blocks.filter((block) => block.text.trim().length > 0);
      const missingIds = result.missingIds ?? [];
      setTranslations((current) => ({ ...current, [page]: translatedBlocks }));
      setTranslationStates((current) => ({
        ...current,
        [page]: missingIds.length > 0 ? { status: "partial", missingIds } : { status: "success" },
      }));
      if (cacheDocumentId) {
        void invoke("save_cached_translation", {
          request: {
            documentId: cacheDocumentId,
            analysisKey: cacheAnalysisKey,
            translationKey: translationCacheKey(settings),
            pageNumber: page,
            blocks: translatedBlocks,
          },
        }).catch(console.error);
      }
      return "success";
    } catch (cause) {
      if (translationJobsRef.current[page] !== job) return "cancelled";
      setTranslationStates((current) => ({ ...current, [page]: { status: "error", error: t("phaseFailed", { phase, error: errorMessage(cause, t("unexpectedError")) }) } }));
      return "error";
    }
  };

  const ensureTranslationModel = () => {
    if (settings.model.trim()) return true;
    setConnectionMessage(t("selectModelFirst"));
    setShowSettings(true);
    return false;
  };

  const analysisReadyForPage = (page: number) =>
    settings.analysisMode !== "docling"
    || analysisState.status !== "loading"
    || Boolean(enhancedLayouts[page]);

  const translateCurrentPage = async () => {
    if (!document || batchTranslation.running || !analysisReadyForPage(currentPage) || !ensureTranslationModel()) return;
    const job = ++translationJobSequenceRef.current;
    await translatePage(currentPage, job);
  };

  const cancelCurrentTranslation = () => {
    const activeJob = translationJobsRef.current[currentPage];
    if (activeJob !== undefined) void invoke("cancel_translation", { translationId: activeJob }).catch(console.error);
    translationJobsRef.current[currentPage] = ++translationJobSequenceRef.current;
    setTranslationStates((current) => ({ ...current, [currentPage]: { status: "idle" } }));
  };

  const translateAllPages = async () => {
    if (!document || batchTranslation.running || analysisState.status === "loading" || !ensureTranslationModel()) return;
    const everyPage = Array.from({ length: document.numPages }, (_, index) => index + 1);
    const missingPages = everyPage.filter((page) => !translations[page]);
    const queue = missingPages.length ? missingPages : everyPage;
    const batchJob = ++batchJobRef.current;
    setBatchTranslation({ running: true, completed: 0, total: queue.length, currentPage: queue[0] });

    for (let index = 0; index < queue.length; index += 1) {
      if (batchJobRef.current !== batchJob) return;
      const page = queue[index];
      batchActivePageRef.current = page;
      setBatchTranslation({ running: true, completed: index, total: queue.length, currentPage: page });
      const pageJob = ++translationJobSequenceRef.current;
      await translatePage(page, pageJob);
      if (batchJobRef.current !== batchJob) return;
      setBatchTranslation({ running: true, completed: index + 1, total: queue.length, currentPage: queue[index + 1] });
    }

    batchActivePageRef.current = undefined;
    setBatchTranslation({ running: false, completed: queue.length, total: queue.length });
  };

  const cancelBatchTranslation = () => {
    batchJobRef.current += 1;
    const activePage = batchActivePageRef.current;
    if (activePage !== undefined) {
      const activeJob = translationJobsRef.current[activePage];
      if (activeJob !== undefined) void invoke("cancel_translation", { translationId: activeJob }).catch(console.error);
      translationJobsRef.current[activePage] = ++translationJobSequenceRef.current;
      setTranslationStates((current) => ({ ...current, [activePage]: { status: translations[activePage] ? "success" : "idle" } }));
    }
    batchActivePageRef.current = undefined;
    setBatchTranslation((current) => ({ ...current, running: false, currentPage: undefined }));
  };

  const exportPdf = async (mode: RenderMode) => {
    if (!document || !pdfBytesRef.current) return;
    setExportingPdf(true);
    setShowExportDialog(false);
    try {
      const plan = buildRenderPlan(enhancedLayouts, translations, document.numPages, {
        mode,
        targetLanguage: settings.targetLanguage,
        fontScale: settings.translationFontScale * 0.5,
      });

      if (plan.pages.length === 0) {
        setError(t("noTranslationsToExport"));
        return;
      }

      const savedPath = await invoke<string>("render_translated_pdf", {
        request: {
          pdfBytes: Array.from(pdfBytesRef.current),
          plan,
          fileName: fileName.replace(/\.pdf$/i, "") + `-translated-${mode}.pdf`,
        },
      });

      setCacheNotice(t("exportSaved", { path: savedPath }));
    } catch (cause) {
      setError(errorMessage(cause, t("exportFailed")));
    } finally {
      setExportingPdf(false);
    }
  };

  autoTranslatePageRef.current = (page: number) => {
    const state = translationStates[page]?.status;
    if (!document
      || !settings.model.trim()
      || batchTranslation.running
      || !analysisReadyForPage(page)
      || translations[page]
      || state === "loading"
      || state === "success"
      || state === "partial"
      || state === "error") return;

    const anotherPageIsLoading = Object.entries(translationStates).some(([pageNumber, pageState]) =>
      Number(pageNumber) !== page && pageState.status === "loading",
    );
    if (anotherPageIsLoading) {
      autoTranslateTimerRef.current = window.setTimeout(() => autoTranslatePageRef.current(page), 1000);
      return;
    }

    const job = ++translationJobSequenceRef.current;
    void translatePage(page, job);
  };

  const scheduleAutoTranslation = (container: HTMLDivElement) => {
    if (autoTranslateTimerRef.current) window.clearTimeout(autoTranslateTimerRef.current);
    autoTranslateTimerRef.current = window.setTimeout(() => {
      const anchor = findAnchor(container);
      if (anchor) autoTranslatePageRef.current(anchor.page);
    }, 1000);
  };

  const cacheResolvedLayout = useCallback((pageNumber: number, layout: PdfPageLayout) => {
    // Keep the in-memory layout map populated so consumers that read it (PDF
    // export) work on the very first open, before any SQLite cache exists.
    // Never overwrite an existing entry: a Docling batch result for the same
    // page must win over this PDF.js fallback.
    setEnhancedLayouts((current) => (current[pageNumber] ? current : { ...current, [pageNumber]: layout }));

    const documentId = documentCacheIdRef.current;
    if (!documentId) return;
    void invoke("save_cached_layout", {
      request: {
        documentId,
        analysisKey: analysisCacheKey(settings),
        pageNumber,
        layout,
      },
    }).catch(console.error);
  }, [settings.analysisMode, settings.doclingOcr]);

  const handleReaderScroll = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    syncFrom(from, to);
    scheduleAutoTranslation(from);
  };

  useEffect(() => {
    if (!document) return;
    if (autoTranslateTimerRef.current) window.clearTimeout(autoTranslateTimerRef.current);
    autoTranslateTimerRef.current = window.setTimeout(() => autoTranslatePageRef.current(currentPage), 1000);
    return () => {
      if (autoTranslateTimerRef.current) window.clearTimeout(autoTranslateTimerRef.current);
    };
  }, [document, currentPage, enhancedLayouts]);

  const pageNumbers = document ? Array.from({ length: document.numPages }, (_, index) => index + 1) : [];
  const currentTranslationStatus = translationStates[currentPage]?.status;
  const sourceLanguageLabel = settings.sourceLanguage === "auto" ? t("autoDetect") : settings.sourceLanguage;
  const translatedPageCount = pageNumbers.filter((page) => Boolean(translations[page])).length;
  const allPagesTranslated = document !== null && translatedPageCount === document.numPages;
  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const command = event.detail >= 2 ? "toggle_window_maximize" : "start_window_drag";
    void invoke(command).catch((cause) => {
      console.error(cause);
      setError(errorMessage(cause));
    });
  };

  return (
    <main className="app-shell">
      <header className="titlebar" onMouseDown={startWindowDrag}>
        <div className="brand">
          <span className="brand-mark">文</span>
          <span>LingoPane</span>
        </div>
        <div className="document-heading">
          <span className="document-title">{fileName || t("noDocument")}</span>
          {document && (
            <button
              className="titlebar-document-close"
              aria-label={t("closePdf")}
              title={t("closePdf")}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={closePdf}
            ><span aria-hidden="true">×</span>{t("close")}</button>
          )}
        </div>
      </header>

      <section className="toolbar" aria-label={t("pdfToolbar")}>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={openPdf} />
        <div className="toolbar-group document-tools">
          <button className={document ? "toolbar-button" : "primary-button"} onClick={() => fileInputRef.current?.click()}>{t(loading ? "loading" : "openPdf")}</button>
          <button
            className={`toolbar-button outline-button ${showOutline ? "is-active" : ""}`}
            disabled={!document}
            onClick={() => setShowOutline((current) => !current)}
            aria-expanded={showOutline}
            aria-controls="pdf-outline"
            title={t("outline")}
          ><span aria-hidden="true">▤</span><span className="toolbar-button-label">{t("outline")}</span></button>
          {document && (
            <span
              className={`analysis-state is-${analysisState.status}`}
              title={analysisState.message || t("fastAnalysis")}
            >
              {analysisState.status === "loading" ? `Docling ${analysisState.pageCount ?? 0}/${analysisState.totalPages ?? document.numPages}` :
                analysisState.status === "success" ? "Docling ✓" :
                analysisState.status === "error" ? "PDF.js" : "PDF.js"}
            </span>
          )}
        </div>
        <span className="toolbar-divider" />
        <div className="toolbar-group page-navigation">
          <button className="icon-button" disabled={!document || currentPage <= 1} onClick={() => jumpToPage(currentPage - 1)} aria-label={t("previousPage")}>‹</button>
          <label className="page-control">
            <input
              type="number"
              min={1}
              max={document?.numPages ?? 1}
              value={currentPage}
              disabled={!document}
              onChange={(event) => jumpToPage(Number(event.target.value))}
            />
            <span>/ {document?.numPages ?? 0}</span>
          </label>
          <button className="icon-button" disabled={!document || currentPage >= (document?.numPages ?? 0)} onClick={() => jumpToPage(currentPage + 1)} aria-label={t("nextPage")}>›</button>
        </div>
        <span className="toolbar-divider" />
        <div className="toolbar-group zoom-controls">
          <button className="icon-button" disabled={!document || zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>−</button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button className="icon-button" disabled={!document || zoom >= 2} onClick={() => setZoom((value) => Math.min(2, value + 0.1))}>＋</button>
        </div>
        <span className="toolbar-spacer" />
        {document && (
          <>
            <div className="translation-tools">
              <span className={`translation-state-dot is-${batchTranslation.running ? "loading" : currentTranslationStatus ?? "idle"}`} aria-hidden="true" />
              <span className="translation-summary" title={`${settings.provider} · ${settings.model || t("noModel")} · ${sourceLanguageLabel} → ${settings.targetLanguage}`}>
                {sourceLanguageLabel} <span>→</span> {settings.targetLanguage}
              </span>
              {batchTranslation.running ? (
                <>
                  <span className="batch-progress">{t("pageProgress", { page: batchTranslation.currentPage ?? "–", completed: batchTranslation.completed, total: batchTranslation.total })}</span>
                  <button className="translate-button cancel" onClick={cancelBatchTranslation}>{t("stopAll")}</button>
                </>
              ) : (
                <>
                  {currentTranslationStatus === "loading" ? (
                    <button className="translate-button cancel" onClick={cancelCurrentTranslation}>{t("cancelTranslation")}</button>
                  ) : (
                    <button className="translate-button" disabled={!analysisReadyForPage(currentPage)} onClick={translateCurrentPage}>{t(translations[currentPage] ? "retranslate" : "translateCurrent")}</button>
                  )}
                  <details className="translation-menu">
                    <summary aria-label={t("translateAll")} title={t("translateAll")}>⌄</summary>
                    <div className="translation-menu-popover">
                      <button
                        disabled={analysisState.status === "loading"}
                        onClick={(event) => {
                          event.currentTarget.closest("details")?.removeAttribute("open");
                          void translateAllPages();
                        }}
                      >{t(allPagesTranslated ? "retranslateAll" : "translateAll")}</button>
                    </div>
                  </details>
                </>
              )}
            </div>
            <span className="toolbar-divider" />
            <button
              className="toolbar-button"
              disabled={!document || exportingPdf || Object.keys(translations).length === 0}
              onClick={() => setShowExportDialog(true)}
              title={t("exportPdf")}
            >{exportingPdf ? t("exportingPdf") : t("exportPdf")}</button>
            <span className="toolbar-divider" />
          </>
        )}
        <label className={`sync-control ${syncScroll ? "is-active" : ""}`} title={t("syncPosition")}>
          <input type="checkbox" checked={syncScroll} onChange={(event) => setSyncScroll(event.target.checked)} />
          <span className="sync-icon" aria-hidden="true">⇄</span>
          <span className="sync-label">{t("syncScroll")}</span>
        </label>
        <span className="toolbar-divider settings-divider" />
        <button className="toolbar-settings-button" onClick={openSettings} aria-label={t("settings")} title={t("settings")}>⚙︎</button>
      </section>

      {error && <div className="error-banner">{error}</div>}
      {document && cacheNotice && <div className="cache-notice" role="status">{cacheNotice}</div>}

      <section ref={shellRef} className="reader-shell">
        {!document ? (
          <div className={`empty-state ${draggingPdf ? "is-dragging" : ""}`} aria-live="polite">
            <div className="empty-icon">PDF</div>
            <h1>{t(draggingPdf ? "dropOpen" : "emptyTitle")}</h1>
            <p>{t(draggingPdf ? "localProcessing" : "emptyHint")}</p>
            <button className="primary-button large" onClick={() => fileInputRef.current?.click()}>{t("choosePdf")}</button>
            <span>{t(loading ? "readingPdf" : "privacyHint")}</span>
            {recentDocuments.length > 0 && (
              <div className="recent-documents">
                <h2>{t("recentDocuments")}</h2>
                <ul>
                  {recentDocuments.map((doc) => (
                    <li key={doc.documentId}>
                      <button
                        className="recent-document-item"
                        onClick={() => openRecentDocument(doc)}
                        disabled={!doc.filePath}
                        title={doc.filePath || doc.fileName}
                      >
                        <span className="recent-document-name">{doc.fileName}</span>
                        <span className="recent-document-meta">{t("pagesCount", { count: doc.pageCount })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <>
            {showOutline && (
              <div id="pdf-outline">
                <OutlineSidebar items={outline} loading={outlineLoading} onClose={() => setShowOutline(false)} onSelect={openOutlineDestination} t={t} />
              </div>
            )}
            <section className="reader-pane" aria-label={t("sourceDocument", { name: fileName })} style={{ width: `${split}%` }}>
              <div ref={sourceScrollRef} className="page-scroll" onScroll={(event) => handleReaderScroll(event.currentTarget, translationScrollRef.current)}>
                <div className="page-stack">
                  {pageNumbers.map((page) => <PdfPage key={page} document={document} pageNumber={page} scale={zoom} t={t} />)}
                </div>
              </div>
            </section>

            <div className="splitter" role="separator" aria-orientation="vertical" aria-label={t("resizePanes")} onPointerDown={startResize}>
              <span />
            </div>

            <section className="reader-pane" aria-label={t("translationPane", { source: sourceLanguageLabel, target: settings.targetLanguage })} style={{ width: `${100 - split}%` }}>
              <div ref={translationScrollRef} className="page-scroll" onScroll={(event) => handleReaderScroll(event.currentTarget, sourceScrollRef.current)}>
                <div className="page-stack">
                  {pageNumbers.map((page) => (
                    <TranslationPage
                      key={page}
                      document={document}
                      pageNumber={page}
                      scale={zoom}
                      layoutOverride={enhancedLayouts[page]}
                      translationFontScale={settings.translationFontScale}
                      translationLineHeightScale={settings.targetLanguage === "zh-TW" ? 1.2 : 1}
                      translations={translations[page]}
                      status={translationStates[page]?.status}
                      error={translationStates[page]?.error}
                      onLayoutResolved={cacheResolvedLayout}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            </section>
          </>
        )}
      </section>

      {showSettings && (
        <div className="modal-backdrop" onMouseDown={() => setShowSettings(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-title">
              <div>
                <span id="settings-title">{t("settingsTitle")}</span>
                <small>{t("settingsSubtitle")}</small>
              </div>
              <button className="icon-button" onClick={() => setShowSettings(false)} aria-label={t("close")}>×</button>
            </div>

            <div className="settings-grid">
              <div className="settings-section-title">{t("interfaceSection")}</div>
              <label>{t("interfaceLanguage")}
                <select value={settings.interfaceLanguage} onChange={(event) => setSettings({ ...settings, interfaceLanguage: event.target.value as InterfaceLanguage })}>
                  <option value="system">{t("followSystem")}</option>
                  <option value="zh-TW">{t("traditionalChinese")}</option>
                  <option value="en">{t("english")}</option>
                </select>
              </label>

              <div className="settings-section-title">{t("analysisSection")}</div>
              <label>{t("analysisEngine")}
                <select value={settings.analysisMode} onChange={(event) => setSettings({ ...settings, analysisMode: event.target.value as AnalysisMode })}>
                  <option value="fast">{t("fastPdfjs")}</option>
                  <option value="docling">{t("doclingEnhanced")}</option>
                </select>
              </label>
              {settings.analysisMode === "docling" && (
                <>
                  <div className="python-status">
                    <span className="python-status-label">{t("pythonEnvironment")}</span>
                    <span className="python-status-value">{t("doclingRuntimeAuto")}</span>
                  </div>
                  <label className="checkbox-setting">
                    <input type="checkbox" checked={settings.doclingOcr} onChange={(event) => setSettings({ ...settings, doclingOcr: event.target.checked })} />
                    <span>{t("enableOcr")}</span>
                  </label>
                  <label>{t("layoutModel")}
                    <select value={settings.layoutModel} onChange={(event) => setSettings({ ...settings, layoutModel: event.target.value as ReaderSettings["layoutModel"] })}>
                      <option value="heron">{t("layoutModelHeron")}</option>
                      <option value="egret-large">{t("layoutModelEgretLarge")}</option>
                      <option value="egret-xlarge">{t("layoutModelEgretXLarge")}</option>
                    </select>
                    <small className="field-help">{t("layoutModelHelp")}</small>
                  </label>
                  <div className="runtime-explanation">{t("doclingExplanation")}</div>
                </>
              )}
              {analysisState.status === "loading"
                ? <button className="secondary-button settings-test-button" onClick={cancelDoclingAnalysis}>{t("stopDocling")}</button>
                : settings.analysisMode === "docling" && <button className="secondary-button settings-test-button" onClick={testDocling} disabled={settingsBusy}>{t(settingsBusy ? "checking" : "testDocling")}</button>}

              <div className="settings-section-title">{t("dataSection")}</div>
              <label>{t("cacheLimit")}
                <input
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={settings.cacheDocumentLimit}
                  onChange={(event) => setSettings({
                    ...settings,
                    cacheDocumentLimit: Math.max(1, Math.min(500, Math.round(Number(event.target.value) || 30))),
                  })}
                />
                <small className="field-help">{t("cacheHelp")}</small>
              </label>
              <div className="cache-management">
                <div className="cache-management-copy">
                  <strong>{t("databaseCache")}</strong>
                  <small>{t("databaseCacheHelp")}</small>
                </div>
                {!cacheClearConfirming ? (
                  <button className="danger-outline-button" onClick={() => setCacheClearConfirming(true)} disabled={settingsBusy}>
                    {t("clearDatabaseCache")}
                  </button>
                ) : (
                  <div className="cache-clear-confirmation" role="alert">
                    <p>{t("clearCacheConfirm")}</p>
                    <div>
                      <button className="secondary-button" onClick={() => setCacheClearConfirming(false)} disabled={settingsBusy}>{t("cancelClearCache")}</button>
                      <button className="danger-button" onClick={clearDatabaseCache} disabled={settingsBusy}>{t("confirmClearCache")}</button>
                    </div>
                  </div>
                )}
              </div>

              <div className="settings-section-title">{t("translationSection")}</div>
              <label>{t("serviceType")}
                <select value={settings.provider} onChange={(event) => updateProvider(event.target.value as Provider)}>
                  <option value="omlx">oMLX ({t("local")})</option>
                  <option value="ollama">Ollama ({t("local")})</option>
                  <option value="openai-compatible">{t("openAiCompatible")}</option>
                </select>
              </label>
              <label>Base URL<input value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>
              <label>API Key
                <div className="secret-field">
                  <input
                    type="password"
                    placeholder={t(settings.provider === "openai-compatible" ? "apiKeyPlaceholderRemote" : "apiKeyPlaceholderLocal")}
                    value={settings.apiKey}
                    onChange={(event) => { setSettings({ ...settings, apiKey: event.target.value }); setApiKeyDirty(true); }}
                  />
                  <button type="button" onClick={clearApiKey} disabled={settingsBusy}>{t("clear")}</button>
                </div>
              </label>
              <button className="secondary-button settings-test-button" onClick={testProvider} disabled={settingsBusy}>{t(settingsBusy ? "processing" : "testConnection")}</button>
              {models.length > 0 && (
                <label>{t("detectedModels")}
                  <select value={models.includes(settings.model) ? settings.model : ""} onChange={(event) => setSettings({ ...settings, model: event.target.value })}>
                    <option value="" disabled>{t("selectModel")}</option>
                    {models.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
              )}
              <label>{t("modelName")}
                <input placeholder={t("modelPlaceholder")} value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
              </label>
              <div className="language-row">
                <label>{t("sourceLanguage")}<select value={settings.sourceLanguage} onChange={(event) => setSettings({ ...settings, sourceLanguage: event.target.value })}><option value="auto">{t("autoDetect")}</option><option value="en">English</option><option value="ja">{t("japanese")}</option><option value="zh-TW">{t("traditionalChinese")}</option></select></label>
                <span>→</span>
                <label>{t("targetLanguage")}<select value={settings.targetLanguage} onChange={(event) => setSettings({ ...settings, targetLanguage: event.target.value })}><option value="zh-TW">{t("traditionalChinese")}</option><option value="en">English</option><option value="ja">{t("japanese")}</option></select></label>
              </div>
              <label>{t("translationFontScale")}
                <input
                  type="number"
                  min="0.8"
                  max="2"
                  step="0.1"
                  value={settings.translationFontScale}
                  onChange={(event) => setSettings({ ...settings, translationFontScale: Math.max(0.8, Math.min(2, Number(event.target.value) || 1.8)) })}
                />
              </label>
              <label>{t("renderMode")}
                <select value={settings.renderMode} onChange={(event) => setSettings({ ...settings, renderMode: event.target.value as RenderMode })}>
                  <option value="faithful">{t("renderFaithful")}</option>
                  <option value="adaptive">{t("renderAdaptive")}</option>
                  <option value="bilingual">{t("renderBilingual")}</option>
                </select>
                <small className="field-help">{t("renderModeHelp")}</small>
              </label>
            </div>

            <div className={`settings-note ${connectionMessage ? "has-status" : ""}`}>
              {connectionMessage || t("unifiedPrivacy")}
            </div>
            <div className="modal-actions">
              <button className="primary-button" onClick={saveSettings} disabled={settingsBusy}>{t("saveSettings")}</button>
            </div>
          </section>
        </div>
      )}
      {showExportDialog && (
        <ExportDialog
          renderMode={settings.renderMode}
          onModeChange={(nextMode) => setSettings((current) => ({ ...current, renderMode: nextMode }))}
          onExport={() => exportPdf(settings.renderMode)}
          onCancel={() => setShowExportDialog(false)}
          exporting={exportingPdf}
          hasTranslations={Object.keys(translations).length > 0}
          t={t}
        />
      )}
    </main>
  );
}

export default App;
