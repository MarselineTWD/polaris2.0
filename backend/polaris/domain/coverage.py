"""Двумерная карта доступности маршрута по регулярной сетке Земли."""

from __future__ import annotations

import math

import numpy as np

from .constants import EARTH_RADIUS_KM
from .engine import RunResult
from .visibility import ground_links


def coverage_grid(result: RunResult, cell_deg: int = 10) -> dict[str, object]:
    """Доля отсчётов со сквозным маршрутом для центров ячеек карты.

    Граф спутников и контакты со шлюзами уже посчитаны в ``RunResult``.
    Здесь для каждого отсчёта сначала отмечаются все аппараты, способные
    добраться до любого доступного шлюза, затем к ним проверяется видимость
    из центров ячеек. Выбор стратегии пути на сам факт доступности не влияет.
    """
    topo = result.topology
    scenario = result.scenario
    steps = topo.step_count
    satellites = topo.satellite_count
    reachable = np.zeros((steps, satellites), dtype=bool)
    pair_i, pair_j = topo.pairs

    for step in range(steps):
        neighbours: list[list[int]] = [[] for _ in range(satellites)]
        for pair in np.flatnonzero(topo.isl[step]):
            first = int(pair_i[pair])
            second = int(pair_j[pair])
            neighbours[first].append(second)
            neighbours[second].append(first)

        seeds: list[int] = []
        for gateway in scenario.gateways:
            seeds.extend(int(index) for index in np.flatnonzero(topo.ground_visible[gateway.id][step]))
        stack = list(dict.fromkeys(seeds))
        for index in stack:
            reachable[step, index] = True
        while stack:
            current = stack.pop()
            for neighbour in neighbours[current]:
                if not reachable[step, neighbour]:
                    reachable[step, neighbour] = True
                    stack.append(neighbour)

    latitudes = list(range(-90 + cell_deg // 2, 90, cell_deg))
    longitudes = list(range(-180 + cell_deg // 2, 180, cell_deg))
    values: list[float] = []
    min_elevation = scenario.environment.min_elevation_deg

    for latitude in latitudes:
        lat = math.radians(latitude)
        for longitude in longitudes:
            lon = math.radians(longitude)
            site = EARTH_RADIUS_KM * np.array(
                [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)],
                dtype=np.float64,
            )
            visible, _, _ = ground_links(topo.fixed, topo.active, site, min_elevation)
            routed = np.any(visible & reachable, axis=1)
            values.append(round(float(routed.mean()) * 100.0, 2))

    return {
        "cell_deg": cell_deg,
        "latitudes": latitudes,
        "longitudes": longitudes,
        "availability_pct": values,
        "minimum_pct": min(values) if values else 0.0,
        "maximum_pct": max(values) if values else 0.0,
        "mean_pct": round(sum(values) / len(values), 2) if values else 0.0,
    }
