from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from .config import Settings
from .models import GpuMetric, ServiceState


class FastDeployUnavailable(RuntimeError):
    pass


class FastDeployManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.process: Optional[subprocess.Popen[str]] = None
        self.last_error: Optional[str] = None
        self.log_path = self.settings.cache_dir / "fastdeploy.log"
        self.runtime_dir = self.settings.cache_dir / "fastdeploy-runtime"

    @property
    def endpoint(self) -> str:
        return self.settings.fastdeploy_endpoint

    def launch_command(self) -> List[str]:
        return [
            self.settings.fastdeploy_python,
            "-m",
            "fastdeploy.entrypoints.openai.api_server",
            "--model",
            str(self.settings.model_dir if self.settings.model_dir.exists() else self.settings.fastdeploy_model),
            "--host",
            self.settings.fastdeploy_host,
            "--port",
            str(self.settings.fastdeploy_port),
            "--metrics-port",
            str(self.settings.fastdeploy_metrics_port),
            "--engine-worker-queue-port",
            str(self.settings.fastdeploy_engine_worker_queue_port),
            *self.settings.fastdeploy_args,
        ]

    def start(self) -> ServiceState:
        if self.process and self.process.poll() is None:
            return self.status()
        self.settings.ensure_dirs()
        command = self.launch_command()
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        log = self.log_path.open("a", encoding="utf-8")
        log.write("\n\n=== TeXLens FastDeploy start " + datetime.now(timezone.utc).isoformat() + " ===\n")
        log.write(" ".join(command) + "\n")
        log.write(f"cwd={self.runtime_dir}\n")
        log.flush()
        try:
            self.process = subprocess.Popen(
                command,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                cwd=str(self.runtime_dir),
            )
            self.last_error = None
        except Exception as exc:
            self.last_error = str(exc)
            raise FastDeployUnavailable(f"Failed to start FastDeploy: {exc}") from exc
        return self.status()

    def stop(self) -> ServiceState:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self.process = None
        return self.status()

    def reload(self) -> ServiceState:
        self.stop()
        return self.start()

    def status(self) -> ServiceState:
        running = bool(self.process and self.process.poll() is None)
        healthy = False
        raw_status: Dict[str, Any] = {}
        try:
            with httpx.Client(timeout=3.0) as client:
                response = client.get(f"{self.endpoint}/v1/models")
                healthy = response.status_code < 500
                raw_status = {"status_code": response.status_code}
                if response.headers.get("content-type", "").startswith("application/json"):
                    raw_status["body"] = response.json()
        except Exception as exc:
            raw_status = {"error": str(exc)}
        return ServiceState(
            running=running,
            pid=self.process.pid if running and self.process else None,
            endpoint=self.endpoint,
            healthy=healthy,
            last_error=self.last_error,
            raw_status=raw_status,
        )

    def ensure_ready(self) -> None:
        state = self.status()
        if not state.healthy:
            raise FastDeployUnavailable(
                "FastDeploy PaddleOCR-VL service is not healthy. Start it from TeXLens "
                "service management or install/configure FastDeploy before OCR."
            )

    def recent_log(self, max_bytes: int = 12000) -> str:
        if not self.log_path.exists():
            return ""
        data = self.log_path.read_bytes()
        return data[-max_bytes:].decode("utf-8", errors="replace")


class FastDeployClient:
    def __init__(self, settings: Settings, manager: FastDeployManager):
        self.settings = settings
        self.manager = manager

    def recognize_image(self, image_path: Path, mode: str = "auto") -> Dict[str, Any]:
        self.manager.ensure_ready()
        image_bytes = image_path.read_bytes()
        mime = "image/png" if image_path.suffix.lower() == ".png" else "image/jpeg"
        encoded = base64.b64encode(image_bytes).decode("ascii")
        prompt = prompt_for_mode(mode, self.settings.prompt_templates)
        payload = {
            "model": str(self.settings.model_dir if self.settings.model_dir.exists() else self.settings.fastdeploy_model),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{encoded}"},
                        },
                    ],
                }
            ],
            "temperature": 0.0,
            "max_tokens": 4096,
        }
        with httpx.Client(timeout=self.settings.request_timeout_seconds) as client:
            response = client.post(f"{self.manager.endpoint}/v1/chat/completions", json=payload)
            response.raise_for_status()
            data = response.json()
        content = extract_message_content(data)
        return parse_structured_response(content, data, mode)


