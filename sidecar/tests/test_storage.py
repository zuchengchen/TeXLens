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
    assert storage.get_document("doc-1").body == "hello"
    assert "\\begin{document}" in storage.get_document("doc-1").latex
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


def test_storage_normalizes_body_and_complete_source(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", config_dir=tmp_path / "config")
    storage = Storage(settings)
    now = datetime.now(timezone.utc)
    stored_copy = settings.history_dir / "doc-legacy" / "sample.png"
    stored_copy.parent.mkdir(parents=True)
    stored_copy.write_bytes(b"preview")
    document = DocumentResult(
        id="doc-legacy",
        title="legacy image",
        source_type="image",
        created_at=now,
        updated_at=now,
        original_copy_path=str(stored_copy),
        latex="\\[a=b\\]",
    )
    storage.save_document(document)

    stored = storage.get_document("doc-legacy")
    assert stored.body == "\\begin{equation}\na=b\n\\end{equation}"
    assert "\\begin{document}" in stored.latex
    assert "\\begin{equation}\na=b\n\\end{equation}" in storage.list_documents("legacy")[0].body
