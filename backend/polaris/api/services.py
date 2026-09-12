"""Общие службы приложения: пресеты, кэш расчётов, хранилище, задачи."""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path
from typing import Any

from ..cache import LruCache
from ..config import settings
from ..domain.engine import RunOptions, RunResult, compute_run
from ..domain.recommendations import build_recommendations
from ..domain.scenario import Scenario, parse_scenario
from ..domain.serialize import pack_bundle
from ..store.db import Database
from ..store.variants import VariantRepository
from .jobs import JobRegistry

#: Порядок и подписи встроенных сценариев из комплекта данных.
PRESET_ORDER = (
    ("01_full_constellation", "Полная группировка"),
    ("02_first_launch", "Первая очередь запуска"),
    ("03_satellite_outages", "Недоступность десяти аппаратов"),
    ("04_link_range", "Дальность межспутниковой связи 2000 км"),
)


class RunRegistry:
    """Кэш выполненных расчётов с доступом по ``run_id`` и по содержимому."""

    def __init__(self, capacity: int) -> None:
        self._by_id: LruCache[tuple[RunResult, dict[str, Any]]] = LruCache(capacity)
        self._by_key: LruCache[str] = LruCache(capacity * 2)
        self._lock = threading.Lock()

    @staticmethod
    def _key(scenario: Scenario, options: RunOptions) -> str:
        payload = json.dumps(options.as_dict(), sort_keys=True)
        return f"{scenario.content_hash()}|{payload}"

    def run(self, scenario: Scenario, options: RunOptions) -> tuple[str, dict[str, Any]]:
        """Вернуть готовый пакет, посчитав его при необходимости."""
        key = self._key(scenario, options)
        existing = self._by_key.get(key)
        if existing is not None:
            cached = self._by_id.get(existing)
            if cached is not None:
                return existing, cached[1]

        result = compute_run(scenario, options)
        result.recommendations = build_recommendations(result)
        run_id = f"run_{uuid.uuid4().hex[:12]}"
        bundle = pack_bundle(result, run_id)
        with self._lock:
            self._by_id.put(run_id, (result, bundle))
            self._by_key.put(key, run_id)
        return run_id, bundle

    def get(self, run_id: str) -> tuple[RunResult, dict[str, Any]] | None:
        return self._by_id.get(run_id)

    def stats(self) -> dict[str, Any]:
        return self._by_id.stats()


class Presets:
    """Встроенные сценарии, поставленные вместе с заданием."""

    def __init__(self, directory: Path) -> None:
        self._directory = directory

    def available(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for preset_id, title in PRESET_ORDER:
            path = self._directory / f"{preset_id}.json"
            if not path.exists():
                continue
            items.append({"id": preset_id, "title": title, "file": path.name})
        return items

    def load(self, preset_id: str) -> dict[str, Any] | None:
        if not any(preset_id == known for known, _ in PRESET_ORDER):
            return None
        path = self._directory / f"{preset_id}.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))


database = Database(settings.database_path)
variants = VariantRepository(database)
runs = RunRegistry(settings.run_cache_size)
presets = Presets(settings.data_dir)
jobs = JobRegistry()


def load_scenario(payload: Any) -> Scenario:
    """Разобрать сценарий; ошибки уходят наверх как ScenarioValidationError."""
    return parse_scenario(payload)
