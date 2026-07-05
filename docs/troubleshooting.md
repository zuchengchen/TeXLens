# Troubleshooting

## FastDeploy Is Not Healthy

Check the sidecar observability panel. It shows FastDeploy start/stop/reload controls,
raw service status, cache paths, recent errors, and the same FastDeploy log tail stored
at `~/.cache/texlens/fastdeploy.log`.

When the desktop app starts the Python sidecar, stdout/stderr are appended to
`~/.cache/texlens/sidecar.log`. AppImage builds run the bundled sidecar project from
the read-only AppImage mount and create the writable uv environment at
`~/.cache/texlens/sidecar-venv`.

Common causes:

- FastDeploy is not installed in the active Python environment.
- FastDeploy is installed into Python 3.9 instead of a supported Python 3.10-3.12 environment.
- `.fastdeploy-venv` does not contain `pip`; PaddleFormers imports `pip` while loading
  model classes.
- PaddleOCR-VL-1.6 model files are missing.
- CUDA, Paddle, or driver versions are incompatible.
- Port `8185` is already in use.
- Launch arguments are too aggressive for the GPU.
- AppImage Python environment variables leak into uv. Current builds remove
  `PYTHONHOME` and `PYTHONPATH` before launching the sidecar.

Check `/environment` and confirm `fastdeploy_python_modules.pip`, `fastdeploy`,
`paddle`, and `paddleformers` are all `true`.

To repair a missing `pip` module:

```bash
uv pip install --python .fastdeploy-venv/bin/python pip
```

TeXLens must not switch to another OCR backend automatically. If FastDeploy cannot run after reasonable setup attempts, stop and resolve the integration.

## Screenshot Does Not Work

v0.1 targets X11. On Wayland, import images/PDFs or switch to an X11 session. TeXLens uses ImageMagick `import` for region capture, so install ImageMagick if the environment check reports it missing.

## AppImage Window Is Blank

On some NVIDIA/WebKitGTK systems, DMABUF rendering can create a blank white window and
log GBM buffer errors. TeXLens sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` at startup to avoid
that path. If an older build still opens blank, launch it with:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./TeXLens_0.1.0_amd64.AppImage
```

## PDF Import Fails

Install the sidecar PDF extra:

```bash
uv sync --project sidecar --extra pdf
```

## PDF Preview Fails

Preview requires `xelatex` or `latexmk`. Recognition and `.tex` export still work without a TeX toolchain.

## LaTeX Compile Errors

Read the error summary shown under the right-side LaTeX body editor, edit the body directly, then run **Compile preview** again. Save TeX still writes a complete source file by wrapping the body with TeXLens' fixed internal template.
