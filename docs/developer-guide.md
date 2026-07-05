# Developer Guide

## Architecture

```text
Tauri/Rust
  Native window, StatusNotifier tray, close-to-tray behavior, X11 screenshot,
  global shortcut, clipboard, dialogs, sidecar lifecycle

React/TypeScript
  Workbench, source preview, Monaco body editor, history, settings, observability

Python sidecar
  FastDeploy process manager, OpenAI-compatible PaddleOCR-VL calls, SQLite history,
  LaTeX body generation, compile preview support, metrics, model download

FastDeploy
  PaddleOCR-VL-1.6 VLM service
```

The sidecar uses only FastDeploy for OCR. Development utilities may generate reports without OCR, but recognition endpoints must fail when FastDeploy is unavailable.

## Key Directories

- `src/`: React UI.
- `src-tauri/`: Rust desktop shell.
- `sidecar/src/texlens_sidecar/`: Python sidecar.
- `samples/`: synthetic sample generator and generated assets.
- `docs/`: user and developer documentation.

## Commands

```bash
pnpm dev
pnpm tauri:dev
pnpm lint
pnpm test
uv run --project sidecar pytest
pnpm ocr:bench
pnpm perf:record
pnpm tauri:build
```

## FastDeploy Command

The sidecar starts FastDeploy with:

```bash
.fastdeploy-venv/bin/python -m fastdeploy.entrypoints.openai.api_server \
  --model <PaddleOCR-VL-1.6 local dir or repo> \
  --host 127.0.0.1 \
  --port 8185 \
  --metrics-port 8186 \
  --engine-worker-queue-port 8187 \
  --max-model-len 8192 \
  --max-num-batched-tokens 8192 \
  --gpu-memory-utilization 0.6 \
  --max-num-seqs 8
```

These defaults are the desktop 8GB VRAM preset. They trade server-style concurrency for a
lower KV cache footprint suitable for local single-user OCR. Users with more VRAM can raise
`--gpu-memory-utilization`, `--max-model-len`, and `--max-num-seqs` in settings.

If the official module path or API changes, stop and redesign the integration rather than substituting another OCR backend.

FastDeploy requires Python 3.10-3.12. The sidecar checks for `.fastdeploy-venv/bin/python` and uses it when present; otherwise set `TEXLENS_FASTDEPLOY_PYTHON=/path/to/python`.

Official NVIDIA GPU installation commands use Paddle package indexes, not PyPI:

```bash
uv python install 3.12
uv venv --python 3.12 .fastdeploy-venv
uv pip install --python .fastdeploy-venv/bin/python pip
uv pip install --python .fastdeploy-venv/bin/python paddlepaddle-gpu --index-url https://www.paddlepaddle.org.cn/packages/stable/cu129/
UV_SKIP_WHEEL_FILENAME_CHECK=1 uv pip install --python .fastdeploy-venv/bin/python \
  'fastdeploy-gpu==2.5.0' \
  'flash-mask @ https://paddle-qa.bj.bcebos.com/ernie/flash_mask-4.0.post20260128-py3-none-any.whl' \
  --index-url https://www.paddlepaddle.org.cn/packages/stable/cu129/ \
  --extra-index-url https://pypi.org/simple \
  --index-strategy unsafe-best-match
```

`pip` must exist inside `.fastdeploy-venv`; PaddleFormers imports it while loading the
model registry. The sidecar `/environment` endpoint reports whether `pip`, `fastdeploy`,
`paddle`, and `paddleformers` are visible from the FastDeploy Python.

TeXLens sends PaddleOCR-VL's native `OCR:` prompt through FastDeploy. Native table cell
streams such as `<fcel>...<nl>` and Markdown-style pipe tables are converted to LaTeX
`tabular` during body generation. Plain FastDeploy text responses are converted into one
document-level LaTeX body. Formula-like content is wrapped with `equation`; multi-line
formula content uses an inner `aligned` environment, line separators are inserted when
missing, and doubled command slashes such as `\\infty` are normalized before compile
preview.

LaTeX export uses a fixed internal `ctexart` template. The frontend edits only the body;
Copy LaTeX copies the body, and Save TeX writes the full template-wrapped source.

Runtime settings are persisted as JSON in `~/.config/texlens/settings.json` unless
`TEXLENS_CONFIG_DIR` or XDG config variables point elsewhere.

## Sidecar API

Core local endpoints:

- `GET /health`
- `GET /environment`
- `GET /settings`, `PUT /settings`
- `GET /models/check`, `POST /models/download`
- `POST /fastdeploy/start`, `POST /fastdeploy/stop`, `POST /fastdeploy/reload`
- `GET /fastdeploy/status`, `GET /fastdeploy/logs`
- `POST /ocr/recognize`
- `POST /ocr/upload`
- `GET /history`, `GET /history/{document_id}`, `DELETE /history`, `POST /history/prune`
- `POST /latex/compile`
- `GET /observability`

PDF task endpoints:

- `POST /ocr/tasks/pdf`: validates a local `.pdf`, creates an in-memory task, renders pages,
  and starts page-by-page OCR in the background.
- `GET /ocr/tasks/{task_id}`: returns status, current page, progress, failed pages, and the
  assembled document when available.
- `POST /ocr/tasks/{task_id}/cancel`: requests cancellation after the current in-flight page.
- `POST /ocr/tasks/{task_id}/retry-failed`: switches the task to `retrying` before returning,
  then re-runs only failed rendered pages.

Task summaries also appear in `/observability` under `cache.tasks`.

`GET /settings` and `PUT /settings` use this shape:

```json
{
  "model_dir": "/home/user/.cache/texlens/models/PaddleOCR-VL-1.6",
  "fastdeploy_python": "/path/to/.fastdeploy-venv/bin/python",
  "fastdeploy_args": [
    "--gpu-memory-utilization",
    "0.6",
    "--max-model-len",
    "8192",
    "--max-num-batched-tokens",
    "8192",
    "--max-num-seqs",
    "8"
  ],
  "history_days": 30,
  "cleanup_policy": "history_ttl",
  "hotkey": "Ctrl+Alt+M",
  "latex_engine": "xelatex"
}
```

`cleanup_policy` accepts `history_ttl` and `manual_only`. With `manual_only`, `/history/prune`
returns without deleting history; users must clear history explicitly.

## Document Model

Final OCR documents expose document-level fields:

- `id`, `title`, `source_type`, `source_path`, timestamps, and status.
- `body`: the editable LaTeX body shown in Monaco.
- `latex`: complete source produced by wrapping `body` in the fixed internal template.
- `original_copy_path` and `thumbnail_path` when available.
- `metrics` and a small raw payload for diagnostics.

PDF OCR tasks still expose page progress through `total_pages`, `current_page`,
`completed_pages`, `pages`, and `failed_pages`, but completed documents do not expose
page/block structures.
