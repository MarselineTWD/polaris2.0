"""Тяжёлые виды анализа: свип точек отказа и сравнение стратегий.

Оба опираются на то, что полный прогон горизонта занимает десятки миллисекунд:
то, что обычно делают приближённо, здесь считается перебором в лоб и потому
даёт точный ответ, а не оценку.
"""

from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import replace
from typing import Any, Callable, Iterable, Sequence

from .engine import RunOptions, compute_run
from .resilience import SpofEntry
from .routing import STRATEGY_LABELS, Strategy
from .scenario import Outage, Scenario, parse_scenario

#: Настройки для служебных прогонов: нужна только доступность, без разбора
#: критичности и резервных путей — это заметно быстрее.
FAST_OPTIONS = RunOptions(backup_limit=1, with_criticality=False)


def _evaluate_scenario(payload: tuple[dict[str, Any], dict[str, Any]]) -> dict[str, Any]:
    """Рабочая функция для пула процессов: считает сценарий и отдаёт сводку."""
    scenario_dict, options_dict = payload
    scenario = parse_scenario(scenario_dict)
    result = compute_run(scenario, RunOptions(**options_dict))
    return {
        "min_availability_pct": result.min_availability(),
        "mean_availability_pct": result.mean_availability(),
        "worst_client": result.worst_client(),
        "max_gap_s": max((m.max_gap_s for m in result.metrics), default=0.0),
        "clients": {m.client_id: m.availability_pct for m in result.metrics},
    }


def map_scenarios(
    scenarios: Sequence[Scenario],
    options: RunOptions = FAST_OPTIONS,
    *,
    workers: int | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> list[dict[str, Any]]:
    """Посчитать набор сценариев, по возможности параллельно.

    При любой проблеме с пулом процессов (запрет на fork, нехватка ресурсов)
    молча переходим на последовательный расчёт: лучше медленнее, чем никак.
    """
    payloads = [(scenario.to_dict(), options.as_dict()) for scenario in scenarios]
    total = len(payloads)
    if total == 0:
        return []

    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    if workers > 1 and total > 1:
        pool: ProcessPoolExecutor | None = None
        try:
            results: list[dict[str, Any]] = []
            pool = ProcessPoolExecutor(max_workers=workers)
            for index, item in enumerate(pool.map(_evaluate_scenario, payloads), start=1):
                results.append(item)
                if progress is not None:
                    progress(index, total)
            pool.shutdown(wait=True)
            return results
        except (BrokenProcessPool, OSError, RuntimeError):
            # Только инфраструктурная ошибка пула включает последовательный
            # fallback. Исключение из progress-callback (включая отмену задачи)
            # обязано выйти наружу, а не запускать весь расчёт повторно.
            if pool is not None:
                pool.shutdown(wait=False, cancel_futures=True)
        except BaseException:
            if pool is not None:
                pool.shutdown(wait=False, cancel_futures=True)
            raise

    results = []
    for index, payload in enumerate(payloads, start=1):
        results.append(_evaluate_scenario(payload))
        if progress is not None:
            progress(index, total)
    return results


def spof_sweep(
    scenario: Scenario,
    *,
    baseline: dict[str, Any] | None = None,
    candidates: Iterable[str] | None = None,
    workers: int | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Последствия постоянной потери каждого аппарата по отдельности.

    Для каждого активного аппарата горизонт пересчитывается с его отказом на
    весь период. Результат отвечает на прямой вопрос проектировщика: «сколько
    мы потеряем, если этот аппарат не вернётся».
    """
    horizon = float(scenario.environment.horizon_s)
    active_ids = [
        sat.id for sat in scenario.satellites if sat.launch_batch <= scenario.launch_stage
    ]
    targets = [sid for sid in (list(candidates) if candidates else active_ids)]

    if baseline is None:
        baseline = _evaluate_scenario((scenario.to_dict(), FAST_OPTIONS.as_dict()))

    variants = [
        replace(
            scenario,
            failures=(*scenario.failures, Outage(target_id=sid, start_s=0.0, end_s=horizon)),
        )
        for sid in targets
    ]
    outcomes = map_scenarios(variants, FAST_OPTIONS, workers=workers, progress=progress)

    entries: list[SpofEntry] = []
    for satellite_id, outcome in zip(targets, outcomes):
        entries.append(
            SpofEntry(
                satellite_id=satellite_id,
                min_availability_pct=outcome["min_availability_pct"],
                mean_availability_pct=outcome["mean_availability_pct"],
                worst_client=outcome["worst_client"] or "",
                delta_min_pp=round(
                    outcome["min_availability_pct"] - baseline["min_availability_pct"], 2
                ),
                delta_mean_pp=round(
                    outcome["mean_availability_pct"] - baseline["mean_availability_pct"], 2
                ),
                max_gap_s=outcome["max_gap_s"],
            )
        )
    entries.sort(key=lambda entry: (entry.delta_min_pp, entry.delta_mean_pp))

    return {
        "baseline": baseline,
        "evaluated": len(entries),
        "entries": [entry.as_dict() for entry in entries],
        "worst": [entry.as_dict() for entry in entries[:10]],
    }


def compare_strategies(
    scenario: Scenario,
    strategies: Sequence[str] | None = None,
    *,
    base_options: RunOptions | None = None,
) -> dict[str, Any]:
    """Посчитать один и тот же сценарий разными стратегиями маршрутизации.

    Доступность от стратегии не зависит — путь либо существует, либо нет.
    Различия проявляются в числе переходов, задержке, запасе линии и в том,
    как часто маршрут приходится перестраивать.
    """
    options = base_options or RunOptions()
    chosen = list(strategies or [item.value for item in Strategy])

    rows: list[dict[str, Any]] = []
    from .visibility import Topology

    topology = Topology(scenario)  # геометрия одна на все стратегии
    for strategy in chosen:
        result = compute_run(
            scenario,
            replace(options, strategy=strategy, with_criticality=False),
            topology=topology,
        )
        metrics = result.metrics
        rows.append(
            {
                "strategy": strategy,
                "label": STRATEGY_LABELS.get(strategy, strategy),
                "min_availability_pct": result.min_availability(),
                "mean_hops": _average(m.mean_hops for m in metrics),
                "mean_latency_ms": _average(m.mean_latency_ms for m in metrics),
                "mean_margin": _average((m.mean_margin for m in metrics), digits=3),
                "route_changes": sum(m.route_changes for m in metrics),
                "elapsed_ms": result.elapsed_ms,
                "clients": {m.client_id: m.as_dict() for m in metrics},
            }
        )
    return {"strategies": rows}


def _average(values: Iterable[float | None], digits: int = 2) -> float | None:
    collected = [value for value in values if value is not None]
    if not collected:
        return None
    return round(sum(collected) / len(collected), digits)
