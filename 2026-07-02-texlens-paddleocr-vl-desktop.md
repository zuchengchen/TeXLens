# Goal: TeXLens PaddleOCR-VL Desktop

## Goal Mode Objective

Follow the saved goal file at `/home/czc/projects/working/TeXLens/2026-07-02-texlens-paddleocr-vl-desktop.md`; build the TeXLens v0.1 local desktop OCR application using PaddleOCR-VL-1.6 via FastDeploy, and do not mark complete until the verification section passes or the user changes the completion standard.

## Full Prompt

### Objective

Create a local, independently runnable Linux desktop application similar to Mathpix, named TeXLens, using PaddleOCR-VL-1.6 through FastDeploy as the only OCR inference backend. The app must support screenshot OCR, image/PDF import, high-quality LaTeX document generation, block-level correction, history, observability, service management, packaging, tests, and documentation.

### Context

The repo `/home/czc/projects/working/TeXLens` is currently empty except for `.git`, so scaffold the project from scratch. Target the current Linux/Manjaro development system first, prioritize X11 for screenshot and global hotkey support, and show clear limitation messaging for Wayland. Use Tauri v2/Rust for the desktop shell, React + TypeScript + Vite for the UI, Monaco Editor for LaTeX editing/diff, and a Python sidecar to manage the FastDeploy PaddleOCR-VL-1.6 service.

### Brainstorming Direction

Use a desktop-first architecture: Tauri/Rust owns native desktop integration, global shortcut `Ctrl+Alt+M`, screenshot region selection, clipboard, file dialogs, service lifecycle, and packaging. Python sidecar owns FastDeploy startup, health checks, model download/validation, OCR requests, task queue integration, logs, and model/service diagnostics. Do not implement a fallback Python pipeline or replace PaddleOCR-VL/FastDeploy without asking the user.

### Discovery Summary

Build all v0.1 functionality in one pass rather than staged delivery. Prioritize accuracy and full functionality over strict VRAM limits; record performance and GPU memory metrics, but do not fail automated tests solely because memory exceeds 8GB. First version is for personal/research use under MIT license, with third-party license and model-source documentation. App is fully local for recognition, with no account, cloud sync, or online OCR. Network is allowed only for explicit model download, dependency installation during development, and manual update check.

### Scope

Scaffold and implement:
- Linux AppImage packaging plus development run scripts using pnpm, cargo, and uv/Python venv.
- Tauri v2 app with React/TypeScript/Vite UI.
- Python sidecar that starts, stops, monitors, restarts, and reloads FastDeploy PaddleOCR-VL-1.6.
- Install/model wizard that downloads and verifies PaddleOCR-VL-1.6 model files only; CUDA, Paddle, and FastDeploy dependencies are checked and documented, not silently installed.
- Screenshot workflow: global `Ctrl+Alt+M`, X11 region selection, OCR, result popup, copy LaTeX, copy source, save `.tex`.
- Import workflow: images and full PDF batch recognition, processing PDF page-by-page with progress, cancellation, retry, and failed-page records; export one merged `.tex`.
- Content-first LaTeX generation: titles, paragraphs, formulas, all tables as LaTeX tables, image placeholders, basic structure, Chinese/English support via a suitable default such as `ctexart`.
- High-quality formula handling, including inline/display formulas and best-effort complex multi-line derivation alignment.
- Block model retaining original PaddleOCR-VL JSON/intermediate results, coordinates, type, confidence, generated LaTeX, and source crop.
- Block correction UI with clickable OCR boxes over the original image, block editor, block re-recognition with formula/table/text/auto mode, and full-document reassembly.
- Monaco-based LaTeX editor, diff confirmation for conservative automatic fixes, and optional PDF preview when `xelatex` or `latexmk` exists.
- Conservative LaTeX repair for common compile errors, showing a diff before applying.
- SQLite metadata plus filesystem storage under Linux XDG directories: config in `~/.config/texlens`, data/history in `~/.local/share/texlens`, cache/model files in `~/.cache/texlens`.
- Recent 30-day history with OCR result, thumbnail, original screenshot/image copies, raw JSON/intermediate result, basic SQLite FTS search, and one-click clear.
- Full advanced settings page: model path, FastDeploy launch args with safe presets and raw-arg editing, hotkey, history policy, LaTeX toolchain path, prompts/templates, cleanup policy.
- Observability panel: GPU/VRAM, task queue, request durations, cache/model state, service logs, error trends.
- Full FastDeploy service management: health checks, automatic restart, crash recovery, log rotation, port conflict handling, model reload, cancellation/retry.
- Synthetic/self-made sample set covering formulas, tables, Chinese/English pages, images, and PDF.
- README, user manual, developer docs, troubleshooting guide, dependency/model/license notes.

### Out Of Scope

Do not add cloud OCR, accounts, cloud sync, plugin system, public local API, commercial packaging guarantees, automatic system CUDA/Paddle/FastDeploy installation, Python pipeline fallback, alternate OCR model fallback, full Wayland screenshot support, encrypted history, or automatic update checks.

### Verification

Create project scripts so these commands exist and pass where the environment supports them:
- `pnpm install`
- `pnpm lint`
- `pnpm test`
- `pnpm e2e`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `uv run pytest` from the sidecar project or equivalent documented root script
- `pnpm ocr:bench` for synthetic OCR samples with semi-automatic structure/LaTeX checks and generated human-review report
- `pnpm perf:record` to record screenshot/single-page/PDF metrics, GPU memory, service startup time, and queue behavior without hard failing on VRAM
- `pnpm tauri:build` as the documented AppImage build command

Manual acceptance must verify:
- `Ctrl+Alt+M` screenshot selection works on X11.
- A formula screenshot produces copyable/savable LaTeX.
- An image with table/formula/text produces a content-first `.tex`.
- A full PDF exports one merged `.tex`.
- Block boxes are clickable, editable, re-recognizable, and reassembled into the full document.
- LaTeX compile preview works when `xelatex`/`latexmk` is present.
- Compile repair shows a diff before applying.
- History stores, searches, expires/clears, and preserves local privacy.
- FastDeploy service management, observability, and logs are visible and useful.
- Documentation explains setup, dependencies, model download, troubleshooting, and limitations.

### Stop Conditions

Stop and ask the user before continuing if:
- PaddleOCR-VL-1.6 or FastDeploy cannot run on the current system after reasonable documented setup attempts.
- A required official API/output format differs enough that the planned block model or service integration needs redesign.
- Implementing all tables as LaTeX tables proves impossible for a class of samples without changing scope.
- Complex formula alignment requires a materially different post-processing strategy.
- Tauri/X11 screenshot or global shortcut support is blocked by platform permissions or library limitations.
- Any fallback backend, alternate OCR model, cloud service, or major scope reduction seems necessary.
- Required verification cannot run for reasons other than missing optional system LaTeX tools.

## Notes

- Created for Codex Goal mode.
- Do not mark complete until the verification section passes or the user explicitly changes the completion standard.
