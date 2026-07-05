from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

from .config import Settings
from .fastdeploy import FastDeployClient, collect_gpu_metrics
from .latex import latex_body_from_raw, wrap_latex_body
from .models import DocumentResult, OCRRequest
from .storage import Storage

PageBody = Tuple[int, str]


class OCRProcessor:
    def __init__(self, settings: Settings, storage: Storage, client: FastDeployClient):
        self.settings = settings
        self.storage = storage
        self.client = client

    def recognize(self, request: OCRRequest) -> DocumentResult:
        path = Path(request.path).expanduser()
        if not path.exists():
            raise FileNotFoundError(str(path))
        if request.source_type == "pdf" or path.suffix.lower() == ".pdf":
            return self._recognize_pdf(path, request.title)
        return self._recognize_image(path, request.title)

    def _recognize_image(self, path: Path, title: Optional[str] = None) -> DocumentResult:
        document_id = str(uuid.uuid4())
        start = time.perf_counter()
        original_copy = self.storage.copy_source(str(path), document_id)
        thumbnail = self.storage.thumbnail_for(str(path), document_id)
        raw = self.client.recognize_image(path)
        body = latex_body_from_raw(raw)
        now = datetime.now(timezone.utc)
        document = DocumentResult(
            id=document_id,
            title=title or str(raw.get("title") or path.stem),
            source_type="image",
            source_path=str(path),
            created_at=now,
            updated_at=now,
            body=body,
            latex=wrap_latex_body(body, title or str(raw.get("title") or path.stem)),
            raw=safe_raw_payload(raw),
            thumbnail_path=thumbnail,
            original_copy_path=original_copy,
            metrics=self._metric_payload(start),
        )
        self.storage.record_metric(document.id, document.metrics)
        return self.storage.save_document(document)

    def _recognize_pdf(self, path: Path, title: Optional[str] = None) -> DocumentResult:
        document_id, original_copy, pages = self.begin_pdf(path)
        start = time.perf_counter()
        page_bodies: List[PageBody] = []
        raw_pages = []
        for page_number, image_path in enumerate(pages, start=1):
            page_body, raw = self.recognize_pdf_page(image_path, page_number)
            raw_pages.append({"page": page_number, "raw_text": raw.get("raw_text", "")})
            page_bodies.append(page_body)
        return self.save_pdf_document(
            document_id=document_id,
            path=path,
            title=title,
            original_copy=original_copy,
            page_bodies=page_bodies,
            raw_pages=raw_pages,
            start=start,
        )

    def begin_pdf(self, path: Path) -> tuple[str, Optional[str], List[Path]]:
        document_id = str(uuid.uuid4())
        original_copy = self.storage.copy_source(str(path), document_id)
        pages = self._render_pdf_pages(path, document_id)
        return document_id, original_copy, pages

    def recognize_pdf_page(self, image_path: Path, page_number: int) -> tuple[PageBody, dict]:
        raw = self.client.recognize_image(image_path)
        body = latex_body_from_raw(raw, page_number)
        return (page_number, body), raw

    def save_pdf_document(
        self,
        document_id: str,
        path: Path,
        title: Optional[str],
        original_copy: Optional[str],
        page_bodies: List[PageBody],
        raw_pages: List[dict],
        start: float,
        failed_pages: Optional[List[dict]] = None,
        status: str = "completed",
    ) -> DocumentResult:
        now = datetime.now(timezone.utc)
        body = merge_page_bodies(page_bodies)
        document_title = title or path.stem
        document = DocumentResult(
            id=document_id,
            title=document_title,
            source_type="pdf",
            source_path=str(path),
            created_at=now,
            updated_at=now,
            status=status,
            body=body,
            latex=wrap_latex_body(body, document_title),
            raw={
                "page_count": len(page_bodies) + len(failed_pages or []),
                "pages": raw_pages,
                "failed_pages": failed_pages or [],
            },
            original_copy_path=original_copy,
            metrics=self._metric_payload(start),
        )
        self.storage.record_metric(document.id, document.metrics)
        return self.storage.save_document(document)

    def _render_pdf_pages(self, path: Path, document_id: str) -> List[Path]:
        try:
            import fitz  # type: ignore
        except Exception as exc:
            raise RuntimeError(
                "PDF import requires the optional PyMuPDF dependency. Install sidecar[pdf]."
            ) from exc
        target_dir = self.settings.history_dir / document_id / "pages"
        target_dir.mkdir(parents=True, exist_ok=True)
        pages: List[Path] = []
        with fitz.open(path) as doc:
            for index, page in enumerate(doc, start=1):
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                out = target_dir / f"page-{index:04d}.png"
                pixmap.save(out)
                pages.append(out)
        return pages

    def _metric_payload(self, start: float) -> dict:
        duration_ms = (time.perf_counter() - start) * 1000
        gpu = collect_gpu_metrics()
        memory = max((metric.memory_used_mib or 0 for metric in gpu), default=None)
        return {
            "duration_ms": round(duration_ms, 2),
            "gpu_memory_mib": memory,
            "gpu": [metric.model_dump(mode="json") for metric in gpu],
        }


def merge_page_bodies(page_bodies: List[PageBody]) -> str:
    ordered = sorted(page_bodies, key=lambda item: item[0])
    parts: List[str] = []
    multiple_pages = len(ordered) > 1
    for page_number, body in ordered:
        if not body.strip():
            continue
        if multiple_pages:
            parts.append(f"% Page {page_number}\n{body.strip()}")
        else:
            parts.append(body.strip())
    return "\n\n".join(parts)


def safe_raw_payload(raw: dict) -> dict:
    return {
        "title": raw.get("title"),
        "raw_text": raw.get("raw_text", ""),
    }
