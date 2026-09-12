"""Автоматический подбор ориентации и фазирования орбитальных плоскостей.

Задача: найти такие ``raan_deg`` и ``phase_deg`` плоскостей, при которых
минимальная по клиентским пунктам доступность максимальна.

Поиск двухэтапный.

1. **Грубая сетка по регулярному семейству.** Плоскости расставляются
   равномерно: ``raan_k = raan_0 + k * span / P``, ``phase_k = k * offset``.
   Два наглядных параметра — разнос плоскостей и межплоскостной сдвиг —
   покрывают пространство осмысленных конструкций и дают хорошее начальное
   приближение. Такое семейство ещё и объяснимо: это привычная схема Уокера.
2. **Локальный покоординатный поиск.** От лучшей точки сетки шагами ±h по
   каждой свободной переменной, с уменьшением шага вдвое при отсутствии
   улучшения. Уточняет решение там, где регулярность необязательна.

Каждый кандидат оценивается **точным** расчётом горизонта — приближений и
суррогатных моделей здесь нет.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Any, Callable, Sequence

from .analysis import FAST_OPTIONS, map_scenarios
from .scenario import Plane, Scenario


@dataclass(slots=True)
class Candidate:
    """Вариант расстановки плоскостей и его оценка."""

    raan_deg: list[float]
    phase_deg: list[float]
    min_availability_pct: float = 0.0
    mean_availability_pct: float = 0.0
    max_gap_s: float = 0.0
    worst_client: str = ""
    clients: dict[str, float] | None = None
    origin: str = ""

    @property
    def score(self) -> tuple[float, float, float]:
        """Ключ сравнения: сначала минимум по пунктам, затем среднее, затем перерыв."""
        return (self.min_availability_pct, self.mean_availability_pct, -self.max_gap_s)

    def as_dict(self) -> dict[str, Any]:
        return {
            "raan_deg": [round(value, 3) for value in self.raan_deg],
            "phase_deg": [round(value, 3) for value in self.phase_deg],
            "min_availability_pct": self.min_availability_pct,
            "mean_availability_pct": self.mean_availability_pct,
            "max_gap_s": self.max_gap_s,
            "worst_client": self.worst_client,
            "clients": self.clients or {},
            "origin": self.origin,
        }


def _wrap(angle: float) -> float:
    """Привести угол к диапазону [0; 360), который требует схема данных."""
    value = math.fmod(angle, 360.0)
    return value + 360.0 if value < 0 else value


def apply_candidate(scenario: Scenario, candidate: Candidate) -> Scenario:
    """Построить сценарий с заданной расстановкой плоскостей."""
    planes = tuple(
        Plane(
            id=plane.id,
            raan_deg=_wrap(candidate.raan_deg[index]),
            phase_deg=_wrap(candidate.phase_deg[index]),
        )
        for index, plane in enumerate(scenario.planes)
    )
    return replace(scenario, planes=planes)


def _coarse_grid(scenario: Scenario) -> list[Candidate]:
    """Регулярные (уокеровские) расстановки плоскостей."""
    plane_count = len(scenario.planes)
    base_raan = scenario.planes[0].raan_deg
    per_plane = max(
        1,
        max(
            sum(1 for sat in scenario.satellites if sat.plane_id == plane.id)
            for plane in scenario.planes
        ),
    )
    slot_span = 360.0 / per_plane

    spans = [90.0, 120.0, 150.0, 180.0, 210.0, 240.0, 270.0, 300.0, 330.0, 360.0]
    offsets = [slot_span * k / 8.0 for k in range(8)]

    candidates: list[Candidate] = []
    for span in spans:
        for offset in offsets:
            candidates.append(
                Candidate(
                    raan_deg=[_wrap(base_raan + k * span / plane_count) for k in range(plane_count)],
                    phase_deg=[_wrap(k * offset) for k in range(plane_count)],
                    origin=f"сетка: разнос {span:.0f}°, сдвиг {offset:.1f}°",
                )
            )
    return candidates


def _vector(candidate: Candidate) -> list[float]:
    return [*candidate.raan_deg, *candidate.phase_deg]


def _from_vector(values: Sequence[float], plane_count: int, origin: str) -> Candidate:
    return Candidate(
        raan_deg=[_wrap(v) for v in values[:plane_count]],
        phase_deg=[_wrap(v) for v in values[plane_count:]],
        origin=origin,
    )


def _score_batch(
    scenario: Scenario,
    candidates: list[Candidate],
    workers: int | None,
    on_progress: Callable[[int], None] | None,
) -> list[Candidate]:
    # Небольшие порции дают интерфейсу честный прогресс и точку кооперативной
    # отмены: progress-callback может прервать подбор между порциями.
    for start in range(0, len(candidates), 8):
        batch = candidates[start : start + 8]
        variants = [apply_candidate(scenario, candidate) for candidate in batch]
        outcomes = map_scenarios(
            variants,
            FAST_OPTIONS,
            workers=workers,
            # Проверяем отмену после каждого готового кандидата, а не только
            # после всей порции. На слабом CPU одна порция может идти минуты.
            progress=(lambda _done, _total: on_progress(1)) if on_progress else None,
        )
        for candidate, outcome in zip(batch, outcomes):
            candidate.min_availability_pct = outcome["min_availability_pct"]
            candidate.mean_availability_pct = outcome["mean_availability_pct"]
            candidate.max_gap_s = outcome["max_gap_s"]
            candidate.worst_client = outcome["worst_client"] or ""
            candidate.clients = outcome["clients"]
    return candidates


def optimize(
    scenario: Scenario,
    *,
    max_evaluations: int = 220,
    workers: int | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Подобрать расстановку плоскостей под максимум минимальной доступности."""
    plane_count = len(scenario.planes)
    baseline = Candidate(
        raan_deg=[plane.raan_deg for plane in scenario.planes],
        phase_deg=[plane.phase_deg for plane in scenario.planes],
        origin="исходная конфигурация",
    )

    done = 0

    def report(count: int) -> None:
        nonlocal done
        done += count
        if progress is not None:
            progress(min(done, max_evaluations), max_evaluations)

    _score_batch(scenario, [baseline], workers, report)

    grid = _coarse_grid(scenario)[: max(0, max_evaluations - 1)]
    _score_batch(scenario, grid, workers, report)

    best = max([baseline, *grid], key=lambda item: item.score)
    history = [best]

    # Локальное уточнение: покоординатный шаг с дроблением.
    step = 15.0
    while step >= 1.0 and done < max_evaluations:
        vector = _vector(best)
        probes: list[Candidate] = []
        for index in range(len(vector)):
            for delta in (step, -step):
                moved = list(vector)
                moved[index] += delta
                probes.append(
                    _from_vector(
                        moved,
                        plane_count,
                        f"уточнение: шаг {step:.1f}° по координате {index + 1}",
                    )
                )
        probes = probes[: max(0, max_evaluations - done)]
        if not probes:
            break
        _score_batch(scenario, probes, workers, report)
        improved = max(probes, key=lambda item: item.score)
        if improved.score > best.score:
            best = improved
            history.append(best)
        else:
            step /= 2.0

    tuned_scenario = apply_candidate(scenario, best)
    return {
        "baseline": baseline.as_dict(),
        "best": best.as_dict(),
        "improvement_pp": round(
            best.min_availability_pct - baseline.min_availability_pct, 2
        ),
        "evaluations": done,
        "history": [item.as_dict() for item in history],
        "scenario": tuned_scenario.to_dict(),
        "target_met": best.min_availability_pct
        >= scenario.environment.target_availability * 100.0,
    }
