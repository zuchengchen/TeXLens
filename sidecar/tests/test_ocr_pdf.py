import time

from PIL import Image

from texlens_sidecar.config import Settings
from texlens_sidecar.models import OCRRequest
from texlens_sidecar.ocr import OCRProcessor
from texlens_sidecar.storage import Storage


class FakeClient:
    def __init__(self):
        self.paths = []

    def recognize_image(self, path):
        self.paths.append(str(path))
        return {
            "blocks": [
                {
                    "id": "b1",
                    "type": "formula",
                    "bbox": [0, 0, 1, 1],
                    "latex": "E=mc^2",
                }
            ]
        }


def test_image_document_preview_uses_stored_copy(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    storage = Storage(settings)
    client = FakeClient()
    processor = OCRProcessor(settings, storage, client=client)  # type: ignore[arg-type]
    source = tmp_path / "outside-app-data.png"
    Image.new("RGB", (320, 120), "white").save(source)

    document = processor.recognize(OCRRequest(path=str(source), source_type="image"))

    assert client.paths == [str(source)]
    assert document.original_copy_path
    assert document.body == "\\begin{equation}\nE=mc^2\n\\end{equation}"
    assert "\\[" not in document.latex
    assert str(settings.history_dir) in document.original_copy_path
    assert storage.get_document(document.id).original_copy_path == document.original_copy_path


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
        page_bodies=[(1, "hello")],
        raw_pages=[{"page": 1, "raw_text": "hello"}],
        start=time.perf_counter(),
        failed_pages=[{"page": 2, "status": "failed", "error": "boom"}],
        status="completed_with_errors",
    )

    stored = storage.get_document(document.id)
    assert stored.status == "completed_with_errors"
    assert stored.raw["failed_pages"][0]["page"] == 2
    assert stored.body == "hello"
    assert "hello" in stored.latex
