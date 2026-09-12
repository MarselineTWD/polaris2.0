"""SQLite-хранилище сохранённых вариантов проекта.

Результат расчёта воспроизводим из сценария, поэтому хранить нужно только сам
сценарий и подпись варианта. Режим WAL позволяет читать во время записи и
переживает перезапуск процесса без потери данных.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

_SCHEMA = """
CREATE TABLE IF NOT EXISTS variants (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    scenario     TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '{}',
    options      TEXT NOT NULL DEFAULT '{}',
    scenario_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_created ON variants (created_at DESC);
"""


class Database:
    """Тонкая обёртка над sqlite3 с отдельным соединением на поток."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        with self.connect() as connection:
            connection.executescript(_SCHEMA)

    def _connection(self) -> sqlite3.Connection:
        existing = getattr(self._local, "connection", None)
        if existing is None:
            existing = sqlite3.connect(self.path, timeout=10.0, check_same_thread=False)
            existing.row_factory = sqlite3.Row
            existing.execute("PRAGMA journal_mode=WAL")
            existing.execute("PRAGMA synchronous=NORMAL")
            existing.execute("PRAGMA foreign_keys=ON")
            self._local.connection = existing
        return existing

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = self._connection()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
