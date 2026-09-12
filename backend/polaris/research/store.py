"""Долговечное файловое хранилище результатов инженерной верификации."""

from __future__ import annotations

import json
import os
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any


class ResearchRegistry:
    def __init__(self, directory: Path, keep: int = 24) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.keep = keep
        self._lock = threading.RLock()

    def _path(self, run_id: str) -> Path:
        safe = "".join(char for char in run_id if char.isalnum() or char in "_-")
        if safe != run_id or not run_id.startswith("research_"):
            raise ValueError("Некорректный идентификатор инженерного расчёта")
        return self.directory / f"{safe}.json"

    def save(self, result: dict[str, Any]) -> dict[str, Any]:
        run_id = str(result["id"])
        path = self._path(run_id)
        temporary = path.with_suffix(".tmp")
        with self._lock:
            temporary.write_text(
                json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8"
            )
            os.replace(temporary, path)
            self._evict()
        return result

    def get(self, run_id: str) -> dict[str, Any] | None:
        try:
            path = self._path(run_id)
        except ValueError:
            return None
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def hazard_scenario(self, run_id: str, event_id: str) -> dict[str, Any] | None:
        result = self.get(run_id)
        if result is None:
            return None
        event = next(
            (item for item in result.get("hazards", {}).get("events", []) if item.get("id") == event_id),
            None,
        )
        if event is None:
            return None
        scenario = deepcopy(result["scenario"])
        failures = scenario.setdefault("failures", [])
        window = {
            "satellite_id": event["satellite_id"],
            "start_s": max(0, int(event["window_start_s"])),
            "end_s": min(
                int(scenario["environment"]["horizon_s"]), int(event["window_end_s"])
            ),
        }
        if window["end_s"] <= window["start_s"]:
            window["end_s"] = min(
                int(scenario["environment"]["horizon_s"]), window["start_s"] + 1
            )
        failures.append(window)
        scenario.setdefault("meta", {})["title"] = (
            f"{scenario.get('meta', {}).get('title', 'Сценарий')} — окно манёвра {event_id}"
        )
        return {
            "event": event,
            "scenario": scenario,
            "note": (
                "Сценарий создан по команде пользователя. Окно моделируется как недоступность аппарата; "
                "вероятность столкновения не вычислялась."
            ),
        }

    def _evict(self) -> None:
        files = sorted(
            self.directory.glob("research_*.json"), key=lambda item: item.stat().st_mtime, reverse=True
        )
        for path in files[self.keep :]:
            try:
                path.unlink()
            except OSError:
                pass
