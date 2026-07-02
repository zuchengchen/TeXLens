# User Manual

## Workflows

TeXLens opens directly into the workbench. The main workflow is screenshot recognition with `Ctrl+Alt+M`, followed by block-level correction and LaTeX export.

Supported v0.1 workflows:

- X11 region screenshot to LaTeX.
- Image import to LaTeX.
- Full PDF import, rendered page-by-page and exported as one merged `.tex` file.
- Block correction by selecting an OCR box over the source image.
- Block re-recognition as `auto`, `formula`, `table`, or `text`.
- History search and export.
- Optional PDF preview when `xelatex` or `latexmk` is installed.
- Observability with FastDeploy start/stop/reload, raw service status, GPU/VRAM,
  recent request metrics, cache paths, recent errors, and the FastDeploy log tail.

## PDF Import

PDF files are processed as background tasks. TeXLens renders the PDF page-by-page,
recognizes one page at a time through FastDeploy, and shows task status, current page,
completed/total pages, and failed-page details in the workbench.

While a PDF task is running, use **Cancel** to stop after the current in-flight page.
If a task finishes with failed pages, use **Retry failed** to re-run only those pages.
Successful pages are preserved and the final document is reassembled into one merged
LaTeX file.

## Data Locations

TeXLens follows Linux XDG directories:

- Config: `~/.config/texlens`
- History and exports: `~/.local/share/texlens`
- Cache, thumbnails, captures, and models: `~/.cache/texlens`

History keeps the last 30 days by default. It stores OCR results, thumbnails, raw OCR JSON, and copies of original screenshots/images. History is not encrypted. Use the clear-history action before sharing the machine or removing sensitive material.

Runtime settings are saved to `~/.config/texlens/settings.json`.

## Model Setup

The model wizard downloads and verifies PaddleOCR-VL-1.6 model files only. CUDA, Paddle, and FastDeploy are checked and documented but not silently installed.

## Settings

The settings page controls the local runtime without changing the OCR backend:

- Model path and FastDeploy Python are shown for diagnostics.
- FastDeploy launch arguments can be edited directly. The default 8GB preset is
  `--gpu-memory-utilization 0.6 --max-model-len 8192 --max-num-batched-tokens 8192 --max-num-seqs 8`.
- The global screenshot hotkey defaults to `Ctrl+Alt+M`. On X11, changing it updates the shortcut registration after settings refresh or app restart.
- History retention defaults to 30 days. Cleanup can use `history_ttl` or `manual_only`; `manual_only` disables automatic pruning and leaves removal to the clear-history action.
- The LaTeX engine defaults to `xelatex`; `latexmk` is used automatically for preview when available.
- Prompt templates are editable for `auto`, `formula`, `table`, and `text`. Defaults use PaddleOCR-VL native prompts: `OCR:`, `Formula Recognition:`, and `Table Recognition:`.
- The LaTeX document template is editable. Keep `{body}` in the template to insert recognized content; `{title}` is replaced with the document title when present.

## LaTeX Output

TeXLens produces content-first LaTeX using `ctexart` so Chinese and English documents can be edited after recognition. Tables are always represented as LaTeX tables. Complex formula derivations are requested from PaddleOCR-VL as `align*` where possible and can be corrected block by block.
PaddleOCR-VL native table cell streams and Markdown-style pipe tables are normalized to
`tabular`. Multi-line formula text is normalized into `align*` and obvious doubled
LaTeX command slashes such as `\\infty` are repaired during assembly. If a custom LaTeX
template omits `{body}`, TeXLens falls back to the default `ctexart` template so recognized
content is not lost.
