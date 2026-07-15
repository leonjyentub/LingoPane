import { ChangeEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PdfPage } from "./components/PdfPage";
import { TranslationPage, type TranslatedBlock, type TranslationStatus } from "./components/TranslationPage";
import { buildDoclingLayouts, type AnalysisMode, type DoclingStatus, type DocumentAnalysis } from "./lib/docling";
import { getPageLayout } from "./lib/pdfLayout";
import type { PdfPageLayout } from "./lib/pdfLayout";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerUrl;

type Provider = "omlx" | "ollama" | "openai-compatible";
type SettingsPage = "analysis" | "translation";

type ReaderSettings = {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  translationFontScale: number;
  analysisMode: AnalysisMode;
  doclingPythonPath: string;
  doclingOcr: boolean;
};

const providerDefaults: Record<Provider, string> = {
  omlx: "http://127.0.0.1:8000/v1",
  ollama: "http://localhost:11434/v1",
  "openai-compatible": "https://api.openai.com/v1",
};

const settingsVersion = 3;

const initialSettings: ReaderSettings = {
  provider: "omlx",
  baseUrl: providerDefaults.omlx,
  apiKey: "",
  model: "",
  sourceLanguage: "auto",
  targetLanguage: "zh-TW",
  translationFontScale: 1.8,
  analysisMode: "fast",
  doclingPythonPath: "",
  doclingOcr: false,
};

type TranslationResult = {
  blocks: TranslatedBlock[];
  model: string;
};

