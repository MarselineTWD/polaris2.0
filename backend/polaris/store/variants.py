"""Репозиторий сохранённых вариантов проекта."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from .db import Database


class VariantRepository:
    def __init__(self, database: Database) -> None:
        self._db = database

    def save(
        self,
        *,
        label: str,
        scenario: dict[str, Any],
        scenario_hash: str,
        summary: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        note: str = "",
    ) -> dict[str, Any]:
        variant_id = f"var_{uuid.uuid4().hex[:12]}"
        created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self._db.connect() as connection:
            connection.execute(
                "INSERT INTO variants (id, label, note, scenario, summary, options,"
                " scenario_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    variant_id,
                    label,
                    note,
                    json.dumps(scenario, ensure_ascii=False),
                    json.dumps(summary or {}, ensure_ascii=False),
                    json.dumps(options or {}, ensure_ascii=False),
                    scenario_hash,
                    created_at,
                ),
            )
        return self.get(variant_id)  # type: ignore[return-value]

    def get(self, variant_id: str) -> dict[str, Any] | None:
        with self._db.connect() as connection:
            row = connection.execute(
                "SELECT * FROM variants WHERE id = ?", (variant_id,)
            ).fetchone()
        return _row_to_dict(row) if row else None

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._db.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM variants ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    def delete(self, variant_id: str) -> bool:
        with self._db.connect() as connection:
            cursor = connection.execute("DELETE FROM variants WHERE id = ?", (variant_id,))
        return cursor.rowcount > 0


def _row_to_dict(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "label": row["label"],
        "note": row["note"],
        "scenario": json.loads(row["scenario"]),
        "summary": json.loads(row["summary"]),
        "options": json.loads(row["options"]),
        "scenario_hash": row["scenario_hash"],
        "created_at": row["created_at"],
    }
