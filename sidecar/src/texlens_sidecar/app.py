from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import snapshot_download

from .config import Settings, get_settings
from .fastdeploy import FastDeployManager, FastDeployUnavailable, collect_gpu_metrics
from .latex import normalize_latex_document
from .models import (
    LatexCompileRequest,
    OCRRequest,
    OCRTaskPage,
    OCRTaskRequest,
    OCRTaskState,
    ObservabilitySnapshot,
    RuntimeSettings,
    RuntimeSettingsUpdate,
    ServiceState,
)
from .ocr import OCRProcessor
from .storage import Storage


def summarize_latex_errors(stdout: str, stderr: str, limit: int = 5000) -> str:
    combined_lines = (stdout + "\n" + stderr).splitlines()
    interesting = []
    generic_latexmk_patterns = [
        r"Latexmk: Sometimes, the -f option",
        r"Latexmk: Using bibtex",
        r"But normally, you will need to correct",
        r"clean out generated files before rerunning",
    ]
    patterns = [
        r"^!",
        r"^l\.\d+",
        r"LaTeX Error",
        r"Package .* Error",
        r"Undefined control sequence",
        r"Missing \$ inserted",
        r"Runaway argument",
        r"Emergency stop",
        r"Misplaced alignment tab",
        r"Extra alignment tab",
        r"File .* not found",
    ]
    for index, line in enumerate(combined_lines):
        if any(re.search(pattern, line) for pattern in patterns):
            start = max(0, index - 2)
            end = min(len(combined_lines), index + 4)
            interesting.extend(
                item
                for item in combined_lines[start:end]
                if not any(re.search(pattern, item) for pattern in generic_latexmk_patterns)
            )
            interesting.append("")

    summary = "\n".join(interesting).strip()
    if not summary:
        summary = "\n".join(
            line
            for line in combined_lines
            if line.strip() and not any(re.search(pattern, line) for pattern in generic_latexmk_patterns)
        ).strip()
    return summary[-limit:]


