import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from texlens_sidecar.app import (
    apply_runtime_update,
    apply_saved_runtime_settings,
    create_app,
    python_module_status,
    render_pdf_preview_pages,
    save_runtime_settings,
    summarize_latex_errors,
)
from texlens_sidecar.config import Settings
from texlens_sidecar.models import OCRTaskPage, OCRTaskState, RuntimeSettingsUpdate


def test_python_module_status_detects_available_module():
    status = python_module_status(sys.executable, ["json", "module_that_should_not_exist_texlens"])
    assert status["json"] is True
    assert status["module_that_should_not_exist_texlens"] is False


def test_summarize_latex_errors_keeps_actionable_error_context():
    stdout = "\n".join(
        [
            "This is XeTeX",
            "! LaTeX Error: Bad math environment delimiter.",
            "See the LaTeX manual or LaTeX Companion for explanation.",
            "l.12 \\]",
        ]
    )
    stderr = "Latexmk: Sometimes, the -f option can be used to get latexmk to try to force complete processing."

    summary = summarize_latex_errors(stdout, stderr)

    assert "Bad math environment delimiter" in summary
    assert "l.12" in summary
    assert "Sometimes, the -f option" not in summary


def test_render_pdf_preview_pages_returns_all_sorted_pages(tmp_path, monkeypatch):
    monkeypatch.setattr("texlens_sidecar.app.shutil.which", lambda command: "/usr/bin/pdftoppm")

    def fake_run(command, **kwargs):
        output_base = Path(command[-1])
        (output_base.parent / f"{output_base.name}-2.png").write_bytes(b"page2")
        (output_base.parent / f"{output_base.name}-1.png").write_bytes(b"page1")
        return None

    monkeypatch.setattr("texlens_sidecar.app.subprocess.run", fake_run)
    output_base = tmp_path / "preview"
    (tmp_path / "preview-9.png").write_bytes(b"stale")

    pages = render_pdf_preview_pages(tmp_path / "document.pdf", output_base)

    assert [page.name for page in pages] == ["preview-1.png", "preview-2.png"]
    assert not (tmp_path / "preview-9.png").exists()


def test_runtime_settings_persist_to_config_dir(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    apply_runtime_update(
        settings,
        RuntimeSettingsUpdate(
            fastdeploy_args=["--gpu-memory-utilization", "0.5"],
            history_days=7,
            cleanup_policy="manual_only",
            hotkey="Ctrl+Shift+M",
            latex_engine="lualatex",
        ),
    )
    save_runtime_settings(settings)

    reloaded = Settings(
        data_dir=tmp_path / "data2",
        cache_dir=tmp_path / "cache2",
        config_dir=tmp_path / "config",
    )
    apply_saved_runtime_settings(reloaded)

    assert reloaded.fastdeploy_args == ["--gpu-memory-utilization", "0.5"]
    assert reloaded.history_days == 7
    assert reloaded.cleanup_policy == "manual_only"
    assert reloaded.hotkey == "Ctrl+Shift+M"
    assert reloaded.latex_engine == "lualatex"


def test_pdf_task_rejects_missing_or_non_pdf_input(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    client = TestClient(create_app(settings))

    missing = client.post("/ocr/tasks/pdf", json={"path": str(tmp_path / "missing.pdf")})
    assert missing.status_code == 404

    image = tmp_path / "page.png"
    image.write_bytes(b"not a pdf")
    non_pdf = client.post("/ocr/tasks/pdf", json={"path": str(image)})
    assert non_pdf.status_code == 400


def test_retry_failed_pdf_task_returns_retrying_before_background_work(tmp_path, monkeypatch):
    scheduled = []

    def fake_create_task(coro):
        scheduled.append(coro)
        coro.close()
        return None

    monkeypatch.setattr("texlens_sidecar.app.asyncio.create_task", fake_create_task)
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    app = create_app(settings)
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4\n")
    now = datetime.now(timezone.utc)
    task = OCRTaskState(
        id="task-1",
        source_path=str(source),
        title="paper",
        status="completed_with_errors",
        pages=[OCRTaskPage(page=1, status="failed", error="boom")],
        failed_pages=[OCRTaskPage(page=1, status="failed", error="boom")],
        created_at=now,
        updated_at=now,
    )
    app.state.ocr_tasks[task.id] = task

    response = TestClient(app).post(f"/ocr/tasks/{task.id}/retry-failed")

    assert response.status_code == 200
    assert response.json()["status"] == "retrying"
    assert response.json()["cancel_requested"] is False
    assert scheduled
