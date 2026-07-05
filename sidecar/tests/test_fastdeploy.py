from texlens_sidecar.config import Settings
from texlens_sidecar.fastdeploy import FastDeployManager, infer_content_type, ocr_prompt, parse_structured_response
from texlens_sidecar.models import ServiceState


def test_prompt_uses_paddleocr_vl_native_task_words():
    assert ocr_prompt() == "OCR:"


def test_native_formula_output_becomes_body_latex():
    parsed = parse_structured_response(r"\[\begin{aligned}a&=b\end{aligned}\]", {})
    assert "\\begin{equation}" in parsed["body"]
    assert "\\begin{aligned}" in parsed["body"]
    assert "latex_document" not in parsed


def test_dollar_display_formula_output_becomes_body_latex():
    parsed = parse_structured_response("$$E=mc^2$$", {})
    assert "\\begin{equation}\nE=mc^2\n\\end{equation}" in parsed["body"]


def test_auto_text_splits_title_and_formula_body():
    parsed = parse_structured_response("Complex derivation\n\nE &= mc^2\n\\int_0^\\infty e^{-x^2} dx &= y", {})
    assert "\\section*{Complex derivation}" in parsed["body"]
    assert "\\begin{equation}" in parsed["body"]


def test_auto_text_splits_title_and_pipe_table_body():
    parsed = parse_structured_response("Experiment Table\n\nMethod | Accuracy\nOCR-VL | 96.3", {})
    assert "\\section*{Experiment Table}" in parsed["body"]
    assert "\\begin{tabular}" in parsed["body"]


def test_table_tokens_infer_table_content():
    parsed = parse_structured_response("<fcel>A<fcel>B<nl>", {})
    assert "\\begin{tabular}" in parsed["body"]
    assert infer_content_type("<fcel>A<nl>") == "table"


def test_fastdeploy_process_uses_writable_runtime_cwd(tmp_path, monkeypatch):
    settings = Settings(
        cache_dir=tmp_path / "cache",
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "model",
        fastdeploy_python="/usr/bin/python",
    )
    manager = FastDeployManager(settings)
    captured = {}

    class FakeProcess:
        pid = 123

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return FakeProcess()

    monkeypatch.setattr("texlens_sidecar.fastdeploy.subprocess.Popen", fake_popen)
    monkeypatch.setattr(
        manager,
        "status",
        lambda: ServiceState(running=True, pid=123, endpoint=settings.fastdeploy_endpoint, healthy=False),
    )

    manager.start()

    assert captured["cwd"] == str(settings.cache_dir / "fastdeploy-runtime")
    assert (settings.cache_dir / "fastdeploy-runtime").is_dir()


def test_fastdeploy_start_reuses_reachable_existing_service(tmp_path, monkeypatch):
    settings = Settings(
        cache_dir=tmp_path / "cache",
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "model",
        fastdeploy_python="/usr/bin/python",
    )
    manager = FastDeployManager(settings)
    existing = ServiceState(running=True, pid=None, endpoint=settings.fastdeploy_endpoint, healthy=True)

    monkeypatch.setattr(manager, "status", lambda: existing)
    monkeypatch.setattr(
        "texlens_sidecar.fastdeploy.subprocess.Popen",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not spawn")),
    )

    assert manager.start() == existing
