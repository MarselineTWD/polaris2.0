"""Оркестрация расчёта: сценарий → полное состояние сети на горизонте.

Единственный проход по времени строит граф отсчёта и переиспользует его для
всех наземных пунктов и всех видов анализа. Это важно: построение графа —
самая дорогая часть шага, а стратегий и пунктов может быть несколько.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .ephemeris import positions_at
from .metrics import ClientMetrics, summarize_client
from .resilience import CriticalityAccumulator, critical_satellites
from .routing import (
    GapCause,
    LinkState,
    PathResult,
    Strategy,
    build_step_graph,
    client_sources,
    diagnose,
    disjoint_paths,
    path_is_valid,
)
from .scenario import Scenario
from .visibility import Topology


@dataclass(slots=True)
class RunOptions:
    """Настройки расчёта, не входящие в сам сценарий."""

    strategy: str = Strategy.MIN_HOPS.value
    hysteresis: float = 0.15
    """Допуск, в пределах которого прежний маршрут сохраняется вместо оптимального."""
    backup_limit: int = 3
    """Сколько узлонепересекающихся маршрутов искать (1 — только основной)."""
    with_criticality: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "strategy": self.strategy,
            "hysteresis": self.hysteresis,
            "backup_limit": self.backup_limit,
            "with_criticality": self.with_criticality,
        }


@dataclass(slots=True)
class ClientTimeline:
    """Поотсчётное состояние одного наземного пункта."""

    client_id: str
    client_name: str
    state: np.ndarray
    cause: np.ndarray
    hops: np.ndarray
    length_km: np.ndarray
    latency_ms: np.ndarray
    margin: np.ndarray
    diversity: np.ndarray
    changed: np.ndarray
    required_range_km: np.ndarray
    gateway: np.ndarray
    paths: list[list[int]]
    metrics: ClientMetrics | None = None


def _acceptable(previous: PathResult, best: PathResult, strategy: str, eps: float) -> bool:
    """Достаточно ли хорош прежний маршрут, чтобы не перестраивать сеть."""
    if strategy == Strategy.MIN_HOPS.value:
        return previous.hops <= best.hops
    if strategy == Strategy.MIN_LATENCY.value:
        return previous.length_km <= best.length_km * (1.0 + eps)
    if strategy == Strategy.MAX_MARGIN.value:
        return previous.min_margin >= best.min_margin * (1.0 - eps)
    return False


def _same_route(a: PathResult, b: PathResult) -> bool:
    return a.gateway == b.gateway and a.satellites == b.satellites


@dataclass(slots=True)
class RunResult:
    """Полный результат расчёта одного варианта проекта."""

    scenario: Scenario
    topology: Topology
    options: RunOptions
    timelines: dict[str, ClientTimeline]
    criticality: CriticalityAccumulator
    elapsed_ms: float
    recommendations: list[dict[str, Any]] = field(default_factory=list)

    @property
    def times(self) -> np.ndarray:
        return self.topology.times

    @property
    def metrics(self) -> list[ClientMetrics]:
        return [t.metrics for t in self.timelines.values() if t.metrics is not None]

    def min_availability(self) -> float:
        values = [m.availability_pct for m in self.metrics]
        return min(values) if values else 0.0

    def mean_availability(self) -> float:
        values = [m.availability_pct for m in self.metrics]
        return round(sum(values) / len(values), 2) if values else 0.0

    def worst_client(self) -> str | None:
        metrics = self.metrics
        if not metrics:
            return None
        return min(metrics, key=lambda m: m.availability_pct).client_id


def compute_run(
    scenario: Scenario,
    options: RunOptions | None = None,
    *,
    topology: Topology | None = None,
) -> RunResult:
    """Рассчитать состояние сети и маршруты на всём горизонте."""
    options = options or RunOptions()
    started = time.perf_counter()
    topo = topology if topology is not None else Topology(scenario)

    clients = scenario.clients
    steps = topo.step_count
    n_sat = topo.satellite_count

    timelines: dict[str, ClientTimeline] = {}
    for client in clients:
        timelines[client.id] = ClientTimeline(
            client_id=client.id,
            client_name=client.name,
            state=np.zeros(steps, dtype=np.int8),
            cause=np.zeros(steps, dtype=np.int8),
            hops=np.full(steps, np.nan),
            length_km=np.full(steps, np.nan),
            latency_ms=np.full(steps, np.nan),
            margin=np.full(steps, np.nan),
            diversity=np.zeros(steps, dtype=np.int8),
            changed=np.zeros(steps, dtype=bool),
            required_range_km=np.full(steps, np.nan),
            gateway=np.full(steps, -1, dtype=np.int8),
            paths=[[] for _ in range(steps)],
        )

    criticality = CriticalityAccumulator(satellite_count=n_sat)
    previous: dict[str, PathResult | None] = {client.id: None for client in clients}
    backup_limit = max(1, options.backup_limit)

    for step in range(steps):
        graph = build_step_graph(topo, step)
        for client in clients:
            timeline = timelines[client.id]
            sources = client_sources(topo, client.id, step)

            alternatives = (
                disjoint_paths(graph, sources, options.strategy, backup_limit)
                if sources.satellites
                else []
            )
            if not alternatives:
                cause, required = diagnose(topo, client.id, step, graph, sources)
                timeline.state[step] = (
                    LinkState.NO_VISIBILITY
                    if cause == GapCause.NO_VISIBLE_SATELLITE
                    else LinkState.VISIBLE_NO_PATH
                )
                timeline.cause[step] = int(cause)
                if required is not None:
                    timeline.required_range_km[step] = required
                continue

            best = alternatives[0]
            chosen = best
            prior = previous[client.id]
            if prior is not None:
                revalidated = path_is_valid(graph, sources, prior)
                if revalidated is not None and _acceptable(
                    revalidated, best, options.strategy, options.hysteresis
                ):
                    chosen = revalidated

            if prior is not None and not _same_route(chosen, prior):
                timeline.changed[step] = True
            previous[client.id] = chosen

            timeline.state[step] = LinkState.ROUTED
            timeline.cause[step] = int(GapCause.NONE)
            timeline.hops[step] = chosen.hops
            timeline.length_km[step] = chosen.length_km
            timeline.latency_ms[step] = chosen.latency_ms
            timeline.margin[step] = chosen.min_margin
            timeline.diversity[step] = min(len(alternatives), 127)
            timeline.gateway[step] = chosen.gateway
            timeline.paths[step] = list(chosen.satellites)

            if options.with_criticality:
                # Два узлонепересекающихся маршрута означают, что ни один
                # отдельный аппарат не является точкой сочленения.
                critical = (
                    []
                    if len(alternatives) >= 2
                    else critical_satellites(graph, sources, chosen)
                )
                criticality.observe(client.id, chosen.satellites, critical)

    env = scenario.environment
    for client in clients:
        timeline = timelines[client.id]
        timeline.metrics = summarize_client(
            client_id=client.id,
            client_name=client.name,
            state=timeline.state,
            cause=timeline.cause,
            hops=timeline.hops,
            latency_ms=timeline.latency_ms,
            margin=timeline.margin,
            diversity=timeline.diversity,
            changed=timeline.changed,
            times=topo.times,
            step_s=float(env.step_s),
            target_availability=env.target_availability,
        )

    return RunResult(
        scenario=scenario,
        topology=topo,
        options=options,
        timelines=timelines,
        criticality=criticality,
        elapsed_ms=round((time.perf_counter() - started) * 1000.0, 2),
    )


def snapshot(scenario: Scenario, t_s: float) -> dict[str, Any]:
    """Состояние сети в произвольный момент времени.

    Формат намеренно повторяет ``snapshot()`` эталонного модуля
    ``Расчетный модуль/geometry.py``: это позволяет сверить наш расчёт
    с поставленным организаторами кодом напрямую.
    """
    from .ephemeris import active_mask, ground_position
    from .visibility import ground_links, isl_links, pair_indices

    times = np.array([float(t_s)], dtype=np.float64)
    _, fixed = positions_at(scenario, times)
    active = active_mask(scenario, times)
    env = scenario.environment
    sat_ids = scenario.satellite_ids

    pairs = pair_indices(len(sat_ids))
    available, distance, _ = isl_links(fixed, active, env.isl_range_km, pairs)
    edges: list[list[Any]] = [
        [sat_ids[int(pairs[0][p])], sat_ids[int(pairs[1][p])], float(distance[0, p])]
        for p in np.flatnonzero(available[0])
    ]

    elevation_deg: dict[str, dict[str, float]] = {}
    gateway_online = {
        gw.id: bool(mask[0]) for gw, mask in (
            (gw, np.array([True])) for gw in scenario.gateways
        )
    }
    for outage in scenario.gateway_outages:
        if outage.start_s <= t_s < outage.end_s:
            gateway_online[outage.target_id] = False

    for site in scenario.ground_sites:
        visible, elevation, site_distance = ground_links(
            fixed, active, ground_position(site), env.min_elevation_deg
        )
        elevation_deg[site.id] = {
            sat_ids[k]: float(elevation[0, k])
            for k in range(len(sat_ids))
            if active[0, k]
        }
        if site.is_gateway and not gateway_online.get(site.id, True):
            continue
        edges.extend(
            [site.id, sat_ids[int(k)], float(site_distance[0, int(k)])]
            for k in np.flatnonzero(visible[0])
        )

    return {
        "t_s": float(t_s),
        "satellites": [
            {
                "id": sat_ids[k],
                "x_km": float(fixed[0, k, 0]),
                "y_km": float(fixed[0, k, 1]),
                "z_km": float(fixed[0, k, 2]),
                "active": bool(active[0, k]),
            }
            for k in range(len(sat_ids))
        ],
        "edges": edges,
        "elevation_deg": elevation_deg,
    }
