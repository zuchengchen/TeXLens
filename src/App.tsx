import Editor from "@monaco-editor/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import {
  Activity,
  Clipboard,
  Database,
  Download,
  FileText,
  History,
  Image,
  RefreshCcw,
  Save,
  Scissors,
  Search,
  Settings,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  captureRegion,
  cancelOcrTask,
  checkEnvironment,
  checkModel,
  chooseImportPath,
  clearHistory,
  compileLatex,
  downloadModel,
  getFastDeployLogs,
  getFastDeployStatus,
  getObservability,
  getOcrTask,
  getRuntimeSettings,
  listHistory,
  recognizePath,
  reloadFastDeploy,
  retryFailedOcrTask,
  saveLatexFile,
  startPdfTask,
  startFastDeploy,
  startSidecar,
  stopFastDeploy,
  updateRuntimeSettings,
  writeClipboard,
} from "./api";
import { useAppStore } from "./store";
import type {
  DocumentResult,
  GpuMetric,
  LatexCompileResult,
  OCRTaskState,
  ObservabilitySnapshot,
  RuntimeSettings,
} from "./types";
import { testBridge } from "./testBridge";
import { hasTauriRuntime, normalizeGlobalShortcut } from "./hotkeys";

const navItems = [
  ["workbench", FileText, "工作台"],
  ["history", History, "历史"],
  ["observability", Activity, "观测"],
  ["settings", Settings, "设置"],
] as const;

const autoCompileDelayMs = 1500;
const sidecarPollIntervalMs = 350;
const sidecarReadyTimeoutMs = 120000;
const fastDeployPollIntervalMs = 3000;
const fastDeployReadyTimeoutMs = 180000;
const trayCaptureEvent = "texlens-tray-capture";

type CompilePreviewState = {
  status: "idle" | "loading" | "success" | "error";
  result?: LatexCompileResult;
  error?: string;
  trigger?: "auto" | "manual";
  cacheKey?: number;
};

