from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

from .fastdeploy import collect_gpu_metrics


def main() -> None:
    out_dir = Path("sidecar/perf-output")
    out_dir.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    gpu = [metric.model_dump(mode="json") for metric in collect_gpu_metrics()]
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": round((time.perf_counter() - start) * 1000, 2),
        "gpu": gpu,
        "note": "This records current system metrics; OCR task metrics are recorded by sidecar requests.",
    }
    (out_dir / "perf-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