def render_pdf_preview_pages(pdf_path: Path, output_base: Path) -> List[Path]:
    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        return []
    for stale in output_base.parent.glob(f"{output_base.name}*.png"):
        stale.unlink()
    try:
        subprocess.run(
            [pdftoppm, "-png", "-r", "160", "-f", "1", str(pdf_path), str(output_base)],
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    pages = list(output_base.parent.glob(f"{output_base.name}-*.png"))
    pages.sort(key=pdf_preview_page_number)
    return pages


def render_pdf_preview(pdf_path: Path, output_base: Path) -> Optional[Path]:
    pages = render_pdf_preview_pages(pdf_path, output_base)
    return pages[0] if pages else None


def pdf_preview_page_number(path: Path) -> int:
    try:
        return int(path.stem.rsplit("-", 1)[-1])
    except ValueError:
        return 0


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()
    apply_saved_runtime_settings(settings)
    storage = Storage(settings)
    manager = FastDeployManager(settings)
    from .fastdeploy import FastDeployClient

    processor = OCRProcessor(settings, storage, FastDeployClient(settings, manager))
    request_durations: List[float] = []
    recent_errors: List[str] = []
    queue = asyncio.Semaphore(1)
    tasks: Dict[str, OCRTaskState] = {}
    task_page_bodies: Dict[str, Dict[int, str]] = {}

    app = FastAPI(title="TeXLens Sidecar", version="0.1.0")
    app.state.ocr_tasks = tasks
    app.state.ocr_task_page_bodies = task_page_bodies
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:1420", "tauri://localhost"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def record_error(exc: Exception) -> None:
        recent_errors.append(str(exc))
        del recent_errors[:-20]

    def touch_task(task: OCRTaskState) -> None:
        task.updated_at = datetime.now(timezone.utc)
        task.completed_pages = len([page for page in task.pages if page.status == "completed"])
        task.failed_pages = [page for page in task.pages if page.status == "failed"]

    def task_page(task: OCRTaskState, page_number: int) -> OCRTaskPage:
        for page in task.pages:
            if page.page == page_number:
                return page
        page = OCRTaskPage(page=page_number)
        task.pages.append(page)
        return page

    def is_task_running(task: OCRTaskState) -> bool:
        return task.status in {"pending", "rendering", "running", "retrying", "cancel_requested"}

    async def run_pdf_task(task_id: str, request: OCRTaskRequest) -> None:
        task = tasks[task_id]
        path = Path(request.path).expanduser()
        start = time.perf_counter()
        page_bodies = task_page_bodies.setdefault(task_id, {})
        raw_pages: List[dict] = []
        original_copy: Optional[str] = None
        document_id: Optional[str] = None
        try:
            task.status = "rendering"
            touch_task(task)
            document_id, original_copy, rendered_pages = await asyncio.to_thread(processor.begin_pdf, path)
            task.document_id = document_id
            task.total_pages = len(rendered_pages)
            task.pages = [
                OCRTaskPage(page=index, status="pending", image_path=str(image_path))
                for index, image_path in enumerate(rendered_pages, start=1)
            ]
            task.status = "running"
            touch_task(task)

            for page_number, image_path in enumerate(rendered_pages, start=1):
                if task.cancel_requested:
                    task.status = "cancelled"
                    break
                page = task_page(task, page_number)
                page.status = "running"
                page.error = None
                task.current_page = page_number
                touch_task(task)
                page_start = time.perf_counter()
                try:
                    async with queue:
                        page_body, raw = await asyncio.to_thread(
                            processor.recognize_pdf_page,
                            image_path,
                            page_number,
                        )
                    page_bodies[page_number] = page_body[1]
                    raw_pages.append({"page": page_number, "raw_text": raw.get("raw_text", "")})
                    page.status = "completed"
                    page.duration_ms = round((time.perf_counter() - page_start) * 1000, 2)
                except Exception as exc:
                    page.status = "failed"
                    page.error = str(exc)
                    page.duration_ms = round((time.perf_counter() - page_start) * 1000, 2)
                    raw_pages.append({"page": page_number, "error": str(exc)})
                    record_error(exc)
                touch_task(task)

            if task.status != "cancelled":
                task.status = "completed_with_errors" if task.failed_pages else "completed"
            if page_bodies or task.failed_pages:
                document = await asyncio.to_thread(
                    processor.save_pdf_document,
                    document_id,
                    path,
                    request.title,
                    original_copy,
                    sorted(page_bodies.items()),
                    sorted(raw_pages, key=lambda item: item.get("page", 0)),
                    start,
                    [page.model_dump(mode="json") for page in task.failed_pages],
                    task.status,
                )
                task.document_id = document.id
                task.document = document
                request_durations.append(document.metrics.get("duration_ms", 0))
                del request_durations[:-100]
        except Exception as exc:
            task.status = "failed"
            task.error = str(exc)
            record_error(exc)
        finally:
            task.current_page = None
            touch_task(task)

    async def retry_failed_pdf_pages(task_id: str) -> None:
        task = tasks[task_id]
        try:
            failed_pages = [page for page in task.pages if page.status == "failed"]
            if not failed_pages:
                touch_task(task)
                return
            path = Path(task.source_path).expanduser()
            start = time.perf_counter()
            document_id = task.document_id or str(uuid.uuid4())
            original_copy = task.document.original_copy_path if task.document else None
            page_bodies = task_page_bodies.setdefault(task_id, {})
            raw_pages_by_number: Dict[int, dict] = {}
            if task.document:
                for index, item in enumerate(task.document.raw.get("pages", []), start=1):
                    if isinstance(item, dict):
                        raw_pages_by_number[int(item.get("page", index))] = item
            task.status = "retrying"
            task.cancel_requested = False
            touch_task(task)
            for page in failed_pages:
                if task.cancel_requested:
                    task.status = "cancelled"
                    break
                if not page.image_path:
                    page.error = "Rendered page image is missing."
                    continue
                page.status = "running"
                page.error = None
                task.current_page = page.page
                touch_task(task)
                page_start = time.perf_counter()
                try:
                    async with queue:
                        page_body, raw = await asyncio.to_thread(
                            processor.recognize_pdf_page,
                            Path(page.image_path),
                            page.page,
                        )
                    page_bodies[page.page] = page_body[1]
                    raw_pages_by_number[page.page] = {"page": page.page, "raw_text": raw.get("raw_text", "")}
                    page.status = "completed"
                    page.duration_ms = round((time.perf_counter() - page_start) * 1000, 2)
                except Exception as exc:
                    page.status = "failed"
                    page.error = str(exc)
                    page.duration_ms = round((time.perf_counter() - page_start) * 1000, 2)
                    raw_pages_by_number[page.page] = {"page": page.page, "error": str(exc)}
                    record_error(exc)
                touch_task(task)
            if task.status != "cancelled":
                task.status = "completed_with_errors" if task.failed_pages else "completed"
            if page_bodies or task.failed_pages:
                document = await asyncio.to_thread(
                    processor.save_pdf_document,
                    document_id,
                    path,
                    task.title,
                    original_copy,
                    sorted(page_bodies.items()),
                    [raw_pages_by_number[key] for key in sorted(raw_pages_by_number)],
                    start,
                    [page.model_dump(mode="json") for page in task.failed_pages],
                    task.status,
                )
                task.document_id = document.id
                task.document = document
                request_durations.append(document.metrics.get("duration_ms", 0))
                del request_durations[:-100]
        except Exception as exc:
            task.status = "failed"
            task.error = str(exc)
            record_error(exc)
        finally:
            task.current_page = None
            touch_task(task)

    @app.get("/health")
    def health() -> Dict[str, object]:
        return {
            "ok": True,
            "settings": {
                "data_dir": str(settings.data_dir),
                "cache_dir": str(settings.cache_dir),
                "model_dir": str(settings.model_dir),
                "fastdeploy_endpoint": settings.fastdeploy_endpoint,
            },
        }

    @app.get("/environment")
    def environment() -> Dict[str, object]:
        tools = {}
        for name in ["python", "uv", "nvidia-smi", "xelatex", "latexmk"]:
            tools[name] = shutil.which(name)
        return {
            "tools": tools,
            "gpu": [metric.model_dump(mode="json") for metric in collect_gpu_metrics()],
            "paths": {
                "data_dir": str(settings.data_dir),
                "cache_dir": str(settings.cache_dir),
                "config_dir": str(settings.config_dir),
                "model_dir": str(settings.model_dir),
                "fastdeploy_python": settings.fastdeploy_python,
            },
            "fastdeploy_python_modules": python_module_status(
                settings.fastdeploy_python, ["pip", "fastdeploy", "paddle", "paddleformers"]
            ),
        }

    @app.get("/settings", response_model=RuntimeSettings)
    def read_settings() -> RuntimeSettings:
        return runtime_settings(settings)

    @app.put("/settings", response_model=RuntimeSettings)
    def write_settings(update: RuntimeSettingsUpdate) -> RuntimeSettings:
        apply_runtime_update(settings, update)
        save_runtime_settings(settings)
        return runtime_settings(settings)

    @app.get("/models/check")
    def model_check() -> Dict[str, object]:
        files = list(settings.model_dir.glob("**/*")) if settings.model_dir.exists() else []
        return {
            "model_dir": str(settings.model_dir),
            "exists": settings.model_dir.exists(),
            "file_count": len([path for path in files if path.is_file()]),
            "size_bytes": sum(path.stat().st_size for path in files if path.is_file()),
        }

    @app.post("/models/download")
    def model_download() -> Dict[str, object]:
        try:
            target = snapshot_download(
                repo_id="PaddlePaddle/PaddleOCR-VL-1.6",
                local_dir=str(settings.model_dir),
                local_dir_use_symlinks=False,
            )
            return {"ok": True, "model_dir": target}
        except Exception as exc:
            record_error(exc)
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/fastdeploy/start", response_model=ServiceState)
    def fastdeploy_start() -> ServiceState:
        try:
            return manager.start()
        except Exception as exc:
            record_error(exc)
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/fastdeploy/stop", response_model=ServiceState)
    def fastdeploy_stop() -> ServiceState:
        return manager.stop()

    @app.post("/fastdeploy/reload", response_model=ServiceState)
    def fastdeploy_reload() -> ServiceState:
        try:
            return manager.reload()
        except Exception as exc:
            record_error(exc)
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.get("/fastdeploy/status", response_model=ServiceState)
    def fastdeploy_status() -> ServiceState:
        return manager.status()

    @app.get("/fastdeploy/logs")
    def fastdeploy_logs() -> Dict[str, str]:
        return {"log": manager.recent_log()}

    @app.post("/ocr/recognize")
    async def recognize(request: OCRRequest):
        async with queue:
            try:
                document = await asyncio.to_thread(processor.recognize, request)
                request_durations.append(document.metrics.get("duration_ms", 0))
                del request_durations[:-100]
                return document
            except FastDeployUnavailable as exc:
                record_error(exc)
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            except Exception as exc:
                record_error(exc)
                raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/ocr/upload")
    async def upload(file: UploadFile):
        suffix = Path(file.filename or "upload.png").suffix or ".png"
        target = settings.cache_dir / "uploads" / f"{Path(file.filename or 'upload').stem}{suffix}"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(await file.read())
        return await recognize(OCRRequest(path=str(target), source_type="pdf" if suffix.lower() == ".pdf" else "image"))

    @app.post("/ocr/tasks/pdf", response_model=OCRTaskState)
    async def start_pdf_task(request: OCRTaskRequest) -> OCRTaskState:
        path = Path(request.path).expanduser()
        if not path.exists():
            raise HTTPException(status_code=404, detail=str(path))
        if path.suffix.lower() != ".pdf":
            raise HTTPException(status_code=400, detail="PDF task input must be a .pdf file.")
        task_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        task = OCRTaskState(
            id=task_id,
            source_path=str(path),
            title=request.title or path.stem,
            created_at=now,
            updated_at=now,
        )
        tasks[task_id] = task
        asyncio.create_task(run_pdf_task(task_id, request))
        return task

    @app.get("/ocr/tasks/{task_id}", response_model=OCRTaskState)
    def get_task(task_id: str) -> OCRTaskState:
        if task_id not in tasks:
            raise HTTPException(status_code=404, detail=task_id)
        return tasks[task_id]

    @app.post("/ocr/tasks/{task_id}/cancel", response_model=OCRTaskState)
    def cancel_task(task_id: str) -> OCRTaskState:
        if task_id not in tasks:
            raise HTTPException(status_code=404, detail=task_id)
        task = tasks[task_id]
        if task.status in {"completed", "completed_with_errors", "failed", "cancelled"}:
            return task
        task.cancel_requested = True
        task.status = "cancel_requested"
        touch_task(task)
        return task

    @app.post("/ocr/tasks/{task_id}/retry-failed", response_model=OCRTaskState)
    async def retry_failed_task(task_id: str) -> OCRTaskState:
        if task_id not in tasks:
            raise HTTPException(status_code=404, detail=task_id)
        task = tasks[task_id]
        if is_task_running(task):
            raise HTTPException(status_code=409, detail="Task is still running.")
        if not task.failed_pages:
            return task
        task.status = "retrying"
        task.cancel_requested = False
        task.error = None
        task.current_page = None
        touch_task(task)
        asyncio.create_task(retry_failed_pdf_pages(task_id))
        return task

    @app.get("/history")
    def history(q: str = "", limit: int = 50):
        return storage.list_documents(q, limit)

    @app.get("/history/{document_id}")
    def history_detail(document_id: str):
        try:
            return storage.get_document(document_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=document_id) from exc

    @app.delete("/history")
    def clear_history() -> Dict[str, int]:
        return {"deleted": storage.clear_history()}

    @app.post("/history/prune")
    def prune_history() -> Dict[str, int]:
        if settings.cleanup_policy == "manual_only":
            return {"deleted": 0}
        return {"deleted": storage.prune_expired()}

    @app.post("/latex/compile")
    def compile_latex(request: LatexCompileRequest) -> Dict[str, object]:
        engine = shutil.which("latexmk") or shutil.which(settings.latex_engine)
        if not engine:
            raise HTTPException(status_code=424, detail="No latexmk/xelatex toolchain found.")
        with tempfile.TemporaryDirectory(prefix="texlens-latex-") as tmp:
            tmp_path = Path(tmp)
            tex_path = tmp_path / "document.tex"
            tex_path.write_text(normalize_latex_document(request.latex), encoding="utf-8")
            if Path(engine).name == "latexmk":
                command = [engine, "-xelatex", "-interaction=nonstopmode", "-halt-on-error", "document.tex"]
            else:
                command = [engine, "-interaction=nonstopmode", "-halt-on-error", "document.tex"]
            proc = subprocess.run(command, cwd=tmp, text=True, capture_output=True, timeout=120)
            pdf_path = tmp_path / "document.pdf"
            exported = None
            preview_images: List[Path] = []
            if pdf_path.exists():
                exported = settings.export_dir / "preview.pdf"
                shutil.copy2(pdf_path, exported)
                preview_images = render_pdf_preview_pages(exported, settings.export_dir / "preview")
            return {
                "ok": proc.returncode == 0,
                "returncode": proc.returncode,
                "stdout": proc.stdout[-12000:],
                "stderr": proc.stderr[-12000:],
                "error_summary": "" if proc.returncode == 0 else summarize_latex_errors(proc.stdout, proc.stderr),
                "pdf_path": str(exported) if exported else None,
                "preview_image_path": str(preview_images[0]) if preview_images else None,
                "preview_image_paths": [str(path) for path in preview_images],
            }

    @app.get("/observability", response_model=ObservabilitySnapshot)
    def observability() -> ObservabilitySnapshot:
        service = manager.status()
        return ObservabilitySnapshot(
            service=service,
            gpu=collect_gpu_metrics(),
            queue_depth=max(0, 1 - queue._value),
            cache={
                "model_dir": str(settings.model_dir),
                "history_dir": str(settings.history_dir),
                "metrics": storage.recent_metrics(20),
                "tasks": [
                    {
                        "id": task.id,
                        "status": task.status,
                        "source_path": task.source_path,
                        "completed_pages": task.completed_pages,
                        "total_pages": task.total_pages,
                        "failed_pages": len(task.failed_pages),
                    }
                    for task in list(tasks.values())[-20:]
                ],
            },
            recent_errors=recent_errors[-20:],
            request_durations_ms=request_durations[-100:],
        )

    return app


def python_module_status(python: str, modules: List[str]) -> Dict[str, bool]:
    script = (
        "import importlib.util, json; "
        f"mods = {modules!r}; "
        "print(json.dumps({name: importlib.util.find_spec(name) is not None for name in mods}))"
    )
    try:
        result = subprocess.run(
            [python, "-c", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return {name: False for name in modules}
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {name: False for name in modules}
    return {name: bool(parsed.get(name)) for name in modules}


def runtime_settings(settings: Settings) -> RuntimeSettings:
    return RuntimeSettings(
        model_dir=str(settings.model_dir),
        fastdeploy_python=settings.fastdeploy_python,
        fastdeploy_args=settings.fastdeploy_args,
        history_days=settings.history_days,
        cleanup_policy=settings.cleanup_policy,
        hotkey=settings.hotkey,
        latex_engine=settings.latex_engine,
    )


def apply_saved_runtime_settings(settings: Settings) -> None:
    path = runtime_settings_path(settings)
    if not path.exists():
        return
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        update = RuntimeSettingsUpdate.model_validate(payload)
    except Exception:
        return
    apply_runtime_update(settings, update)


def apply_runtime_update(settings: Settings, update: RuntimeSettingsUpdate) -> None:
    if update.model_dir:
        settings.model_dir = Path(update.model_dir).expanduser()
    if update.fastdeploy_python:
        settings.fastdeploy_python = update.fastdeploy_python
    if update.fastdeploy_args is not None:
        settings.fastdeploy_args = [arg for arg in update.fastdeploy_args if arg.strip()]
    if update.history_days is not None and update.history_days > 0:
        settings.history_days = update.history_days
    if update.cleanup_policy:
        settings.cleanup_policy = update.cleanup_policy
    if update.hotkey:
        settings.hotkey = update.hotkey
    if update.latex_engine:
        settings.latex_engine = update.latex_engine
    settings.ensure_dirs()


def save_runtime_settings(settings: Settings) -> None:
    path = runtime_settings_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(runtime_settings(settings).model_dump_json(indent=2), encoding="utf-8")


def runtime_settings_path(settings: Settings) -> Path:
    return settings.config_dir / "settings.json"


app = create_app()