export default function App() {
  const [view, setView] = useState<(typeof navItems)[number][0]>("workbench");
  const [historyQuery, setHistoryQuery] = useState("");
  const [modelState, setModelState] = useState<Record<string, unknown>>({});
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>();
  const [compilePreview, setCompilePreview] = useState<CompilePreviewState>({ status: "idle" });
  const [fastDeployLog, setFastDeployLog] = useState("");
  const [pdfTask, setPdfTask] = useState<OCRTaskState>();
  const compileRequestId = useRef(0);
  const compilePreviewDocumentId = useRef<string | undefined>(undefined);
  const autoStartedServices = useRef(false);
  const {
    activeDocument,
    environment,
    observability,
    busy,
    error,
    setActiveDocument,
    updateActiveDocumentBody,
    setEnvironment,
    setObservability,
    setHistory,
    setBusy,
    setError,
  } = useAppStore();

  const activeHotkey = runtimeSettings?.hotkey?.trim() || defaultHotkey;
  const registeredHotkey = normalizeGlobalShortcut(activeHotkey, defaultHotkey);

  async function guarded(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshObservabilityAndLogs(): Promise<ObservabilitySnapshot> {
    const [obs, logs] = await Promise.all([getObservability(), getFastDeployLogs().catch(() => undefined)]);
    setObservability(obs);
    if (logs) setFastDeployLog(logs.log);
    return obs;
  }

  async function refreshAll() {
    await guarded(async () => {
      const [env, obs, docs, model, settings, logs] = await Promise.all([
        checkEnvironment(),
        getObservability().catch(() => undefined),
        listHistory(historyQuery).catch(() => []),
        checkModel().catch(() => ({})),
        getRuntimeSettings().catch(() => undefined),
        getFastDeployLogs().catch(() => undefined),
      ]);
      setEnvironment(env);
      if (obs) setObservability(obs);
      setHistory(docs);
      setModelState(model);
      if (settings) setRuntimeSettings(settings);
      if (logs) setFastDeployLog(logs.log);
    });
  }

  async function ensureSidecar() {
    await startSidecar();
    await waitForSidecarReady();
  }

  async function waitForSidecarReady() {
    const deadline = Date.now() + sidecarReadyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await refreshObservabilityAndLogs();
        return;
      } catch (err) {
        lastError = err;
        await sleep(sidecarPollIntervalMs);
      }
    }
    throw new Error(`Sidecar did not become ready: ${errorMessage(lastError)}`);
  }

  async function startFastDeployAndRefresh() {
    await ensureSidecar();
    const started = await startFastDeploy();
    setObservability({ ...(observability ?? emptyObservability()), service: started });
    const refreshed = await refreshObservabilityAndLogs();
    const service = await pollFastDeployReadiness(refreshed.service);
    if (!service?.healthy) {
      throw new Error("FastDeploy started but did not become healthy yet. Open Observability and check FastDeploy Log.");
    }
  }

  async function stopFastDeployAndRefresh() {
    await ensureSidecar();
    await stopFastDeploy();
    await refreshObservabilityAndLogs();
  }

  async function reloadFastDeployAndRefresh() {
    await ensureSidecar();
    const started = await reloadFastDeploy();
    setObservability({ ...(observability ?? emptyObservability()), service: started });
    const refreshed = await refreshObservabilityAndLogs();
    const service = await pollFastDeployReadiness(refreshed.service);
    if (!service?.healthy) {
      throw new Error("FastDeploy reloaded but did not become healthy yet. Open Observability and check FastDeploy Log.");
    }
  }

  async function pollFastDeployReadiness(initial?: ObservabilitySnapshot["service"]) {
    let service = initial;
    const deadline = Date.now() + fastDeployReadyTimeoutMs;
    while (!service?.healthy && Date.now() < deadline) {
      if (service && !service.running) break;
      await sleep(fastDeployPollIntervalMs);
      service = (await refreshObservabilityAndLogs()).service;
    }
    return service;
  }

  async function autoStartServices() {
    if (!hasTauriRuntime() || testBridge()?.skipSidecar || autoStartedServices.current) return;
    autoStartedServices.current = true;
    try {
      await startFastDeployAndRefresh();
    } catch (err) {
      setError(`后台启动 OCR 服务失败: ${errorMessage(err)}`);
    }
  }

  async function revealMainWindow() {
    if (!hasTauriRuntime()) return;
    const window = getCurrentWebviewWindow();
    await window.unminimize();
    await window.show();
    await window.setFocus();
  }

  async function captureAndRecognize(revealAfterCapture = false) {
    await guarded(async () => {
      await ensureSidecar();
      const capture = await captureRegion();
      const document = await recognizePath(capture.path);
      setActiveDocument(document);
      setHistory(await listHistory(historyQuery));
      setView("workbench");
    });
    if (revealAfterCapture) {
      await revealMainWindow().catch((err) => console.warn("Unable to reveal TeXLens after tray capture", err));
    }
  }

  async function importAndRecognize() {
    await guarded(async () => {
      await ensureSidecar();
      const path = await chooseImportPath();
      if (!path) return;
      if (path.toLowerCase().endsWith(".pdf")) {
        setView("workbench");
        const task = await startPdfTask(path);
        setPdfTask(task);
        const completed = await pollOcrTask(task.id);
        if (completed.document) {
          setActiveDocument(completed.document);
          setHistory(await listHistory(historyQuery));
        }
        return;
      }
      setPdfTask(undefined);
      const document = await recognizePath(path);
      setActiveDocument(document);
      setHistory(await listHistory(historyQuery));
      setView("workbench");
    });
  }

  async function pollOcrTask(taskId: string): Promise<OCRTaskState> {
    let task = await getOcrTask(taskId);
    setPdfTask(task);
    while (!isTerminalTaskStatus(task.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      task = await getOcrTask(taskId);
      setPdfTask(task);
    }
    return task;
  }

  async function cancelPdfTask() {
    if (!pdfTask) return;
    await guarded(async () => setPdfTask(await cancelOcrTask(pdfTask.id)));
  }

  async function retryFailedPdfTask() {
    if (!pdfTask) return;
    await guarded(async () => {
      const task = await retryFailedOcrTask(pdfTask.id);
      setPdfTask(task);
      const completed = await pollOcrTask(task.id);
      if (completed.document) {
        setActiveDocument(completed.document);
        setHistory(await listHistory(historyQuery));
      }
    });
  }

  const compileDocumentPreview = useCallback(
    async (trigger: "auto" | "manual" = "auto") => {
      if (!activeDocument) {
        compileRequestId.current += 1;
        setCompilePreview({ status: "idle" });
        return;
      }

      const requestId = ++compileRequestId.current;
      const latex = activeDocument.latex;
      setCompilePreview((current) => ({
        status: "loading",
        result: current.status === "error" ? undefined : current.result,
        trigger,
        cacheKey: current.cacheKey,
      }));

      try {
        const result = await compileLatex(latex);
        if (requestId !== compileRequestId.current) return;
        if (!result.ok) {
          const message = compileLog(result) || "LaTeX compile failed.";
          setCompilePreview({ status: "error", result, error: message, trigger });
          if (trigger === "manual") setError(message);
          return;
        }
        setCompilePreview({ status: "success", result, trigger, cacheKey: requestId });
        if (trigger === "manual") setError(undefined);
      } catch (err) {
        if (requestId !== compileRequestId.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setCompilePreview({ status: "error", error: message, trigger });
        if (trigger === "manual") setError(message);
      }
    },
    [activeDocument, setError],
  );

  async function compileCurrentLatex() {
    await compileDocumentPreview("manual");
  }

  useEffect(() => {
    const bridge = testBridge();
    if (bridge?.initialDocument) {
      setActiveDocument(bridge.initialDocument);
      setHistory([bridge.initialDocument]);
    }
    void refreshAll();
    void autoStartServices();
    const timer = window.setInterval(() => {
      getObservability().then(setObservability).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
    // The initial boot pass intentionally runs once; the interval owns later observability refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeDocument?.latex) {
      compileRequestId.current += 1;
      compilePreviewDocumentId.current = undefined;
      setCompilePreview({ status: "idle" });
      return;
    }
    const isNewDocument = compilePreviewDocumentId.current !== activeDocument.id;
    compilePreviewDocumentId.current = activeDocument.id;
    compileRequestId.current += 1;
    if (isNewDocument) {
      setCompilePreview({ status: "loading", trigger: "auto" });
    }
    const timer = window.setTimeout(() => {
      void compileDocumentPreview("auto");
    }, autoCompileDelayMs);
    return () => window.clearTimeout(timer);
  }, [activeDocument?.id, activeDocument?.latex, compileDocumentPreview]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let mounted = true;
    register(registeredHotkey, (event) => {
      if (event.state !== "Pressed") return;
      void captureAndRecognize();
    }).catch((err) => {
      if (!mounted) return;
      const detail = err instanceof Error ? err.message : String(err);
      setError(`全局热键注册失败 (${registeredHotkey}): ${detail}`);
      console.error("Global shortcut registration failed", err);
    });
    return () => {
      mounted = false;
      unregisterAll().catch((err) => console.warn("Global shortcut cleanup failed", err));
    };
    // The capture closure reads current settings and history state when invoked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registeredHotkey]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(trayCaptureEvent, () => {
      void captureAndRecognize(true);
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // Tray capture tracks the active history query through the capture closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyQuery]);

  const sidebarGpu = displayGpuMetric(observability);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">T</div>
          <div>
            <strong>TeXLens</strong>
            <span>{observability?.service.healthy ? "FastDeploy ready" : "Local"}</span>
          </div>
        </div>
        <nav>
          {navItems.map(([key, Icon, label]) => (
            <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="status-strip">
          <span>GPU</span>
          <strong>{formatGpuMemory(sidebarGpu.metric, sidebarGpu.isRecent)}</strong>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="topbar-title">
            <strong>工作台</strong>
            <span>自动识别为可编辑 LaTeX 正文</span>
          </div>
          <div className="toolbar">
            <button title="Refresh" onClick={refreshAll}>
              <RefreshCcw size={18} />
            </button>
            <button className="primary" title="Capture" onClick={() => void captureAndRecognize()}>
              <Scissors size={18} />
              <span>截图</span>
            </button>
            <button title="Import" onClick={importAndRecognize}>
              <Image size={18} />
              <span>导入</span>
            </button>
          </div>
        </header>

        {error && <div className="notice">{error}</div>}
        {busy && <div className="progress-line" />}

        {view === "workbench" && (
          <Workbench
            pdfTask={pdfTask}
            onBodyLatex={updateActiveDocumentBody}
            onCopy={() => activeDocument && writeClipboard(activeDocument.body)}
            onSave={() => activeDocument && saveLatexFile(activeDocument.title, activeDocument.latex)}
            compilePreview={compilePreview}
            onCompile={compileCurrentLatex}
            onCancelPdfTask={cancelPdfTask}
            onRetryFailedPdfTask={retryFailedPdfTask}
          />
        )}
        {view === "history" && (
          <HistoryView
            query={historyQuery}
            onQuery={setHistoryQuery}
            onSearch={() => listHistory(historyQuery).then(setHistory).catch((err) => setError(String(err)))}
            onClear={() => guarded(async () => void (await clearHistory()).deleted)}
            onOpen={(document) => {
              setActiveDocument(document);
              setView("workbench");
            }}
          />
        )}
        {view === "observability" && (
          <ObservabilityView
            fastDeployLog={fastDeployLog}
            onStop={() => guarded(stopFastDeployAndRefresh)}
            onReload={() => guarded(reloadFastDeployAndRefresh)}
            onRefresh={() =>
              guarded(async () => {
                await refreshObservabilityAndLogs();
              })
            }
          />
        )}
        {view === "settings" && (
          <SettingsView
            modelState={modelState}
            runtimeSettings={runtimeSettings}
            environment={environment}
            onDownloadModel={() => guarded(async () => setModelState(await downloadModel()))}
            onSaveSettings={(update) => guarded(async () => setRuntimeSettings(await updateRuntimeSettings(update)))}
            onReloadFastDeploy={() => guarded(reloadFastDeployAndRefresh)}
            onStatus={() => guarded(async () => setObservability({ ...(observability ?? emptyObservability()), service: await getFastDeployStatus() }))}
          />
        )}
      </main>
    </div>
  );
}

function Workbench({
  pdfTask,
  onBodyLatex,
  onCopy,
  onSave,
  compilePreview,
  onCompile,
  onCancelPdfTask,
  onRetryFailedPdfTask,
}: {
  pdfTask?: OCRTaskState;
  onBodyLatex: (latex: string) => void;
  onCopy: () => void;
  onSave: () => void;
  compilePreview: CompilePreviewState;
  onCompile: () => void;
  onCancelPdfTask: () => void;
  onRetryFailedPdfTask: () => void;
}) {
  const { activeDocument } = useAppStore();
  return (
    <section className={`workspace ${pdfTask ? "has-task" : ""}`}>
      {pdfTask && (
        <PdfTaskPanel
          task={pdfTask}
          onCancel={onCancelPdfTask}
          onRetryFailed={onRetryFailedPdfTask}
        />
      )}
      <div className="page-view">
        <SourcePreviewPanel document={activeDocument} />
        <CompiledPreviewPanel state={compilePreview} />
      </div>
      <div className="editor-column">
        <div className="panel-actions">
          <button title="Copy LaTeX" onClick={onCopy}>
            <Clipboard size={18} />
          </button>
          <button title="Save TeX" onClick={onSave}>
            <Save size={18} />
          </button>
          <button title="Compile preview" onClick={onCompile}>
            <FileText size={18} />
          </button>
        </div>
        <Editor
          height="100%"
          language="latex"
          value={activeDocument?.body ?? ""}
          theme="vs"
          onChange={(value) => onBodyLatex(value ?? "")}
          options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 14 }}
        />
        {compilePreview.status === "error" && (
          <pre className="compile-error editor-error">{compilePreview.error || "LaTeX compile failed."}</pre>
        )}
      </div>
    </section>
  );
}

function SourcePreviewPanel({ document }: { document?: DocumentResult }) {
  const sourcePath = document?.original_copy_path || document?.source_path || "";
  const isPdf = document?.source_type === "pdf" || sourcePath.toLowerCase().endsWith(".pdf");
  return (
    <div className="original-preview-panel">
      <div className="panel-title">原始预览</div>
      {sourcePath ? (
        <div className={`source-stage ${isPdf ? "pdf-source" : ""}`}>
          {isPdf ? (
            <iframe title="Original PDF preview" src={fileUrl(sourcePath)} />
          ) : (
            <img src={fileUrl(sourcePath)} alt="" />
          )}
        </div>
      ) : (
        <div className="empty-panel">
          <FileText size={42} />
          <strong>等待识别任务</strong>
        </div>
      )}
    </div>
  );
}

function CompiledPreviewPanel({ state }: { state: CompilePreviewState }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [previewMode, setPreviewMode] = useState<"pdf" | "pages">("pdf");
  const pages = previewImagePaths(state.result);
  const pdfPath = state.status !== "error" && state.result?.pdf_path ? state.result.pdf_path : "";
  const canShowPdf = pdfPath.length > 0;
  const canShowPages = state.status !== "error" && pages.length > 0;
  const activePreviewMode = canShowPdf && previewMode === "pdf" ? "pdf" : canShowPages ? "pages" : "pdf";
  const showPdf = canShowPdf && activePreviewMode === "pdf";
  const showPages = canShowPages && activePreviewMode === "pages";
  const statusText =
    state.status === "success"
      ? pdfPath
        ? pages.length > 0
          ? `编译成功 · 完整 PDF · 已生成 ${pages.length} 页图`
          : "编译成功 · 完整 PDF"
        : `编译成功 · 预览 ${pages.length || 0} 页`
      : state.status === "error"
        ? "编译失败"
        : state.status === "loading"
          ? "正在编译"
          : "等待编译";

  useEffect(() => {
    if (canShowPdf) {
      setPreviewMode("pdf");
    } else if (canShowPages) {
      setPreviewMode("pages");
    }
  }, [canShowPdf, canShowPages, pdfPath, pages.length]);

  useEffect(() => {
    const panel = panelRef.current;
    const stage = stageRef.current;
    if (!panel || !stage) return;

    const scrollPreview = (event: WheelEvent) => {
      const maxTop = stage.scrollHeight - stage.clientHeight;
      const maxLeft = stage.scrollWidth - stage.clientWidth;
      if (maxTop <= 0 && maxLeft <= 0) return;

      const multiplier =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 40
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? stage.clientHeight
            : 1;
      const nextTop = Math.max(0, Math.min(maxTop, stage.scrollTop + event.deltaY * multiplier));
      const nextLeft = Math.max(0, Math.min(maxLeft, stage.scrollLeft + event.deltaX * multiplier));
      if (nextTop === stage.scrollTop && nextLeft === stage.scrollLeft) return;

      event.preventDefault();
      event.stopPropagation();
      stage.scrollTop = nextTop;
      stage.scrollLeft = nextLeft;
    };

    panel.addEventListener("wheel", scrollPreview, { passive: false });
    return () => panel.removeEventListener("wheel", scrollPreview);
  }, [pages.length, state.status]);

  return (
    <div ref={panelRef} className="compiled-preview-panel">
      <div className="panel-actions">
        <div className="compiled-preview-heading">
          <strong>编译预览</strong>
          <span>{statusText}</span>
        </div>
        {canShowPdf && canShowPages && (
          <div className="preview-mode-toggle" role="group" aria-label="预览模式">
            <button
              className={activePreviewMode === "pdf" ? "active" : ""}
              title="完整 PDF"
              onClick={() => setPreviewMode("pdf")}
            >
              <FileText size={14} />
              PDF
            </button>
            <button
              className={activePreviewMode === "pages" ? "active" : ""}
              title="页图"
              onClick={() => setPreviewMode("pages")}
            >
              <Image size={14} />
              页图
            </button>
          </div>
        )}
      </div>
      <div ref={stageRef} className={`compiled-preview-stage ${showPdf ? "pdf-viewer" : ""}`} tabIndex={0}>
        {showPdf ? (
          <iframe
            key={`${pdfPath}-${state.cacheKey ?? "pending"}`}
            title="Compiled PDF preview"
            src={fileUrl(pdfPath, state.cacheKey)}
          />
        ) : showPages ? (
          pages.map((path, index) => (
            <figure key={`${path}-${index}-${state.cacheKey ?? "pending"}`}>
              <img src={fileUrl(path, state.cacheKey)} alt={`Compiled page ${index + 1}`} />
              <figcaption>Page {index + 1}</figcaption>
            </figure>
          ))
        ) : state.status === "error" ? (
          <pre className="compile-error">{state.error || "LaTeX compile failed."}</pre>
        ) : (
          <div className="empty-panel compact">
            <FileText size={32} />
            <strong>等待编译预览</strong>
          </div>
        )}
        {state.status === "loading" && <div className="preview-loading-overlay">正在编译</div>}
      </div>
    </div>
  );
}

function PdfTaskPanel({
  task,
  onCancel,
  onRetryFailed,
}: {
  task: OCRTaskState;
  onCancel: () => void;
  onRetryFailed: () => void;
}) {
  const percent = task.total_pages ? Math.round((task.completed_pages / task.total_pages) * 100) : 0;
  const running = !isTerminalTaskStatus(task.status);
  return (
    <div className="task-panel">
      <div className="task-summary">
        <strong>{task.title || "PDF task"}</strong>
        <span>
          {task.status} · {task.completed_pages}/{task.total_pages || "-"} pages
          {task.current_page ? ` · page ${task.current_page}` : ""}
        </span>
      </div>
      <div className="task-progress" aria-label="PDF progress">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="task-pages">
        {task.pages.map((page) => (
          <span key={page.page} className={page.status}>
            {page.page}:{page.status}
          </span>
        ))}
      </div>
      {task.failed_pages.length > 0 && (
        <div className="task-errors">
          {task.failed_pages.map((page) => (
            <code key={page.page}>
              Page {page.page}: {page.error}
            </code>
          ))}
        </div>
      )}
      <div className="panel-actions">
        {running && <button onClick={onCancel}>Cancel</button>}
        {task.failed_pages.length > 0 && !running && <button onClick={onRetryFailed}>Retry failed</button>}
      </div>
    </div>
  );
}

function HistoryView({
  query,
  onQuery,
  onSearch,
  onClear,
  onOpen,
}: {
  query: string;
  onQuery: (value: string) => void;
  onSearch: () => void;
  onClear: () => void;
  onOpen: (document: DocumentResult) => void;
}) {
  const { history } = useAppStore();
  return (
    <section className="section-grid">
      <div className="search-row">
        <Search size={18} />
        <input value={query} onChange={(event) => onQuery(event.target.value)} />
        <button onClick={onSearch}>Search</button>
        <button onClick={onClear}>
          <Trash2 size={18} />
        </button>
      </div>
      <div className="history-grid">
        {history.map((document) => (
          <button key={document.id} onClick={() => onOpen(document)}>
            <Database size={18} />
            <strong>{document.title}</strong>
            <span>{new Date(document.created_at).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ObservabilityView({
  fastDeployLog,
  onStop,
  onReload,
  onRefresh,
}: {
  fastDeployLog: string;
  onStop: () => void;
  onReload: () => void;
  onRefresh: () => void;
}) {
  const { observability } = useAppStore();
  const displayGpu = displayGpuMetric(observability);
  const gpu = displayGpu.metric;
  const durations = observability?.request_durations_ms ?? [];
  const latestDuration = durations.at(-1);
  const cache = observability?.cache ?? {};
  return (
    <section className="metrics-grid">
      <Metric label="Service" value={observability?.service.healthy ? "healthy" : "offline"} />
      <Metric label="Queue" value={observability?.queue_depth ?? 0} />
      <Metric label="VRAM" value={formatGpuMemory(gpu, displayGpu.isRecent)} />
      <Metric label="GPU" value={gpu?.utilization_percent != null ? `${gpu.utilization_percent}%` : "-"} />
      <Metric label="Last OCR" value={latestDuration != null ? `${Math.round(latestDuration)} ms` : "-"} />
      <div className="service-panel">
        <div className="panel-actions">
          <strong>FastDeploy</strong>
          <button title="Stop FastDeploy" onClick={onStop}>
            <Square size={18} />
          </button>
          <button title="Reload FastDeploy" onClick={onReload}>
            <RefreshCcw size={18} />
          </button>
          <button title="Refresh logs" onClick={onRefresh}>
            <Activity size={18} />
          </button>
        </div>
        <div className="tool-row">
          <span>Endpoint</span>
          <strong>{observability?.service.endpoint ?? "-"}</strong>
        </div>
        <div className="tool-row">
          <span>PID</span>
          <strong>{observability?.service.pid ?? "-"}</strong>
        </div>
        <code>{JSON.stringify(observability?.service.raw_status ?? {}, null, 2)}</code>
      </div>
      <div className="service-panel">
        <div className="panel-title">Cache</div>
        <code>{JSON.stringify(cache, null, 2)}</code>
      </div>
      <div className="log-panel">
        <div className="panel-title">Errors</div>
        {(observability?.recent_errors.length ? observability.recent_errors : ["No recent errors."]).map((item) => (
          <code key={item}>{item}</code>
        ))}
      </div>
      <div className="log-panel fastdeploy-log">
        <div className="panel-title">FastDeploy Log</div>
        <pre>{fastDeployLog || "No FastDeploy log has been written yet."}</pre>
      </div>
    </section>
  );
}

function SettingsView({
  modelState,
  runtimeSettings,
  environment,
  onDownloadModel,
  onSaveSettings,
  onReloadFastDeploy,
  onStatus,
}: {
  modelState: Record<string, unknown>;
  runtimeSettings?: RuntimeSettings;
  environment?: { tools: { name: string; available: boolean; path?: string | null }[] };
  onDownloadModel: () => void;
  onSaveSettings: (update: Partial<RuntimeSettings>) => void;
  onReloadFastDeploy: () => void;
  onStatus: () => void;
}) {
  const [fastDeployArgsText, setFastDeployArgsText] = useState(defaultFastDeployArgsText);
  const [historyDays, setHistoryDays] = useState(30);
  const [latexEngine, setLatexEngine] = useState("xelatex");
  const [hotkey, setHotkey] = useState(defaultHotkey);
  const [cleanupPolicy, setCleanupPolicy] = useState(defaultCleanupPolicy);

  useEffect(() => {
    if (!runtimeSettings) return;
    setFastDeployArgsText(runtimeSettings.fastdeploy_args.join("\n"));
    setHistoryDays(runtimeSettings.history_days);
    setLatexEngine(runtimeSettings.latex_engine);
    setHotkey(runtimeSettings.hotkey || defaultHotkey);
    setCleanupPolicy(runtimeSettings.cleanup_policy || defaultCleanupPolicy);
  }, [runtimeSettings]);

  function saveAllSettings() {
    onSaveSettings({
      fastdeploy_args: splitArgs(fastDeployArgsText),
      history_days: historyDays,
      cleanup_policy: cleanupPolicy,
      hotkey,
      latex_engine: latexEngine,
    });
  }

  return (
    <section className="settings-grid">
      <div className="settings-band">
        <div className="panel-title">Model</div>
        <div className="tool-row">
          <span>Path</span>
          <strong>{runtimeSettings?.model_dir ?? "-"}</strong>
        </div>
        <div className="tool-row">
          <span>Python</span>
          <strong>{runtimeSettings?.fastdeploy_python ?? "-"}</strong>
        </div>
        <code>{JSON.stringify(modelState, null, 2)}</code>
        <button onClick={onDownloadModel}>
          <Download size={18} />
          <span>Download</span>
        </button>
      </div>
      <div className="settings-band">
        <div className="panel-title">FastDeploy</div>
        <textarea value={fastDeployArgsText} onChange={(event) => setFastDeployArgsText(event.target.value)} />
        <div className="panel-actions">
          <button onClick={saveAllSettings}>Save</button>
          <button onClick={onReloadFastDeploy}>Reload</button>
          <button onClick={onStatus}>Status</button>
        </div>
      </div>
      <div className="settings-band">
        <div className="panel-title">Runtime</div>
        <label className="field-row">
          <span>Hotkey</span>
          <input value={hotkey} onChange={(event) => setHotkey(event.target.value)} />
        </label>
        <label className="field-row">
          <span>History days</span>
          <input
            type="number"
            min={1}
            value={historyDays}
            onChange={(event) => setHistoryDays(Number(event.target.value))}
          />
        </label>
        <label className="field-row">
          <span>Cleanup</span>
          <select value={cleanupPolicy} onChange={(event) => setCleanupPolicy(event.target.value)}>
            <option value="history_ttl">history_ttl</option>
            <option value="manual_only">manual_only</option>
          </select>
        </label>
        <label className="field-row">
          <span>LaTeX engine</span>
          <input value={latexEngine} onChange={(event) => setLatexEngine(event.target.value)} />
        </label>
      </div>
      <div className="settings-band">
        <div className="panel-title">Environment</div>
        {environment?.tools.map((tool) => (
          <div className="tool-row" key={tool.name}>
            <span>{tool.name}</span>
            <strong>{tool.available ? tool.path : "missing"}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function displayGpuMetric(observability?: ObservabilitySnapshot): { metric?: GpuMetric; isRecent: boolean } {
  const live = observability?.gpu.find((metric) => metric.memory_used_mib != null);
  if (live) return { metric: live, isRecent: false };

  const metrics = observability?.cache.metrics;
  if (!Array.isArray(metrics)) return { isRecent: false };

  for (const payload of metrics) {
    if (!isRecord(payload) || !Array.isArray(payload.gpu)) continue;
    const cached = payload.gpu.map(normalizeGpuMetric).find((metric) => metric?.memory_used_mib != null);
    if (cached) return { metric: cached, isRecent: true };
  }

  return { isRecent: false };
}

function normalizeGpuMetric(value: unknown): GpuMetric | undefined {
  if (!isRecord(value)) return undefined;
  const memoryUsed = optionalNumber(value.memory_used_mib);
  if (memoryUsed == null) return undefined;
  return {
    timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
    name: typeof value.name === "string" ? value.name : "GPU",
    memory_used_mib: memoryUsed,
    memory_total_mib: optionalNumber(value.memory_total_mib),
    utilization_percent: optionalNumber(value.utilization_percent),
  };
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatGpuMemory(gpu?: GpuMetric, isRecent = false): string {
  const prefix = isRecent ? "最近 " : "";
  if (gpu?.memory_used_mib != null && gpu.memory_total_mib != null) {
    return `${prefix}${gpu.memory_used_mib}/${gpu.memory_total_mib} MiB`;
  }
  if (gpu?.memory_used_mib != null) return `${prefix}${gpu.memory_used_mib} MiB`;
  return "无数据";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err == null) return "unknown error";
  return String(err);
}

function emptyObservability() {
  return {
    service: { running: false, endpoint: "http://127.0.0.1:8185", healthy: false, raw_status: {} },
    gpu: [],
    queue_depth: 0,
    cache: {},
    recent_errors: [],
    request_durations_ms: [],
  };
}

const defaultFastDeployArgsText =
  "--gpu-memory-utilization 0.6\n--max-model-len 8192\n--max-num-batched-tokens 8192\n--max-num-seqs 8";
const defaultHotkey = "Ctrl+Alt+M";
const defaultCleanupPolicy = "history_ttl";

function splitArgs(value: string): string[] {
  return (
    value
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((item) => item.replace(/^['"]|['"]$/g, ""))
      .filter(Boolean) ?? []
  );
}

function isTerminalTaskStatus(status: string): boolean {
  return ["completed", "completed_with_errors", "failed", "cancelled"].includes(status);
}

function compileLog(result: LatexCompileResult): string {
  const summary = result.error_summary || extractLatexErrorSummary(result.stdout, result.stderr);
  return [
    summary && `Summary:\n${summary}`,
    result.stdout && `stdout:\n${result.stdout}`,
    result.stderr && `stderr:\n${result.stderr}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function previewImagePaths(result?: LatexCompileResult): string[] {
  if (!result) return [];
  const paths = result.preview_image_paths?.filter(Boolean) ?? [];
  if (paths.length > 0) return paths;
  return result.preview_image_path ? [result.preview_image_path] : [];
}

function extractLatexErrorSummary(stdout: string, stderr: string): string {
  const genericLatexmkPatterns = [
    /Latexmk: Sometimes, the -f option/,
    /Latexmk: Using bibtex/,
    /But normally, you will need to correct/,
    /clean out generated files before rerunning/,
  ];
  const patterns = [
    /^!/,
    /^l\.\d+/,
    /LaTeX Error/,
    /Package .* Error/,
    /Undefined control sequence/,
    /Missing \$ inserted/,
    /Runaway argument/,
    /Emergency stop/,
    /Misplaced alignment tab/,
    /Extra alignment tab/,
    /File .* not found/,
  ];
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  const interesting: string[] = [];
  lines.forEach((line, index) => {
    if (!patterns.some((pattern) => pattern.test(line))) return;
    lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 4)).forEach((item) => {
      if (genericLatexmkPatterns.some((pattern) => pattern.test(item))) return;
      interesting.push(item);
    });
    interesting.push("");
  });
  return interesting.join("\n").trim();
}

function fileUrl(path: string, cacheKey?: number) {
  let url = path;
  try {
    url = convertFileSrc(path);
  } catch {
    url = path;
  }
  if (cacheKey == null) return url;
  return `${url}${url.includes("?") ? "&" : "?"}texlensPreview=${encodeURIComponent(String(cacheKey))}`;
}