type PageTranslationState = {
  status: TranslationStatus;
  error?: string;
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

type AnalysisSettings = Pick<ReaderSettings, "analysisMode" | "doclingPythonPath" | "doclingOcr">;

type WebKitGestureEvent = Event & {
  scale?: number;
};

function errorMessage(cause: unknown) {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return "發生未預期的錯誤";
}

function loadSettings(): ReaderSettings {
  try {
    const saved = localStorage.getItem("parallel-pdf-settings");
    if (!saved) return initialSettings;
    const parsed = JSON.parse(saved) as Partial<ReaderSettings> & { settingsVersion?: number };
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
    if (typeof parsed.doclingPythonPath !== "string") parsed.doclingPythonPath = "";
    if (typeof parsed.doclingOcr !== "boolean") parsed.doclingOcr = initialSettings.doclingOcr;
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
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("translation");
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [models, setModels] = useState<string[]>([]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [translations, setTranslations] = useState<Record<number, TranslatedBlock[]>>({});
  const [translationStates, setTranslationStates] = useState<Record<number, PageTranslationState>>({});
  const [batchTranslation, setBatchTranslation] = useState<BatchTranslationState>({ running: false, completed: 0, total: 0 });
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ status: "idle", message: "快速版面分析" });
  const [enhancedLayouts, setEnhancedLayouts] = useState<Record<number, PdfPageLayout>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfBytesRef = useRef<Uint8Array | null>(null);
  const analysisRunRef = useRef(0);
  const activeAnalysisSettingsRef = useRef<AnalysisSettings>({
    analysisMode: settings.analysisMode,
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
      if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
      if (autoTranslateTimerRef.current) window.clearTimeout(autoTranslateTimerRef.current);
    };
  }, []);

  const runDoclingAnalysis = useCallback(async (
    nextDocument: PDFDocumentProxy,
    pdfBytes: Uint8Array,
    options: Pick<ReaderSettings, "doclingPythonPath" | "doclingOcr">,
    priorityPage: number,
  ) => {
    const run = ++analysisRunRef.current;
    await invoke("cancel_docling_analysis").catch(() => false);
    if (analysisRunRef.current !== run) return;
    setEnhancedLayouts({});
    setAnalysisState({ status: "loading", message: "Docling 正在準備目前頁批次…", pageCount: 0, totalPages: nextDocument.numPages });
    let workerCompleted = false;
    const unlisten = await listen<DoclingAnalysisBatchEvent>("docling-analysis-batch", (event) => {
      const payload = event.payload;
      if (workerCompleted || payload.analysisId !== run || analysisRunRef.current !== run) return;
      void buildDoclingLayouts(nextDocument, payload.analysis).then((layouts) => {
        if (workerCompleted || analysisRunRef.current !== run) return;
        setEnhancedLayouts((current) => ({ ...current, ...layouts }));
        setAnalysisState({
          status: "loading",
          message: `Docling 已完成第 ${payload.batchStart}–${payload.batchEnd} 頁 · ${payload.completedPages}/${payload.totalPages}`,
          pageCount: payload.completedPages,
          totalPages: payload.totalPages,
        });
      }).catch(console.error);
    }).catch((cause) => {
      setAnalysisState({
        status: "error",
        message: `無法監聽 Docling 批次結果，已改用快速分析：${errorMessage(cause)}`,
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
      });
      workerCompleted = true;
      const layouts = await buildDoclingLayouts(nextDocument, analysis);
      if (analysisRunRef.current !== run) return;
      setEnhancedLayouts(layouts);
      setAnalysisState({
        status: "success",
        message: `Docling ${analysis.analyzer.version} · ${Object.keys(layouts).length} 頁`,
        pageCount: Object.keys(layouts).length,
        totalPages: nextDocument.numPages,
      });
    } catch (cause) {
      workerCompleted = true;
      if (analysisRunRef.current !== run) return;
      setEnhancedLayouts({});
      setAnalysisState({
        status: "error",
        message: `Docling 無法使用，已改用快速分析：${errorMessage(cause)}`,
      });
    } finally {
      unlisten();
    }
  }, []);

  const openPdf = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError("");
    try {
      const sourceBytes = new Uint8Array(await file.arrayBuffer());
      const data = sourceBytes.slice();
      await loadingTaskRef.current?.destroy();
      const loadingTask = getDocument({ data });
      loadingTaskRef.current = loadingTask;
      const nextDocument = await loadingTask.promise;
      pdfBytesRef.current = sourceBytes;
      setDocument(nextDocument);
      setFileName(file.name);
      setCurrentPage(1);
      translationJobsRef.current = {};
      setTranslations({});
      setTranslationStates({});
      batchJobRef.current += 1;
      batchActivePageRef.current = undefined;
      setBatchTranslation({ running: false, completed: 0, total: 0 });
      analysisRunRef.current += 1;
      void invoke("cancel_docling_analysis");
      activeAnalysisSettingsRef.current = {
        analysisMode: settings.analysisMode,
        doclingPythonPath: settings.doclingPythonPath.trim(),
        doclingOcr: settings.doclingOcr,
      };
      setEnhancedLayouts({});
      if (settings.analysisMode === "docling") {
        void runDoclingAnalysis(nextDocument, sourceBytes, settings, 1);
      } else {
        setAnalysisState({ status: "idle", message: "快速版面分析" });
      }
      sourceScrollRef.current?.scrollTo({ top: 0 });
      translationScrollRef.current?.scrollTo({ top: 0 });
    } catch (cause) {
      console.error(cause);
      setError("無法讀取這份 PDF，請確認檔案未加密或損毀。");
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  };

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

  const openSettings = (page: SettingsPage) => {
    setSettingsPage(page);
    setConnectionMessage("");
    setShowSettings(true);
  };

  const switchSettingsPage = (page: SettingsPage) => {
    setSettingsPage(page);
    setConnectionMessage("");
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
    setSettings((current) => ({ ...current, apiKey: "" }));
    setApiKeyDirty(false);
  };

  const testProvider = async () => {
    setSettingsBusy(true);
    setConnectionMessage("正在連線…");
    try {
      await persistSettings();
      const availableModels = await invoke<string[]>("list_models", { config: providerConfig() });
      setModels(availableModels);
      if (!settings.model && availableModels.length) {
        setSettings((current) => ({ ...current, model: availableModels[0] }));
      }
      setConnectionMessage(`連線成功，共找到 ${availableModels.length} 個模型`);
    } catch (cause) {
      setConnectionMessage(errorMessage(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const testDocling = async () => {
    setSettingsBusy(true);
    setConnectionMessage("正在檢查 Docling Python runtime…");
    try {
      const status = await invoke<DoclingStatus>("probe_docling", {
        pythonPath: settings.doclingPythonPath.trim() || null,
      });
      if (!status.available) {
        setConnectionMessage(
          `Python ${status.pythonVersion}（${status.pythonExecutable ?? "未知路徑"}）可執行，但 Docling 尚不可用：${status.error ?? "未知錯誤"}`,
        );
        return;
      }
      setConnectionMessage(
        `Docling ${status.doclingVersion} 可用 · Python ${status.pythonVersion} · ${status.pythonExecutable}`,
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
        message: `Docling 分析已停止，保留 ${completed} 頁結果；其餘頁面使用 PDF.js`,
        pageCount: completed,
        totalPages: document?.numPages,
      });
    } else {
      setEnhancedLayouts({});
      setAnalysisState({ status: "error", message: "Docling 分析已停止，改用 PDF.js 快速分析" });
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
        doclingPythonPath: settings.doclingPythonPath.trim(),
        doclingOcr: settings.doclingOcr,
      };
      const active = activeAnalysisSettingsRef.current;
      const analysisSettingsChanged = active.analysisMode !== nextAnalysisSettings.analysisMode
        || active.doclingPythonPath !== nextAnalysisSettings.doclingPythonPath
        || active.doclingOcr !== nextAnalysisSettings.doclingOcr;
      activeAnalysisSettingsRef.current = nextAnalysisSettings;

      if (analysisSettingsChanged) {
        translationJobsRef.current = {};
        batchJobRef.current += 1;
        batchActivePageRef.current = undefined;
        setTranslations({});
        setTranslationStates({});
        setBatchTranslation({ running: false, completed: 0, total: 0 });
        if (settings.analysisMode === "docling" && currentDocument && currentBytes) {
          void runDoclingAnalysis(currentDocument, currentBytes, settings, currentPage);
        } else if (settings.analysisMode === "fast") {
          analysisRunRef.current += 1;
          void invoke("cancel_docling_analysis");
          setEnhancedLayouts({});
          setAnalysisState({ status: "idle", message: "快速版面分析" });
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
      setConnectionMessage("已從 macOS Keychain 移除 API Key");
    } catch (cause) {
      setConnectionMessage(errorMessage(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const translatePage = async (page: number, job: number): Promise<"success" | "error" | "cancelled"> => {
    if (!document) return "cancelled";
    translationJobsRef.current[page] = job;
    setTranslationStates((current) => ({ ...current, [page]: { status: "loading" } }));

    let phase = "分析 PDF 文字";
    try {
      const layout = enhancedLayouts[page] ?? await getPageLayout(document, page);
      if (!Array.isArray(layout.blocks)) throw new Error("PDF 文字區塊不是有效陣列");
      phase = "呼叫 LLM 翻譯";
      const result = await invoke<TranslationResult>("translate_blocks", {
        request: {
          config: providerConfig(),
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage,
          blocks: layout.blocks.filter((block) => block.translatable).map(({ id, text }) => ({ id, text })),
        },
      });
      if (translationJobsRef.current[page] !== job) return "cancelled";
      setTranslations((current) => ({ ...current, [page]: result.blocks }));
      setTranslationStates((current) => ({ ...current, [page]: { status: "success" } }));
      return "success";
    } catch (cause) {
      if (translationJobsRef.current[page] !== job) return "cancelled";
      setTranslationStates((current) => ({ ...current, [page]: { status: "error", error: `${phase}失敗：${errorMessage(cause)}` } }));
      return "error";
    }
  };

  const ensureTranslationModel = () => {
    if (settings.model.trim()) return true;
    setConnectionMessage("請先測試連線並選擇模型");
    setSettingsPage("translation");
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
      translationJobsRef.current[activePage] = ++translationJobSequenceRef.current;
      setTranslationStates((current) => ({ ...current, [activePage]: { status: translations[activePage] ? "success" : "idle" } }));
    }
    batchActivePageRef.current = undefined;
    setBatchTranslation((current) => ({ ...current, running: false, currentPage: undefined }));
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
  const sourceLanguageLabel = settings.sourceLanguage === "auto" ? "自動偵測" : settings.sourceLanguage;
  const translatedPageCount = pageNumbers.filter((page) => Boolean(translations[page])).length;
  const allPagesTranslated = document !== null && translatedPageCount === document.numPages;

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">文</span>
          <span>LingoPane</span>
        </div>
        <div className="document-title" data-tauri-drag-region>{fileName || "尚未開啟文件"}</div>
      </header>

      <section className="toolbar" aria-label="PDF 工具列">
        <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={openPdf} />
        <button className="primary-button" onClick={() => fileInputRef.current?.click()}>{loading ? "讀取中…" : "開啟 PDF"}</button>
        {document && (
          <button
            className={`analysis-state is-${analysisState.status}`}
            title={analysisState.message}
            onClick={() => openSettings("analysis")}
          >
            {analysisState.status === "loading" ? `Docling · ${analysisState.pageCount ?? 0}/${analysisState.totalPages ?? document.numPages}` :
              analysisState.status === "success" ? `Docling · ${analysisState.pageCount ?? 0} 頁` :
              analysisState.status === "error" ? "快速分析（Docling fallback）" : "快速分析"}
          </button>
        )}
        <span className="toolbar-divider" />
        <button className="icon-button" disabled={!document || currentPage <= 1} onClick={() => jumpToPage(currentPage - 1)} aria-label="上一頁">‹</button>
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
        <button className="icon-button" disabled={!document || currentPage >= (document?.numPages ?? 0)} onClick={() => jumpToPage(currentPage + 1)} aria-label="下一頁">›</button>
        <span className="toolbar-spacer" />
        {document && (
          <>
            <div className="translation-tools" title={`${settings.provider} · ${settings.model || "尚未選擇模型"}`}>
              <span className={`translation-state-dot is-${batchTranslation.running ? "loading" : currentTranslationStatus ?? "idle"}`} aria-hidden="true" />
              <button className="language-route" title="開啟翻譯設定" onClick={() => openSettings("translation")}>{sourceLanguageLabel} <span>→</span> {settings.targetLanguage}</button>
              {batchTranslation.running ? (
                <>
                  <span className="batch-progress">第 {batchTranslation.currentPage ?? "–"} 頁 · {batchTranslation.completed}/{batchTranslation.total}</span>
                  <button className="translate-button cancel" onClick={cancelBatchTranslation}>停止全部</button>
                </>
              ) : (
                <>
                  {currentTranslationStatus === "loading" ? (
                    <button className="translate-button cancel" onClick={cancelCurrentTranslation}>取消翻譯</button>
                  ) : (
                    <button className="translate-button" disabled={!analysisReadyForPage(currentPage)} onClick={translateCurrentPage}>{translations[currentPage] ? "重新翻譯" : "翻譯目前頁"}</button>
                  )}
                  <button className="translate-all-button" disabled={analysisState.status === "loading"} onClick={translateAllPages}>{allPagesTranslated ? "重新翻譯全部" : "翻譯全部"}</button>
                </>
              )}
            </div>
            <span className="toolbar-divider" />
          </>
        )}
        <label className="sync-control" title="同步兩側閱讀位置">
          <input type="checkbox" checked={syncScroll} onChange={(event) => setSyncScroll(event.target.checked)} />
          <span>同步捲動</span>
        </label>
        <span className="toolbar-divider" />
        <button className="icon-button" disabled={!document || zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>−</button>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <button className="icon-button" disabled={!document || zoom >= 2} onClick={() => setZoom((value) => Math.min(2, value + 0.1))}>＋</button>
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section ref={shellRef} className="reader-shell">
        {!document ? (
          <div className="empty-state">
            <div className="empty-icon">PDF</div>
            <h1>並排閱讀，不中斷思緒</h1>
            <p>開啟一份 PDF，左側閱讀原文，右側保留版面顯示翻譯。</p>
            <button className="primary-button large" onClick={() => fileInputRef.current?.click()}>選擇 PDF 檔案</button>
            <span>檔案只會在你的 Mac 上處理</span>
          </div>
        ) : (
          <>
            <section className="reader-pane" aria-label={`原始文件：${fileName}`} style={{ width: `${split}%` }}>
              <div ref={sourceScrollRef} className="page-scroll" onScroll={(event) => handleReaderScroll(event.currentTarget, translationScrollRef.current)}>
                <div className="page-stack">
                  {pageNumbers.map((page) => <PdfPage key={page} document={document} pageNumber={page} scale={zoom} />)}
                </div>
              </div>
            </section>

            <div className="splitter" role="separator" aria-orientation="vertical" aria-label="調整欄寬" onPointerDown={startResize}>
              <span />
            </div>

            <section className="reader-pane" aria-label={`翻譯：${sourceLanguageLabel} 到 ${settings.targetLanguage}`} style={{ width: `${100 - split}%` }}>
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
                      translations={translations[page]}
                      status={translationStates[page]?.status}
                      error={translationStates[page]?.error}
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
                <span id="settings-title">{settingsPage === "analysis" ? "文件分析設定" : "翻譯設定"}</span>
                <small>{settingsPage === "analysis" ? "選擇 PDF 版面解析引擎與本機 Docling runtime" : "連接本機翻譯服務並設定語言與顯示方式"}</small>
              </div>
              <button className="icon-button" onClick={() => setShowSettings(false)} aria-label="關閉">×</button>
            </div>

            <nav className="settings-tabs" aria-label="設定頁面">
              <button className={settingsPage === "analysis" ? "is-active" : ""} onClick={() => switchSettingsPage("analysis")}>文件分析</button>
              <button className={settingsPage === "translation" ? "is-active" : ""} onClick={() => switchSettingsPage("translation")}>翻譯設定</button>
            </nav>

            <div className="settings-grid">
              {settingsPage === "analysis" ? (
                <>
                  <label>版面分析模式
                    <select value={settings.analysisMode} onChange={(event) => setSettings({ ...settings, analysisMode: event.target.value as AnalysisMode })}>
                      <option value="fast">快速（PDF.js）</option>
                      <option value="docling">Docling 增強（獨立 Python worker）</option>
                    </select>
                  </label>
                  {settings.analysisMode === "docling" && (
                    <>
                      <label>Docling Python 路徑
                        <input
                          placeholder="留白會自動尋找專案或受管理的 runtime"
                          value={settings.doclingPythonPath}
                          onChange={(event) => setSettings({ ...settings, doclingPythonPath: event.target.value })}
                        />
                        <small className="field-help">建議留白。App 會優先尋找獨立 Docling venv；只有找不到時才嘗試系統 Python。</small>
                      </label>
                      <label className="checkbox-setting">
                        <input type="checkbox" checked={settings.doclingOcr} onChange={(event) => setSettings({ ...settings, doclingOcr: event.target.checked })} />
                        <span>啟用 Docling standard pipeline OCR；掃描文件才建議開啟。</span>
                      </label>
                      <div className="runtime-explanation">
                        Docling worker 會在 App 外以獨立 Python subprocess 執行，不會載入 oMLX，也不會修改 macOS 系統 Python。
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <label>服務類型
                    <select value={settings.provider} onChange={(event) => updateProvider(event.target.value as Provider)}>
                      <option value="omlx">oMLX（本機）</option>
                      <option value="ollama">Ollama（本機）</option>
                      <option value="openai-compatible">OpenAI 相容端點</option>
                    </select>
                  </label>
                  <label>Base URL<input value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>
                  <label>API Key
                    <div className="secret-field">
                      <input type="password" placeholder={settings.provider === "openai-compatible" ? "留白會沿用 Keychain 內的 Key" : "本機服務通常不需要"} value={settings.apiKey} onChange={(event) => { setSettings({ ...settings, apiKey: event.target.value }); setApiKeyDirty(true); }} />
                      <button type="button" onClick={clearApiKey} disabled={settingsBusy}>清除</button>
                    </div>
                  </label>
                  {models.length > 0 && (
                    <label>偵測到的模型
                      <select value={models.includes(settings.model) ? settings.model : ""} onChange={(event) => setSettings({ ...settings, model: event.target.value })}>
                        <option value="" disabled>選擇模型</option>
                        {models.map((model) => <option key={model} value={model}>{model}</option>)}
                      </select>
                    </label>
                  )}
                  <label>模型名稱
                    <input placeholder="直接輸入模型名稱" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
                  </label>
                  <div className="language-row">
                    <label>來源語言<select value={settings.sourceLanguage} onChange={(event) => setSettings({ ...settings, sourceLanguage: event.target.value })}><option value="auto">自動偵測</option><option value="en">English</option><option value="ja">日本語</option><option value="zh-TW">繁體中文</option></select></label>
                    <span>→</span>
                    <label>目標語言<select value={settings.targetLanguage} onChange={(event) => setSettings({ ...settings, targetLanguage: event.target.value })}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select></label>
                  </div>
                  <label>翻譯字體倍率
                    <input
                      type="number"
                      min="0.8"
                      max="2"
                      step="0.1"
                      value={settings.translationFontScale}
                      onChange={(event) => setSettings({ ...settings, translationFontScale: Math.max(0.8, Math.min(2, Number(event.target.value) || 1.8)) })}
                    />
                  </label>
                </>
              )}
            </div>

            <div className={`settings-note ${connectionMessage ? "has-status" : ""}`}>
              {connectionMessage || (settingsPage === "analysis"
                ? "Docling runtime 與模型皆在本機執行；若不可用，文件會自動改用 PDF.js 快速分析。"
                : "API 請求由 Tauri 後端送出，API Key 僅儲存在 macOS Keychain。")}
            </div>
            <div className="modal-actions">
              {settingsPage === "analysis" ? (
                analysisState.status === "loading"
                  ? <button className="secondary-button" onClick={cancelDoclingAnalysis}>停止 Docling 分析</button>
                  : settings.analysisMode === "docling" && <button className="secondary-button" onClick={testDocling} disabled={settingsBusy}>{settingsBusy ? "檢查中…" : "測試 Docling runtime"}</button>
              ) : (
                <button className="secondary-button" onClick={testProvider} disabled={settingsBusy}>{settingsBusy ? "處理中…" : "測試連線並取得模型"}</button>
              )}
              <button className="primary-button" onClick={saveSettings} disabled={settingsBusy}>儲存設定</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
