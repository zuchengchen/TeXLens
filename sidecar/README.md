# TeXLens Sidecar

The sidecar owns local service management, FastDeploy calls, OCR task orchestration,
history persistence, LaTeX generation, repair, benchmark reporting, and diagnostics.

It intentionally does not implement a non-FastDeploy OCR fallback. If the FastDeploy
PaddleOCR-VL service is unavailable, OCR endpoints return a service readiness error.

```bash
uv run --project sidecar texlens-sidecar
```

