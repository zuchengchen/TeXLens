from texlens_sidecar.config import Settings
from texlens_sidecar.fastdeploy import FastDeployManager, infer_block_type, parse_structured_response, prompt_for_mode
from texlens_sidecar.models import ServiceState


def test_prompt_uses_paddleocr_vl_native_task_words():
    assert prompt_for_mode("formula") == "Formula Recognition:"
    assert prompt_for_mode("table") == "Table Recognition:"
    assert prompt_for_mode("auto") == "OCR:"


def test_prompt_can_be_overridden_from_runtime_settings():
    assert prompt_for_mode("formula", {"formula": "Formula Recognition:\nReturn LaTeX only."}) == (
        "Formula Recognition:\nReturn LaTeX only."
    )


def test_native_formula_output_becomes_formula_block():
    parsed = parse_structured_response(r"\[\begin{aligned}a&=b\end{aligned}\]", {}, "auto")
    assert parsed["blocks"][0]["type"] == "formula"
    assert "latex_document" not in parsed


def test_auto_text_splits_title_and_formula_blocks():
    parsed = parse_structured_response("Complex derivation\n\nE &= mc^2\n\\int_0^\\infty e^{-x^2} dx &= y", {}, "auto")
    assert [block["type"] for block in parsed["blocks"]] == ["title", "formula"]


def test_auto_text_splits_title_and_pipe_table_blocks():
    parsed = parse_structured_response("Experiment Table\n\nMethod | Accuracy\nOCR-VL | 96.3", {}, "auto")
    assert [block["type"] for block in parsed["blocks"]] == ["title", "table"]


def test_mode_hint_sets_table_block():
    parsed = parse_structured_response("<fcel>A<fcel>B<nl>", {}, "table")
    assert parsed["blocks"][0]["type"] == "table"
    assert infer_block_type("<fcel>A<nl>", "auto") == "table"


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
