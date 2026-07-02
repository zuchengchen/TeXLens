# TeXLens

TeXLens is a local Linux desktop OCR application for turning screenshots, images, and PDFs into editable LaTeX documents. The v0.1 goal is desktop-first: Tauri/Rust for native integration, React/TypeScript for the UI, and a Python sidecar that manages PaddleOCR-VL-1.6 through FastDeploy.

The OCR backend is intentionally strict: TeXLens does not fall back to another OCR model or to a plain Python pipeline. If FastDeploy or PaddleOCR-VL is unavailable, OCR requests fail with an explicit readiness error.

## Current Target

- Linux/Manjaro first.
- X11 screenshot and global hotkey first.
- Wayland displays a limitation message for screenshot capture.
- Recognition is local. No account, cloud sync, or online OCR.
- Model download is user-triggered from the app or sidecar API.

## Development

```bash
pnpm install
uv sync --project sidecar --extra dev --extra pdf
pnpm tauri:dev
```

Sidecar only:

```bash
uv run --project sidecar texlens-sidecar --host 127.0.0.1 --port 8765
```

FastDeploy is managed by the sidecar and defaults to an OpenAI-compatible service on `127.0.0.1:8185`.

FastDeploy requires Python 3.10-3.12. For development, create a separate `.fastdeploy-venv`; the sidecar will use it automatically when present.
The default launch args are tuned for a local 8GB VRAM budget:
`--gpu-memory-utilization 0.6 --max-model-len 8192 --max-num-batched-tokens 8192 --max-num-seqs 8`.

The AppImage bundles the sidecar source, `pyproject.toml`, and `uv.lock`. On first sidecar
start it creates a writable uv environment at `~/.cache/texlens/sidecar-venv` and writes
process logs to `~/.cache/texlens/sidecar.log`.

Runtime settings are stored in `~/.config/texlens/settings.json`. The settings page exposes
the FastDeploy launch args, screenshot hotkey, history cleanup policy, LaTeX engine, native
PaddleOCR-VL prompt templates, and the document LaTeX template used for export.

PDF import runs as a sidecar background task: pages are rendered, recognized one-by-one
through FastDeploy, cancellable, retryable per failed page, and exported as one merged
LaTeX document. Plain PaddleOCR-VL text responses are post-processed into blocks, with
Markdown-style tables converted to `tabular` and multi-line formulas normalized to
compilable `align*` where possible.

## Verification

```bash
pnpm lint
pnpm test
pnpm e2e
cargo test --manifest-path src-tauri/Cargo.toml
uv run --project sidecar pytest
pnpm ocr:bench
pnpm perf:record
pnpm tauri:build
```

`pnpm verify` runs the main local verification sequence, including lint, unit tests,
sidecar tests, OCR benchmark, performance recording, and AppImage build.

`pnpm ocr:bench` records readiness and produces a report. Full OCR quality acceptance still requires a running PaddleOCR-VL FastDeploy service and manual review of formulas, tables, and block correction.

On current Manjaro/Arch systems, AppImage bundling uses `NO_STRIP=1` to avoid linuxdeploy's older strip binary failing on `.relr.dyn` sections in system libraries.

## Documentation

- [User manual](docs/user-manual.md)
- [Developer guide](docs/developer-guide.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Dependencies and licenses](docs/dependencies-and-licenses.md)
