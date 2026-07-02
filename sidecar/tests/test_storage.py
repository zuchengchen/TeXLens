from datetime import datetime, timezone

from texlens_sidecar.config import Settings
from texlens_sidecar.models import DocumentResult
from texlens_sidecar.storage import Storage


def test_storage_roundtrip(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    storage = Storage(settings)
    now = datetime.now(timezone.utc)
    document = DocumentResult(
        id="doc-1",
        title="sample",
        source_type="image",
        created_at=now,
        updated_at=now,
        latex="hello",
    )
    storage.save_document(document)
    assert storage.get_document("doc-1").latex == "hello"
    assert storage.list_documents("sample")[0].id == "doc-1"


def test_storage_search_handles_hyphenated_terms(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    storage = Storage(settings)
    now = datetime.now(timezone.utc)
    document = DocumentResult(
        id="doc-1",
        title="pdf-smoke-table",
        source_type="pdf",
        created_at=now,
        updated_at=now,
        latex="hello",
    )
    storage.save_document(document)

    assert storage.list_documents("pdf-smoke")[0].id == "doc-1"
