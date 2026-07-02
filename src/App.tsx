import Editor, { DiffEditor } from "@monaco-editor/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import {
  Activity,
  Check,
  Clipboard,
  Database,
  Download,
  FileText,
  Gauge,
  History,
  Image,
  Play,
  RefreshCcw,
  Save,
  Scissors,
  Search,
  Settings,
  Square,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  repairLatex,
  renderPdfPreview,
  rerunBlock,
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
  LatexCompileResult,
  OCRBlock,
  OCRTaskState,
  RecognitionMode,
  RepairSuggestion,
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

export default function App() {
  const [view, setView] = useState<(typeof navItems)[number][0]>("workbench");
  const [historyQuery, setHistoryQuery] = useState("");
  const [modelState, setModelState] = useState<Record<string, unknown>>({});
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>();
  const [repairSuggestion, setRepairSuggestion] = useState<RepairSuggestion>();
  const [compileResult, setCompileResult] = useState<LatexCompileResult>();
  const [fastDeployLog, setFastDeployLog] = useState("");
  const [pdfTask, setPdfTask] = useState<OCRTaskState>();
  const {
    activeDocument,
    selectedBlockId,
    environment,
    observability,
    mode,
    busy,
    error,
    setActiveDocument,
    selectBlock,
    updateSelectedBlockLatex,
    setEnvironment,
    setObservability,
    setHistory,
    setMode,
    setBusy,
    setError,
  } = useAppStore();

  const selectedBlock = useMemo(() => {
    return activeDocument?.pages.flatMap((page) => page.blocks).find((block) => block.id === selectedBlockId);
  }, [activeDocument, selectedBlockId]);
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
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  async function captureAndRecognize() {
    await guarded(async () => {
      await ensureSidecar();
      const capture = await captureRegion();
      const document = await recognizePath(capture.path, mode);
      setActiveDocument(document);
      setHistory(await listHistory(historyQuery));
      setView("workbench");
    });
  }

  async function importAndRecognize() {
    await guarded(async () => {
      await ensureSidecar();
      const path = await chooseImportPath();
      if (!path) return;
      if (path.toLowerCase().endsWith(".pdf")) {
        setView("workbench");
        const task = await startPdfTask(path, mode);
        setPdfTask(task);
        const completed = await pollOcrTask(task.id);
        if (completed.document) {
          setActiveDocument(completed.document);
          setHistory(await listHistory(historyQuery));
        }
        return;
      }
      setPdfTask(undefined);
      const document = await recognizePath(path, mode);
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

  async function repairCurrentLatex() {
    if (!activeDocument) return;
    await guarded(async () => {
      const compilerLog = [compileResult?.error_summary, compileResult?.stdout, compileResult?.stderr]
        .filter(Boolean)
        .join("\n");
      const suggestion = await repairLatex(activeDocument.latex, compilerLog);
      setRepairSuggestion(suggestion);
      setError(suggestion.changes.join(" "));
    });
  }

  function applyRepairSuggestion() {
    if (!activeDocument || !repairSuggestion) return;
    setActiveDocument({ ...activeDocument, latex: repairSuggestion.repaired });
    setRepairSuggestion(undefined);
    setCompileResult(undefined);
  }

  async function compileCurrentLatex() {
    if (!activeDocument) return;
    await guarded(async () => {
      let result = await compileLatex(activeDocument.latex);
      if (result.pdf_path && !result.preview_image_path) {
        const preview = await renderPdfPreview(result.pdf_path);
        if (preview) result = { ...result, preview_image_path: preview.path };
      }
      setCompileResult(result);
      setError(result.ok ? undefined : compileLog(result));
    });
  }

  async function rerunSelectedBlock(modeOverride: RecognitionMode) {
    if (!activeDocument || !selectedBlock) return;
    await guarded(async () => {
      const document = await rerunBlock(activeDocument.id, selectedBlock.id, modeOverride);
      setActiveDocument(document);
    });
  }

  useEffect(() => {
    const bridge = testBridge();
    if (bridge?.initialDocument) {
      setActiveDocument(bridge.initialDocument);
      setHistory([bridge.initialDocument]);
    }
    refreshAll();
    const timer = window.setInterval(() => {
      getObservability().then(setObservability).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
    // The initial boot pass intentionally runs once; the interval owns later observability refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Shortcut registration tracks the active recognition mode through the capture closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, registeredHotkey]);

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
          <strong>{observability?.gpu[0]?.memory_used_mib ?? "-"} MiB</strong>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="segmented">
            {(["auto", "formula", "table", "text"] as RecognitionMode[]).map((item) => (
              <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <button title="Start sidecar" onClick={() => guarded(ensureSidecar)}>
              <Play size={18} />
            </button>
            <button title="Start FastDeploy" onClick={() => guarded(async () => void (await startFastDeploy()))}>
              <Gauge size={18} />
            </button>
            <button title="Stop FastDeploy" onClick={() => guarded(async () => void (await stopFastDeploy()))}>
              <Square size={18} />
            </button>
            <button title="Refresh" onClick={refreshAll}>
              <RefreshCcw size={18} />
            </button>
            <button className="primary" title="Capture" onClick={captureAndRecognize}>
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
            selectedBlock={selectedBlock}
            onSelectBlock={selectBlock}
            onBlockLatex={updateSelectedBlockLatex}
            onCopy={() => activeDocument && writeClipboard(activeDocument.latex)}
            onSave={() => activeDocument && saveLatexFile(activeDocument.title, activeDocument.latex)}
            compileResult={compileResult}
            repairSuggestion={repairSuggestion}
            onCompile={compileCurrentLatex}
            onRepair={repairCurrentLatex}
            onApplyRepair={applyRepairSuggestion}
            onDiscardRepair={() => setRepairSuggestion(undefined)}
            onClosePreview={() => setCompileResult(undefined)}
            onCancelPdfTask={cancelPdfTask}
            onRetryFailedPdfTask={retryFailedPdfTask}
            onRerun={rerunSelectedBlock}
          />
        )}
        {view === "history" && (
          <HistoryView
            query={historyQuery}
            onQuery={setHistoryQuery}
            onSearch={() => listHistory(historyQuery).then(setHistory).catch((err) => setError(String(err)))}
            onClear={() => guarded(async () => void (await clearHistory()).deleted)}
          />
        )}
        {view === "observability" && (
          <ObservabilityView
            fastDeployLog={fastDeployLog}
            onStart={() => guarded(async () => setObservability({ ...(observability ?? emptyObservability()), service: await startFastDeploy() }))}
            onStop={() => guarded(async () => setObservability({ ...(observability ?? emptyObservability()), service: await stopFastDeploy() }))}
            onReload={() => guarded(async () => setObservability({ ...(observability ?? emptyObservability()), service: await reloadFastDeploy() }))}
            onRefresh={() =>
              guarded(async () => {
                const [obs, logs] = await Promise.all([getObservability(), getFastDeployLogs()]);
                setObservability(obs);
                setFastDeployLog(logs.log);
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
            onReloadFastDeploy={() => guarded(async () => void (await reloadFastDeploy()))}
            onStatus={() => guarded(async () => setObservability({ ...(observability ?? emptyObservability()), service: await getFastDeployStatus() }))}
          />
        )}
      </main>
    </div>
  );
}

function Workbench({
  pdfTask,
  selectedBlock,
  onSelectBlock,
  onBlockLatex,
  onCopy,
  onSave,
  compileResult,
  repairSuggestion,
  onCompile,
  onRepair,
  onApplyRepair,
  onDiscardRepair,
  onClosePreview,
  onCancelPdfTask,
  onRetryFailedPdfTask,
  onRerun,
}: {
  pdfTask?: OCRTaskState;
  selectedBlock?: OCRBlock;
  onSelectBlock: (blockId?: string) => void;
  onBlockLatex: (latex: string) => void;
  onCopy: () => void;
  onSave: () => void;
  compileResult?: LatexCompileResult;
  repairSuggestion?: RepairSuggestion;
  onCompile: () => void;
  onRepair: () => void;
  onApplyRepair: () => void;
  onDiscardRepair: () => void;
  onClosePreview: () => void;
  onCancelPdfTask: () => void;
  onRetryFailedPdfTask: () => void;
  onRerun: (mode: RecognitionMode) => void;
}) {
  const { activeDocument } = useAppStore();
  const firstPage = activeDocument?.pages[0];
  return (
    <section className="workspace">
      {pdfTask && (
        <PdfTaskPanel
          task={pdfTask}
          onCancel={onCancelPdfTask}
          onRetryFailed={onRetryFailedPdfTask}
        />
      )}
      <div className="page-view">
        {firstPage?.image_path ? (
          <div className="image-stage">
            <img src={fileUrl(firstPage.image_path)} alt="" />
            {firstPage.blocks.map((block) => (
              <button
                key={block.id}
                className={`block-box ${block.id === selectedBlock?.id ? "selected" : ""}`}
                style={{
                  left: `${block.bbox[0] * 100}%`,
                  top: `${block.bbox[1] * 100}%`,
                  width: `${(block.bbox[2] - block.bbox[0]) * 100}%`,
                  height: `${(block.bbox[3] - block.bbox[1]) * 100}%`,
                }}
                title={block.block_type}
                onClick={() => onSelectBlock(block.id)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-panel">
            <FileText size={42} />
            <strong>等待识别任务</strong>
          </div>
        )}
      </div>
      <div className="block-list">
        <div className="panel-title">Blocks</div>
        {activeDocument?.pages.flatMap((page) => page.blocks).map((block) => (
          <button
            key={block.id}
            className={block.id === selectedBlock?.id ? "active" : ""}
            onClick={() => onSelectBlock(block.id)}
          >
            <span>{block.block_type}</span>
            <strong>{block.latex.slice(0, 80) || block.text.slice(0, 80) || block.id}</strong>
          </button>
        ))}
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
          <button title="Repair" onClick={onRepair}>
            <Wand2 size={18} />
          </button>
          <button title="Rerun formula" onClick={() => onRerun("formula")}>
            formula
          </button>
          <button title="Rerun table" onClick={() => onRerun("table")}>
            table
          </button>
        </div>
        <Editor
          height="42vh"
          language="latex"
          value={selectedBlock?.latex ?? activeDocument?.latex ?? ""}
          theme="vs"
          onChange={(value) => selectedBlock && onBlockLatex(value ?? "")}
          options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 14 }}
        />
        {repairSuggestion && (
          <div className="diff-panel">
            <div className="panel-actions">
              <strong>Repair Diff</strong>
              <button title="Apply repair" onClick={onApplyRepair}>
                <Check size={18} />
              </button>
              <button title="Discard repair" onClick={onDiscardRepair}>
                <X size={18} />
              </button>
            </div>
            <DiffEditor
              height="240px"
              language="latex"
              original={repairSuggestion.original}
              modified={repairSuggestion.repaired}
              theme="vs"
              options={{ readOnly: true, minimap: { enabled: false }, renderSideBySide: false, wordWrap: "on" }}
            />
            <div className="change-list">
              {repairSuggestion.changes.map((change) => (
                <span key={change}>{change}</span>
              ))}
            </div>
          </div>
        )}
        {compileResult && (
          <div className="compile-panel">
            <div className="panel-actions">
              <strong>{compileResult.ok ? "Compile OK" : `Compile ${compileResult.returncode}`}</strong>
              <button title="Close preview" onClick={onClosePreview}>
                <X size={18} />
              </button>
            </div>
            {compileResult.preview_image_path ? (
              <img className="pdf-preview-image" src={fileUrl(compileResult.preview_image_path)} alt="PDF preview" />
            ) : compileResult.pdf_path ? (
              <iframe title="PDF preview" src={fileUrl(compileResult.pdf_path)} />
            ) : (
              <pre>{compileLog(compileResult)}</pre>
            )}
            {!compileResult.ok && compileResult.pdf_path && <pre>{compileLog(compileResult)}</pre>}
          </div>
        )}
        <pre className="latex-preview">{activeDocument?.latex}</pre>
      </div>
    </section>
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
}: {
  query: string;
  onQuery: (value: string) => void;
  onSearch: () => void;
  onClear: () => void;
}) {
  const { history, setActiveDocument } = useAppStore();
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
          <button key={document.id} onClick={() => setActiveDocument(document)}>
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
  onStart,
  onStop,
  onReload,
  onRefresh,
}: {
  fastDeployLog: string;
  onStart: () => void;
  onStop: () => void;
  onReload: () => void;
  onRefresh: () => void;
}) {
  const { observability } = useAppStore();
  const gpu = observability?.gpu[0];
  const durations = observability?.request_durations_ms ?? [];
  const latestDuration = durations.at(-1);
  const cache = observability?.cache ?? {};
  return (
    <section className="metrics-grid">
      <Metric label="Service" value={observability?.service.healthy ? "healthy" : "offline"} />
      <Metric label="Queue" value={observability?.queue_depth ?? 0} />
      <Metric label="VRAM" value={gpu ? `${gpu.memory_used_mib}/${gpu.memory_total_mib} MiB` : "-"} />
      <Metric label="GPU" value={gpu?.utilization_percent != null ? `${gpu.utilization_percent}%` : "-"} />
      <Metric label="Last OCR" value={latestDuration != null ? `${Math.round(latestDuration)} ms` : "-"} />
      <div className="service-panel">
        <div className="panel-actions">
          <strong>FastDeploy</strong>
          <button title="Start FastDeploy" onClick={onStart}>
            <Play size={18} />
          </button>
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
  const [promptTemplates, setPromptTemplates] = useState<Record<RecognitionMode, string>>(defaultPromptTemplates);
  const [latexTemplate, setLatexTemplate] = useState(defaultLatexTemplate);

  useEffect(() => {
    if (!runtimeSettings) return;
    setFastDeployArgsText(runtimeSettings.fastdeploy_args.join("\n"));
    setHistoryDays(runtimeSettings.history_days);
    setLatexEngine(runtimeSettings.latex_engine);
    setHotkey(runtimeSettings.hotkey || defaultHotkey);
    setCleanupPolicy(runtimeSettings.cleanup_policy || defaultCleanupPolicy);
    setPromptTemplates({
      ...defaultPromptTemplates,
      ...runtimeSettings.prompt_templates,
    });
    setLatexTemplate(runtimeSettings.latex_template || defaultLatexTemplate);
  }, [runtimeSettings]);

  function updatePromptTemplate(mode: RecognitionMode, value: string) {
    setPromptTemplates((current) => ({ ...current, [mode]: value }));
  }

  function saveAllSettings() {
    onSaveSettings({
      fastdeploy_args: splitArgs(fastDeployArgsText),
      history_days: historyDays,
      cleanup_policy: cleanupPolicy,
      hotkey,
      prompt_templates: promptTemplates,
      latex_template: latexTemplate,
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
      <div className="settings-band wide">
        <div className="panel-title">Prompts</div>
        <div className="prompt-grid">
          {(["auto", "formula", "table", "text"] as RecognitionMode[]).map((item) => (
            <label className="field-column" key={item}>
              <span>{item}</span>
              <textarea value={promptTemplates[item]} onChange={(event) => updatePromptTemplate(item, event.target.value)} />
            </label>
          ))}
        </div>
      </div>
      <div className="settings-band wide">
        <div className="panel-title">LaTeX Template</div>
        <textarea value={latexTemplate} onChange={(event) => setLatexTemplate(event.target.value)} />
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
const defaultPromptTemplates: Record<RecognitionMode, string> = {
  auto: "OCR:",
  formula: "Formula Recognition:",
  table: "Table Recognition:",
  text: "OCR:",
};
const defaultLatexTemplate = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{amsmath,amssymb}",
  "\\usepackage{booktabs,longtable,array,graphicx}",
  "\\usepackage[margin=2.5cm]{geometry}",
  "\\title{{title}}",
  "\\date{}",
  "\\begin{document}",
  "\\maketitle",
  "",
  "{body}",
  "",
  "\\end{document}",
  "",
].join("\n");

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

function fileUrl(path: string) {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}
