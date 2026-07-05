from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from .config import get_settings


SAMPLES = [
    {
        "name": "formula",
        "file": "formula-derivation.png",
        "latex_contains": ["\\documentclass", "\\begin"],
    },
    {
        "name": "table",
        "file": "table-page.png",
        "latex_contains": ["\\begin{tabular}", "Method"],
    },
    {
        "name": "mixed",
        "file": "mixed-zh-en-page.png",
        "latex_contains": ["\\documentclass", "TeXLens"],
    },
]


def main() -> None:
    settings = get_settings()
    out_dir = Path("sidecar/bench-output")
    out_dir.mkdir(parents=True, exist_ok=True)
    sample_dir = find_sample_dir()
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "samples": [],
        "status": "skipped",
        "reason": "FastDeploy benchmark requires a running TeXLens sidecar and PaddleOCR-VL service.",
        "sample_dir": str(sample_dir) if sample_dir else None,
    }
    try:
        with httpx.Client(timeout=settings.request_timeout_seconds) as client:
            base_url = f"http://{settings.host}:{settings.port}"
            health = client.get(f"{base_url}/health")
            fd = client.get(f"{base_url}/fastdeploy/status")
            report["sidecar_health"] = health.json()
            report["fastdeploy_status"] = fd.json()
            if not fd.json().get("healthy"):
                raise RuntimeError("FastDeploy service is not healthy.")
            if not sample_dir:
                raise RuntimeError("Synthetic samples were not found. Run samples/generate_samples.py.")
            report["samples"] = run_samples(client, base_url, sample_dir, out_dir)
            report["status"] = "passed" if all(item["ok"] for item in report["samples"]) else "needs_review"
            report["reason"] = "Synthetic OCR samples completed; review saved JSON outputs for quality."
    except Exception as exc:
        report["error"] = str(exc)
    (out_dir / "ocr-bench-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


def find_sample_dir() -> Optional[Path]:
    for candidate in [Path("samples/generated"), Path("../samples/generated")]:
        if candidate.exists():
            return candidate.resolve()
    return None


def run_samples(
    client: httpx.Client, base_url: str, sample_dir: Path, out_dir: Path
) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for sample in SAMPLES:
        image_path = sample_dir / sample["file"]
        started = time.perf_counter()
        response = client.post(
            f"{base_url}/ocr/recognize",
            json={
                "path": str(image_path),
                "source_type": "image",
                "title": f"bench-{sample['name']}",
            },
        )
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        payload = response.json()
        output_path = out_dir / f"{sample['name']}.json"
        output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        latex = payload.get("latex", "") if isinstance(payload, dict) else ""
        compile_result = compile_latex(client, base_url, latex)
        checks = {
            "http_ok": response.status_code == 200,
            "body_present": bool(payload.get("body")) if isinstance(payload, dict) else False,
            "latex_contains": all(token in latex for token in sample["latex_contains"]),
            "compile_ok": bool(compile_result.get("ok")),
        }
        results.append(
            {
                "name": sample["name"],
                "path": str(image_path),
                "duration_ms": duration_ms,
                "document_id": payload.get("id") if isinstance(payload, dict) else None,
                "metrics": payload.get("metrics") if isinstance(payload, dict) else None,
                "checks": checks,
                "compile": compile_result,
                "ok": all(checks.values()),
                "output_path": str(output_path),
                "latex_excerpt": latex[:800],
            }
        )
    return results


def compile_latex(client: httpx.Client, base_url: str, latex: str) -> Dict[str, Any]:
    try:
        response = client.post(f"{base_url}/latex/compile", json={"latex": latex})
        payload = response.json()
        return {
            "ok": bool(payload.get("ok")),
            "returncode": payload.get("returncode"),
            "pdf_path": payload.get("pdf_path"),
            "stdout_tail": str(payload.get("stdout") or "")[-1200:],
            "stderr_tail": str(payload.get("stderr") or "")[-1200:],
            "error": payload.get("error"),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


if __name__ == "__main__":
    main()
