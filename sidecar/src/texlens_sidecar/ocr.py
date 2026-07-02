from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from PIL import Image

from .config import Settings
from .fastdeploy import FastDeployClient, collect_gpu_metrics
from .latex import assemble_latex_document
from .models import BlockType, DocumentResult, OCRBlock, OCRRequest, PageResult, RecognitionMode
from .storage import Storage


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
            return self._recognize_pdf(path, request.mode, request.title)
        return self._recognize_image(path, request.mode, request.title)

    def rerun_block(self, document_id: str, block_id: str, mode: RecognitionMode) -> DocumentResult:
        document = self.storage.get_document(document_id)
        for page in document.pages:
            for index, block in enumerate(page.blocks):
                if block.id != block_id:
                    continue
                if not block.crop_path:
                    raise ValueError("This block has no stored crop for re-recognition.")
                raw = self.client.recognize_image(Path(block.crop_path), mode.value)
                new_blocks = self._blocks_from_raw(raw, page.page, Path(block.crop_path))
                if not new_blocks:
                    raise ValueError("FastDeploy did not return a replacement block.")
                replacement = new_blocks[0]
                replacement.id = block.id
                replacement.bbox = block.bbox
                replacement.crop_path = block.crop_path
                page.blocks[index] = replacement
                document.updated_at = datetime.now(timezone.utc)
                document.latex = assemble_latex_document(document, self.settings.latex_template)
                return self.storage.save_document(document)
        raise KeyError(block_id)

    def _recognize_image(
        self, path: Path, mode: RecognitionMode, title: Optional[str] = None
    ) -> DocumentResult:
        document_id = str(uuid.uuid4())
        start = time.perf_counter()
        original_copy = self.storage.copy_source(str(path), document_id)
        thumbnail = self.storage.thumbnail_for(str(path), document_id)
        raw = self.client.recognize_image(path, mode.value)
        blocks = self._blocks_from_raw(raw, 1, path, document_id)
        page = self._page_result(path, 1, blocks)
        now = datetime.now(timezone.utc)
        document = DocumentResult(
            id=document_id,
            title=title or raw.get("title") or path.stem,
            source_type="image",
            source_path=str(path),
            created_at=now,
            updated_at=now,
            pages=[page],
            raw=raw,
            thumbnail_path=thumbnail,
            original_copy_path=original_copy,
            metrics=self._metric_payload(start),
        )
        document.latex = raw.get("latex_document") or assemble_latex_document(document, self.settings.latex_template)
        self.storage.record_metric(document.id, document.metrics)
        return self.storage.save_document(document)

    def _recognize_pdf(
        self, path: Path, mode: RecognitionMode, title: Optional[str] = None
    ) -> DocumentResult:
        document_id, original_copy, pages = self.begin_pdf(path)
        start = time.perf_counter()
        page_results: List[PageResult] = []
        raw_pages = []
        for page_number, image_path in enumerate(pages, start=1):
            page_result, raw = self.recognize_pdf_page(
                image_path, page_number, mode, document_id
            )
            raw_pages.append(raw)
            page_results.append(page_result)
        return self.save_pdf_document(
            document_id=document_id,
            path=path,
            title=title,
            original_copy=original_copy,
            page_results=page_results,
            raw_pages=raw_pages,
            start=start,
        )

    def begin_pdf(self, path: Path) -> tuple[str, Optional[str], List[Path]]:
        document_id = str(uuid.uuid4())
        original_copy = self.storage.copy_source(str(path), document_id)
        pages = self._render_pdf_pages(path, document_id)
        return document_id, original_copy, pages

    def recognize_pdf_page(
        self, image_path: Path, page_number: int, mode: RecognitionMode, document_id: str
    ) -> tuple[PageResult, dict]:
        raw = self.client.recognize_image(image_path, mode.value)
        page_result = self._page_result(
            image_path,
            page_number,
            self._blocks_from_raw(raw, page_number, image_path, document_id),
        )
        return page_result, raw

    def save_pdf_document(
        self,
        document_id: str,
        path: Path,
        title: Optional[str],
        original_copy: Optional[str],
        page_results: List[PageResult],
        raw_pages: List[dict],
        start: float,
        failed_pages: Optional[List[dict]] = None,
        status: str = "completed",
    ) -> DocumentResult:
        now = datetime.now(timezone.utc)
        document = DocumentResult(
            id=document_id,
            title=title or path.stem,
            source_type="pdf",
            source_path=str(path),
            created_at=now,
            updated_at=now,
            status=status,
            pages=page_results,
            raw={"pages": raw_pages, "failed_pages": failed_pages or []},
            original_copy_path=original_copy,
            metrics=self._metric_payload(start),
        )
        document.latex = assemble_latex_document(document, self.settings.latex_template)
        self.storage.record_metric(document.id, document.metrics)
        return self.storage.save_document(document)

    def _blocks_from_raw(
        self, raw: dict, page: int, image_path: Path, document_id: Optional[str] = None
    ) -> List[OCRBlock]:
        raw_blocks = raw.get("blocks") if isinstance(raw, dict) else []
        if not isinstance(raw_blocks, list):
            raw_blocks = []
        blocks: List[OCRBlock] = []
        for index, item in enumerate(raw_blocks, start=1):
            if not isinstance(item, dict):
                continue
            block_id = str(item.get("id") or f"p{page}-b{index}")
            block = OCRBlock(
                id=block_id,
                page=page,
                block_type=_block_type(item.get("type") or item.get("block_type")),
                bbox=_bbox(item.get("bbox")),
                text=str(item.get("text") or ""),
                latex=str(item.get("latex") or item.get("text") or ""),
                confidence=item.get("confidence"),
                raw=item,
            )
            if document_id:
                block.crop_path = self._crop_block(image_path, document_id, block)
            blocks.append(block)
        if not blocks:
            fallback = OCRBlock(
                id=f"p{page}-b1",
                page=page,
                block_type=BlockType.unknown,
                bbox=[0, 0, 1, 1],
                text=str(raw.get("latex_document") or raw.get("raw_text") or ""),
                latex=str(raw.get("latex_document") or raw.get("raw_text") or ""),
                raw=raw,
            )
            if document_id:
                fallback.crop_path = self._crop_block(image_path, document_id, fallback)
            blocks.append(fallback)
        return blocks

    def _page_result(self, image_path: Path, page: int, blocks: List[OCRBlock]) -> PageResult:
        try:
            with Image.open(image_path) as image:
                width, height = image.size
        except Exception:
            width, height = None, None
        return PageResult(page=page, image_path=str(image_path), width=width, height=height, blocks=blocks)

    def _crop_block(self, image_path: Path, document_id: str, block: OCRBlock) -> Optional[str]:
        target_dir = self.settings.history_dir / document_id / "blocks"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{block.id}.png"
        try:
            with Image.open(image_path) as image:
                width, height = image.size
                x0, y0, x1, y1 = block.bbox
                box = (
                    max(0, int(x0 * width)),
                    max(0, int(y0 * height)),
                    min(width, int(x1 * width)),
                    min(height, int(y1 * height)),
                )
                image.crop(box).save(target)
            return str(target)
        except Exception:
            return None

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


def _block_type(value: object) -> BlockType:
    if isinstance(value, str):
        lowered = value.lower()
        for block_type in BlockType:
            if lowered == block_type.value:
                return block_type
    return BlockType.unknown


def _bbox(value: object) -> List[float]:
    if isinstance(value, list) and len(value) == 4:
        try:
            coords = [float(item) for item in value]
            if max(coords) > 1.0:
                max_coord = max(coords) or 1.0
                coords = [item / max_coord for item in coords]
            return [min(1.0, max(0.0, item)) for item in coords]
        except Exception:
            pass
    return [0.0, 0.0, 1.0, 1.0]
