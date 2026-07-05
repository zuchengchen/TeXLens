# User Manual

## Workflows

TeXLens opens directly into the workbench. The main workflow is screenshot recognition with `Ctrl+Alt+M`, followed by editing the recognized LaTeX body and exporting a complete `.tex` file.

Supported v0.1 workflows:

- X11 region screenshot to LaTeX.
- Image import to LaTeX.
- Full PDF import, rendered page-by-page and exported as one merged `.tex` file.
- Direct LaTeX body editing in the right-side editor.
- History search and export.
- Automatic compiled LaTeX preview when `xelatex` or `latexmk` and `pdftoppm`
  are installed.
- Observability with FastDeploy start/stop/reload, raw service status, GPU/VRAM,
  recent request metrics, cache paths, recent errors, and the FastDeploy log tail.

## Tray And Exit

On Linux desktops, TeXLens shows a tray icon while it is running. It uses an
XEmbed tray icon on X11+i3 so it appears directly in i3bar, and uses
StatusNotifier/AppIndicator on other Linux desktops. Closing the main window
hides TeXLens to the tray instead of exiting the app, so sidecar processes and
background PDF tasks keep their current state.

Left-click the tray icon, or choose **Show TeXLens** from the tray menu, to show
and focus the main window again. The tray menu also offers **Capture Region**,
**Restart**, and **Quit**. **Restart** starts `pnpm tauri:dev` again from the
local project checkout, then exits the current TeXLens process.

## PDF Import

PDF files are processed as background tasks. TeXLens renders the PDF page-by-page,
recognizes one page at a time through FastDeploy, and shows task status, current page,
completed/total pages, and failed-page details in the workbench.

While a PDF task is running, use **Cancel** to stop after the current in-flight page.
If a task finishes with failed pages, use **Retry failed** to re-run only those pages.
Successful pages are preserved and the final document is reassembled into one merged
LaTeX file.

## Compiled Preview

The workbench left column shows the original screenshot/image, or the full original PDF,
above the compiled LaTeX preview. The right column contains the editable LaTeX body only;
the preamble and `\begin{document}` / `\end{document}` wrapper are intentionally hidden.
TeXLens compiles the full document after recognition, import, or opening a history item,
then refreshes the compiled preview automatically after editing stops for about 1.5 seconds.

The **Compile preview** button is still available for an immediate manual refresh.
Automatic preview renders the complete compiled PDF as page images and shows them
in a scrollable preview area, so long documents can be inspected with the mouse
wheel inside the compiled preview. If compilation fails, the latest LaTeX error summary
is shown under the right-side editor.

**Copy LaTeX** copies only the editable body. **Save TeX** writes a complete LaTeX source
file by wrapping that body in TeXLens' fixed internal `ctexart` template.

Preview generation requires a local LaTeX toolchain (`latexmk` or `xelatex`) and
Poppler's `pdftoppm` command. Without those tools, TeXLens can still edit and export
LaTeX, but it cannot render the compiled preview.

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

## LaTeX Output

TeXLens produces content-first LaTeX using `ctexart` so Chinese and English documents can be edited after recognition. The document model stores the editable body and a complete wrapped LaTeX source. Tables are represented as LaTeX tables.
PaddleOCR-VL native table cell streams and Markdown-style pipe tables are normalized to
`tabular`. Multi-line formula text is normalized into `equation` with an inner `aligned`
environment, and obvious doubled
LaTeX command slashes such as `\\infty` are repaired during assembly.
