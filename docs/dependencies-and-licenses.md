# Dependencies And Licenses

TeXLens is MIT licensed.

Primary components:

- Tauri v2: desktop shell.
- React, TypeScript, Vite: UI.
- Monaco Editor: LaTeX editing and diff workflows.
- Python FastAPI sidecar: local service layer.
- PaddleOCR-VL-1.6: OCR/document VLM model.
- FastDeploy: local inference service.
- SQLite: local metadata and FTS history.

PaddleOCR-VL-1.6 and FastDeploy licensing, model-card constraints, CUDA/Paddle compatibility, and redistribution rights must be checked before commercial or bundled distribution. v0.1 is scoped to personal/research use.

