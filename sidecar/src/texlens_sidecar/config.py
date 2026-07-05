from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def xdg_config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "texlens"


def xdg_data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "texlens"


def xdg_cache_home() -> Path:
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "texlens"


def default_fastdeploy_python() -> str:
    local_python = Path.cwd() / ".fastdeploy-venv" / "bin" / "python"
    if local_python.exists():
        return str(local_python)
    return os.environ.get("TEXLENS_FASTDEPLOY_PYTHON", "python")


DEFAULT_FASTDEPLOY_ARGS = [
    "--max-model-len",
    "8192",
    "--max-num-batched-tokens",
    "8192",
    "--gpu-memory-utilization",
    "0.6",
    "--max-num-seqs",
    "8",
]

DEFAULT_HOTKEY = "Ctrl+Alt+M"
DEFAULT_CLEANUP_POLICY = "history_ttl"
DEFAULT_LATEX_TEMPLATE = "\n".join(
    [
        r"\documentclass[UTF8]{ctexart}",
        r"\usepackage{amsmath,amssymb}",
        r"\usepackage{booktabs,longtable,array,graphicx}",
        r"\usepackage[margin=2.5cm]{geometry}",
        r"\title{{title}}",
        r"\date{}",
        r"\begin{document}",
        r"\maketitle",
        "",
        "{body}",
        "",
        r"\end{document}",
        "",
    ]
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TEXLENS_", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8765
    data_dir: Path = Field(default_factory=xdg_data_home)
    cache_dir: Path = Field(default_factory=xdg_cache_home)
    config_dir: Path = Field(default_factory=xdg_config_home)
    model_dir: Path = Field(default_factory=lambda: xdg_cache_home() / "models" / "PaddleOCR-VL-1.6")
    fastdeploy_host: str = "127.0.0.1"
    fastdeploy_port: int = 8185
    fastdeploy_metrics_port: int = 8186
    fastdeploy_engine_worker_queue_port: int = 8187
    fastdeploy_model: str = "PaddlePaddle/PaddleOCR-VL"
    fastdeploy_python: str = Field(default_factory=default_fastdeploy_python)
    fastdeploy_args: List[str] = Field(default_factory=lambda: DEFAULT_FASTDEPLOY_ARGS.copy())
    history_days: int = 30
    cleanup_policy: str = DEFAULT_CLEANUP_POLICY
    hotkey: str = DEFAULT_HOTKEY
    request_timeout_seconds: float = 300.0
    latex_engine: str = "xelatex"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "texlens.sqlite3"

    @property
    def history_dir(self) -> Path:
        return self.data_dir / "history"

    @property
    def thumbnail_dir(self) -> Path:
        return self.cache_dir / "thumbnails"

    @property
    def export_dir(self) -> Path:
        return self.data_dir / "exports"

    @property
    def fastdeploy_endpoint(self) -> str:
        return f"http://{self.fastdeploy_host}:{self.fastdeploy_port}"

    def ensure_dirs(self) -> None:
        for path in [
            self.data_dir,
            self.cache_dir,
            self.config_dir,
            self.model_dir,
            self.history_dir,
            self.thumbnail_dir,
            self.export_dir,
        ]:
            path.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    return settings
