from __future__ import annotations

import json
import re
import shutil
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from PIL import Image

from .config import Settings
from .models import DocumentResult


class Storage:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.settings.ensure_dirs()
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.settings.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                create table if not exists documents (
                    id text primary key,
                    title text not null,
                    source_type text not null,
                    source_path text,
                    created_at text not null,
                    updated_at text not null,
                    status text not null,
                    latex text not null,
                    payload_json text not null,
                    thumbnail_path text,
                    original_copy_path text
                );
                create virtual table if not exists documents_fts using fts5(
                    id unindexed,
                    title,
                    latex
                );
                create table if not exists request_metrics (
                    id text primary key,
                    document_id text,
                    created_at text not null,
                    duration_ms real,
                    gpu_memory_mib integer,
                    payload_json text not null
                );
                """
            )

    def copy_source(self, path: str, document_id: Optional[str] = None) -> Optional[str]:
        source = Path(path)
        if not source.exists() or not source.is_file():
            return None
        document_id = document_id or str(uuid.uuid4())
        target_dir = self.settings.history_dir / document_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        shutil.copy2(source, target)
        return str(target)

    def thumbnail_for(self, path: str, document_id: str) -> Optional[str]:
        source = Path(path)
        if not source.exists() or source.suffix.lower() == ".pdf":
            return None
        target = self.settings.thumbnail_dir / f"{document_id}.jpg"
        try:
            with Image.open(source) as image:
                image.thumbnail((420, 420))
                image.convert("RGB").save(target, "JPEG", quality=85)
            return str(target)
        except Exception:
            return None

    def save_document(self, document: DocumentResult) -> DocumentResult:
        with self.connect() as db:
            db.execute(
                """
                insert into documents (
                    id, title, source_type, source_path, created_at, updated_at, status,
                    latex, payload_json, thumbnail_path, original_copy_path
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                    title=excluded.title,
                    source_type=excluded.source_type,
                    source_path=excluded.source_path,
                    updated_at=excluded.updated_at,
                    status=excluded.status,
                    latex=excluded.latex,
                    payload_json=excluded.payload_json,
                    thumbnail_path=excluded.thumbnail_path,
                    original_copy_path=excluded.original_copy_path
                """,
                (
                    document.id,
                    document.title,
                    document.source_type,
                    document.source_path,
                    document.created_at.isoformat(),
                    document.updated_at.isoformat(),
                    document.status,
                    document.latex,
                    document.model_dump_json(),
                    document.thumbnail_path,
                    document.original_copy_path,
                ),
            )
            db.execute("delete from documents_fts where id = ?", (document.id,))
            db.execute(
                "insert into documents_fts(id, title, latex) values (?, ?, ?)",
                (document.id, document.title, document.latex),
            )
        return document

    def get_document(self, document_id: str) -> DocumentResult:
        with self.connect() as db:
            row = db.execute("select payload_json from documents where id = ?", (document_id,)).fetchone()
        if row is None:
            raise KeyError(document_id)
        return DocumentResult.model_validate_json(row["payload_json"])

    def list_documents(self, query: str = "", limit: int = 50) -> List[DocumentResult]:
        with self.connect() as db:
            fts_query = build_fts_query(query)
            if fts_query:
                rows = db.execute(
                    """
                    select d.payload_json
                    from documents_fts f
                    join documents d on d.id = f.id
                    where documents_fts match ?
                    order by d.created_at desc
                    limit ?
                    """,
                    (fts_query, limit),
                ).fetchall()
            else:
                rows = db.execute(
                    "select payload_json from documents order by created_at desc limit ?",
                    (limit,),
                ).fetchall()
        return [DocumentResult.model_validate_json(row["payload_json"]) for row in rows]

    def record_metric(self, document_id: Optional[str], payload: dict) -> None:
        with self.connect() as db:
            db.execute(
                """
                insert into request_metrics(id, document_id, created_at, duration_ms, gpu_memory_mib, payload_json)
                values (?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    document_id,
                    datetime.now(timezone.utc).isoformat(),
                    payload.get("duration_ms"),
                    payload.get("gpu_memory_mib"),
                    json.dumps(payload),
                ),
            )

    def recent_metrics(self, limit: int = 100) -> List[dict]:
        with self.connect() as db:
            rows = db.execute(
                "select payload_json from request_metrics order by created_at desc limit ?",
                (limit,),
            ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]

    def clear_history(self) -> int:
        with self.connect() as db:
            count = db.execute("select count(*) as count from documents").fetchone()["count"]
            db.execute("delete from documents")
            db.execute("delete from documents_fts")
            db.execute("delete from request_metrics")
        if self.settings.history_dir.exists():
            shutil.rmtree(self.settings.history_dir)
        if self.settings.thumbnail_dir.exists():
            shutil.rmtree(self.settings.thumbnail_dir)
        self.settings.ensure_dirs()
        return int(count)

    def prune_expired(self) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.settings.history_days)
        with self.connect() as db:
            rows = db.execute(
                "select id, original_copy_path from documents where created_at < ?",
                (cutoff.isoformat(),),
            ).fetchall()
            ids = [row["id"] for row in rows]
            for document_id in ids:
                db.execute("delete from documents where id = ?", (document_id,))
                db.execute("delete from documents_fts where id = ?", (document_id,))
        for document_id in ids:
            path = self.settings.history_dir / document_id
            if path.exists():
                shutil.rmtree(path, ignore_errors=True)
            thumb = self.settings.thumbnail_dir / f"{document_id}.jpg"
            if thumb.exists():
                thumb.unlink(missing_ok=True)
        return len(ids)


def build_fts_query(query: str) -> str:
    tokens = re.findall(r"[\w]+", query, flags=re.UNICODE)
    return " ".join(f'"{token.replace(chr(34), chr(34) * 2)}"' for token in tokens)
