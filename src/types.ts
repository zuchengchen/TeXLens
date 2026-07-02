export type BlockType = "title" | "paragraph" | "formula" | "table" | "image" | "unknown";
export type RecognitionMode = "auto" | "formula" | "table" | "text";

export interface OCRBlock {
  id: string;
  page: number;
  block_type: BlockType;
  bbox: [number, number, number, number];
  text: string;
  latex: string;
  confidence?: number | null;
  crop_path?: string | null;
  raw: Record<string, unknown>;
}

export interface PageResult {
  page: number;
  image_path?: string | null;
  width?: number | null;
  height?: number | null;
  blocks: OCRBlock[];
}

export interface DocumentResult {
  id: string;
  title: string;
  source_type: string;
  source_path?: string | null;
  created_at: string;
  updated_at: string;
  status: string;
  pages: PageResult[];
  latex: string;
  raw: Record<string, unknown>;
  thumbnail_path?: string | null;
  original_copy_path?: string | null;
  metrics: Record<string, unknown>;
}

export interface OCRTaskPage {
  page: number;
  status: string;
  image_path?: string | null;
  error?: string | null;
  duration_ms?: number | null;
}

export interface OCRTaskState {
  id: string;
  source_path: string;
  source_type: string;
  mode: RecognitionMode;
  title?: string | null;
  status: string;
  current_page?: number | null;
  total_pages: number;
  completed_pages: number;
  pages: OCRTaskPage[];
  failed_pages: OCRTaskPage[];
  cancel_requested: boolean;
  document_id?: string | null;
  document?: DocumentResult | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceState {
  running: boolean;
  pid?: number | null;
  endpoint: string;
  healthy: boolean;
  last_error?: string | null;
  raw_status: Record<string, unknown>;
}

export interface GpuMetric {
  timestamp: string;
  name: string;
  memory_used_mib?: number | null;
  memory_total_mib?: number | null;
  utilization_percent?: number | null;
}

export interface ObservabilitySnapshot {
  service: ServiceState;
  gpu: GpuMetric[];
  queue_depth: number;
  cache: Record<string, unknown>;
  recent_errors: string[];
  request_durations_ms: number[];
}

export interface ToolStatus {
  name: string;
  available: boolean;
  path?: string | null;
  note?: string | null;
}

export interface EnvironmentReport {
  os: string;
  display_server: string;
  session_type?: string | null;
  paths: Record<string, string>;
  tools: ToolStatus[];
}

export interface RepairSuggestion {
  original: string;
  repaired: string;
  changes: string[];
  requires_confirmation: boolean;
}

export interface LatexCompileResult {
  ok: boolean;
  returncode: number;
  stdout: string;
  stderr: string;
  error_summary?: string;
  pdf_path?: string | null;
  preview_image_path?: string | null;
}

export interface RuntimeSettings {
  model_dir: string;
  fastdeploy_python: string;
  fastdeploy_args: string[];
  history_days: number;
  cleanup_policy: string;
  hotkey: string;
  prompt_templates: Record<string, string>;
  latex_template: string;
  latex_engine: string;
}
