"""Анализ устойчивости: где сеть держится на одном аппарате.

Два независимых взгляда на уязвимость:

1. **Точки сочленения на отсчёте.** Аппарат критичен в момент ``t`` для пункта
   ``c``, если его удаление разрывает связность «клиент → шлюз». Проверяется
   прямо: убираем узел и пробуем найти маршрут заново. Агрегат по всему
   горизонту даёт рейтинг «сколько времени сеть держится на этом аппарате».

2. **Свип точек отказа (SPOF).** Полный пересчёт горизонта с отказом каждого
   аппарата по очереди. Дороже, но отвечает на вопрос проектировщика буквально:
   «на сколько упадёт доступность, если этот аппарат потерян насовсем».
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

from .routing import PathResult, SourceLinks, StepGraph, Strategy, find_path
from .scenario import Outage, Scenario


def critical_satellites(
    graph: StepGraph,
    sources: SourceLinks,
    path: PathResult,
) -> list[int]:
    """Аппараты маршрута, без которых связность «клиент → шлюз» пропадает.

    Проверяется только состав маршрута: узел вне текущего пути удалить можно,
    но связность он не определяет, раз путь его не использует. Связность не
    зависит от стратегии, поэтому проверка всегда идёт поиском в ширину.
    """
    critical: list[int] = []
    for satellite in path.satellites:
        if find_path(graph, sources, Strategy.MIN_HOPS.value, frozenset({satellite})) is None:
            critical.append(satellite)
    return critical


@dataclass(slots=True)
class CriticalityAccumulator:
    """Копит статистику критичности аппаратов по ходу основного цикла."""

    satellite_count: int
    routed_steps: int = 0
    counts: np.ndarray = field(init=False)
    per_client: dict[str, np.ndarray] = field(default_factory=dict)
    usage: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.counts = np.zeros(self.satellite_count, dtype=np.int32)
        self.usage = np.zeros(self.satellite_count, dtype=np.int32)

    def observe(self, client_id: str, used: Sequence[int], critical: Sequence[int]) -> None:
        self.routed_steps += 1
        for satellite in used:
            self.usage[satellite] += 1
        if client_id not in self.per_client:
            self.per_client[client_id] = np.zeros(self.satellite_count, dtype=np.int32)
        bucket = self.per_client[client_id]
        for satellite in critical:
            self.counts[satellite] += 1
            bucket[satellite] += 1

    def ranking(self, sat_ids: Sequence[str], limit: int = 10) -> list[dict[str, Any]]:
        """Топ аппаратов по доле времени, когда сеть держалась только на них."""
        if self.routed_steps == 0:
            return []
        order = np.argsort(-self.counts, kind="stable")
        result: list[dict[str, Any]] = []
        for index in order[:limit]:
            index = int(index)
            if self.counts[index] == 0:
                break
            result.append(
                {
                    "satellite_id": sat_ids[index],
                    "critical_steps": int(self.counts[index]),
                    "critical_share_pct": round(
                        self.counts[index] / self.routed_steps * 100.0, 2
                    ),
                    "used_steps": int(self.usage[index]),
                    "affected_clients": sorted(
                        client
                        for client, bucket in self.per_client.items()
                        if bucket[index] > 0
                    ),
                }
            )
        return result


@dataclass(slots=True)
class SpofEntry:
    """Последствия постоянной потери одного аппарата."""

    satellite_id: str
    min_availability_pct: float
    mean_availability_pct: float
    worst_client: str
    delta_min_pp: float
    delta_mean_pp: float
    max_gap_s: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "satellite_id": self.satellite_id,
            "min_availability_pct": self.min_availability_pct,
            "mean_availability_pct": self.mean_availability_pct,
            "worst_client": self.worst_client,
            "delta_min_pp": self.delta_min_pp,
            "delta_mean_pp": self.delta_mean_pp,
            "max_gap_s": self.max_gap_s,
        }


def scenario_with_failure(scenario: Scenario, satellite_id: str) -> Scenario:
    """Копия сценария, в которой аппарат недоступен весь расчётный период."""
    from dataclasses import replace

    outage = Outage(target_id=satellite_id, start_s=0.0, end_s=float(scenario.environment.horizon_s))
    return replace(scenario, failures=(*scenario.failures, outage))