def prompt_for_mode(mode: str, templates: Optional[Dict[str, str]] = None) -> str:
    if templates and templates.get(mode):
        return str(templates[mode])
    return {
        "formula": "Formula Recognition:",
        "table": "Table Recognition:",
        "text": "OCR:",
        "auto": "OCR:",
    }.get(mode, "OCR:")


def extract_message_content(data: Dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content", "")
    if isinstance(content, list):
        return "\n".join(str(item.get("text", item)) for item in content)
    return str(content)


def parse_structured_response(content: str, raw: Dict[str, Any], mode: str = "auto") -> Dict[str, Any]:
    stripped = content.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?", "", stripped).strip()
        stripped = re.sub(r"```$", "", stripped).strip()
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            parsed.setdefault("raw_text", content)
            parsed.setdefault("raw_response", raw)
            return parsed
    except json.JSONDecodeError:
        pass
    return {
        "title": "TeXLens OCR Document",
        "blocks": plain_blocks_from_content(stripped, mode),
        "raw_text": content,
        "raw_response": raw,
    }


def plain_blocks_from_content(content: str, mode: str) -> List[Dict[str, Any]]:
    if mode in {"formula", "table", "text"}:
        block_type = infer_block_type(content, mode)
        return [plain_block("b1", block_type, content)]

    chunks = [chunk.strip() for chunk in re.split(r"\n\s*\n", content) if chunk.strip()]
    if not chunks:
        return [plain_block("b1", "paragraph", content)]

    blocks: List[Dict[str, Any]] = []
    for index, chunk in enumerate(chunks, start=1):
        block_type = infer_block_type(chunk, mode)
        if block_type == "paragraph" and index == 1 and is_likely_title(chunk):
            block_type = "title"
        blocks.append(plain_block(f"b{index}", block_type, chunk))
    return blocks


def plain_block(block_id: str, block_type: str, content: str) -> Dict[str, Any]:
    return {
        "id": block_id,
        "type": block_type,
        "bbox": [0, 0, 1, 1],
        "text": content,
        "latex": content,
        "confidence": None,
    }


def infer_block_type(content: str, mode: str) -> str:
    if mode in {"formula", "table", "text"}:
        return "paragraph" if mode == "text" else mode
    if re.search(r"<(?:fcel|ecel|ucel|lcel|xcel)>|<nl>", content) or looks_like_pipe_table(content):
        return "table"
    if looks_like_formula(content):
        return "formula"
    return "paragraph"


def looks_like_pipe_table(content: str) -> bool:
    rows = [
        line.strip()
        for line in content.splitlines()
        if "|" in line and len([part for part in line.strip("|").split("|") if part.strip()]) >= 2
    ]
    return len(rows) >= 2


def looks_like_formula(content: str) -> bool:
    stripped = content.strip()
    return bool(
        re.search(r"\\begin\{(?:aligned|align\*?|array|equation\*?)\}|^\\\[", stripped)
        or re.search(r"(^|\n)\s*[^|\n]{0,80}&=", stripped)
        or re.search(r"\\(?:frac|int|sum|prod|sqrt|lim|alpha|beta|gamma|theta|infty)\b", stripped)
    )


def is_likely_title(content: str) -> bool:
    stripped = content.strip()
    return "\n" not in stripped and 0 < len(stripped) <= 80 and not looks_like_formula(stripped)


def collect_gpu_metrics() -> List[GpuMetric]:
    if not shutil.which("nvidia-smi"):
        return []
    command = [
        "nvidia-smi",
        "--query-gpu=name,memory.used,memory.total,utilization.gpu",
        "--format=csv,noheader,nounits",
    ]
    try:
        output = subprocess.check_output(command, text=True, timeout=5)
    except Exception:
        return []
    metrics: List[GpuMetric] = []
    now = datetime.now(timezone.utc)
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 4:
            continue
        metrics.append(
            GpuMetric(
                timestamp=now,
                name=parts[0],
                memory_used_mib=_int_or_none(parts[1]),
                memory_total_mib=_int_or_none(parts[2]),
                utilization_percent=_int_or_none(parts[3]),
            )
        )
    return metrics


def _int_or_none(value: str) -> Optional[int]:
    try:
        return int(value)
    except ValueError:
        return None
