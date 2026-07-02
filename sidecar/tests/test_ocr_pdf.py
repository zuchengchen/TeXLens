import time

from texlens_sidecar.config import Settings
from texlens_sidecar.models import BlockType, OCRBlock, PageResult
from texlens_sidecar.ocr import OCRProcessor
from texlens_sidecar.storage import Storage


def test_save_pdf_document_records_failed_pages(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    storage = Storage(settings)
    processor = OCRProcessor(settings, storage, client=None)  # type: ignore[arg-type]
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4\n")

    document = processor.save_pdf_document(
        document_id="doc-pdf",
        path=source,
        title="paper",
        original_copy=None,
        page_results=[
            PageResult(
                page=1,
                blocks=[OCRBlock(id="b1", block_type=BlockType.paragraph, latex="hello")],
            )
        ],
        raw_pages=[{"page": 1, "result": {"raw_text": "hello"}}],
        start=time.perf_counter(),
        failed_pages=[{"page": 2, "status": "failed", "error": "boom"}],
        status="completed_with_errors",
    )

    stored = storage.get_document(document.id)
    assert stored.status == "completed_with_errors"
    assert stored.raw["failed_pages"][0]["page"] == 2
    assert "hello" in stored.latex
