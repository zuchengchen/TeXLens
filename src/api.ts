import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { testBridge } from "./testBridge";
import type {
  DocumentResult,
  EnvironmentReport,
  LatexCompileResult,
  ObservabilitySnapshot,
  OCRTaskState,
  RecognitionMode,
  RepairSuggestion,
  RuntimeSettings,
  ServiceState,
} from "./types";

const SIDECAR = "http://127.0.0.1:8765";

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SIDECAR}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function checkEnvironment(): Promise<EnvironmentReport> {
  try {
    return await invoke<EnvironmentReport>("check_environment");
  } catch {
    return browserEnvironmentReport();
  }
}

export async function captureRegion(): Promise<{ path: string; captured_at: string }> {
  const bridge = testBridge();
  if (bridge?.capture) return bridge.capture;
  return invoke("capture_region");
}

export async function startSidecar(): Promise<{ running: boolean; pid?: number; endpoint: string }> {
  if (testBridge()?.skipSidecar) {
    return { running: true, endpoint: SIDECAR };
  }
  return invoke("start_sidecar", { options: { host: "127.0.0.1", port: 8765 } });
}

export async function stopSidecar(): Promise<{ running: boolean; pid?: number; endpoint: string }> {
  return invoke("stop_sidecar");
}

export async function startFastDeploy(): Promise<ServiceState> {
  return jsonFetch<ServiceState>("/fastdeploy/start", { method: "POST" });
}

export async function stopFastDeploy(): Promise<ServiceState> {
  return jsonFetch<ServiceState>("/fastdeploy/stop", { method: "POST" });
}

export async function reloadFastDeploy(): Promise<ServiceState> {
  return jsonFetch<ServiceState>("/fastdeploy/reload", { method: "POST" });
}

export async function getFastDeployStatus(): Promise<ServiceState> {
  return jsonFetch<ServiceState>("/fastdeploy/status");
}

export async function getFastDeployLogs(): Promise<{ log: string }> {
  return jsonFetch<{ log: string }>("/fastdeploy/logs");
}

export async function getObservability(): Promise<ObservabilitySnapshot> {
  return jsonFetch<ObservabilitySnapshot>("/observability");
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return jsonFetch<RuntimeSettings>("/settings");
}

export async function updateRuntimeSettings(update: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
  return jsonFetch<RuntimeSettings>("/settings", {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

export async function recognizePath(
  path: string,
  mode: RecognitionMode = "auto",
  sourceType = path.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
): Promise<DocumentResult> {
  return jsonFetch<DocumentResult>("/ocr/recognize", {
    method: "POST",
    body: JSON.stringify({ path, source_type: sourceType, mode }),
  });
}

export async function startPdfTask(path: string, mode: RecognitionMode, title?: string): Promise<OCRTaskState> {
  return jsonFetch<OCRTaskState>("/ocr/tasks/pdf", {
    method: "POST",
    body: JSON.stringify({ path, mode, title }),
  });
}

export async function getOcrTask(taskId: string): Promise<OCRTaskState> {
  return jsonFetch<OCRTaskState>(`/ocr/tasks/${taskId}`);
}

export async function cancelOcrTask(taskId: string): Promise<OCRTaskState> {
  return jsonFetch<OCRTaskState>(`/ocr/tasks/${taskId}/cancel`, { method: "POST" });
}

export async function retryFailedOcrTask(taskId: string): Promise<OCRTaskState> {
  return jsonFetch<OCRTaskState>(`/ocr/tasks/${taskId}/retry-failed`, { method: "POST" });
}

export async function rerunBlock(
  documentId: string,
  blockId: string,
  mode: RecognitionMode,
): Promise<DocumentResult> {
  return jsonFetch<DocumentResult>("/ocr/rerun-block", {
    method: "POST",
    body: JSON.stringify({ document_id: documentId, block_id: blockId, mode }),
  });
}

export async function listHistory(query = ""): Promise<DocumentResult[]> {
  return jsonFetch<DocumentResult[]>(`/history${query ? `?q=${encodeURIComponent(query)}` : ""}`);
}

export async function clearHistory(): Promise<{ deleted: number }> {
  return jsonFetch<{ deleted: number }>("/history", { method: "DELETE" });
}

export async function repairLatex(latex: string, compilerLog = ""): Promise<RepairSuggestion> {
  return jsonFetch<RepairSuggestion>("/latex/repair", {
    method: "POST",
    body: JSON.stringify({ latex, compiler_log: compilerLog }),
  });
}

export async function compileLatex(latex: string): Promise<LatexCompileResult> {
  try {
    return await invoke<LatexCompileResult>("compile_latex_preview", { latex });
  } catch {
    // Browser e2e and older development shells still use the sidecar endpoint.
  }
  return jsonFetch<LatexCompileResult>("/latex/compile", {
    method: "POST",
    body: JSON.stringify({ latex }),
  });
}

export async function renderPdfPreview(pdfPath: string): Promise<{ path: string } | null> {
  try {
    return await invoke<{ path: string }>("render_pdf_preview", { pdfPath });
  } catch {
    return null;
  }
}

export async function downloadModel(): Promise<Record<string, unknown>> {
  return jsonFetch<Record<string, unknown>>("/models/download", { method: "POST" });
}

export async function checkModel(): Promise<Record<string, unknown>> {
  return jsonFetch<Record<string, unknown>>("/models/check");
}

export async function chooseImportPath(): Promise<string | null> {
  const bridge = testBridge();
  if (bridge && Object.prototype.hasOwnProperty.call(bridge, "importPath")) {
    return bridge.importPath ?? null;
  }
  const selected = await open({
    multiple: false,
    filters: [{ name: "Documents", extensions: ["png", "jpg", "jpeg", "webp", "pdf"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function writeClipboard(value: string): Promise<void> {
  try {
    await writeText(value);
  } catch {
    await navigator.clipboard.writeText(value);
  }
}

export async function saveLatexFile(defaultName: string, latex: string): Promise<void> {
  const bridge = testBridge();
  if (bridge?.savedLatexFiles) {
    bridge.savedLatexFiles.push({ defaultName, latex });
    return;
  }
  const target = await save({
    defaultPath: defaultName.endsWith(".tex") ? defaultName : `${defaultName}.tex`,
    filters: [{ name: "LaTeX", extensions: ["tex"] }],
  });
  if (!target) return;
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(target, latex);
}

function browserEnvironmentReport(): EnvironmentReport {
  return {
    os: navigator.platform || "browser",
    display_server: "browser",
    paths: {},
    tools: [
      {
        name: "tauri",
        available: false,
        note: "Desktop shell APIs are available in the packaged app.",
      },
    ],
  };
}
