"""Поиск маршрутов «наземный пункт → спутники → шлюз» и диагностика разрывов.

Маршрут начинается в выбранном клиентском пункте, проходит через один или
несколько активных аппаратов и заканчивается в доступном шлюзе. Промежуточные
узлы маршрута — только спутники: клиентские пункты не ретранслируют трафик,
шлюз является стоком.

Реализованы три стратегии поиска на одном и том же графе:

``min_hops``
    Поиск в ширину — минимальное число переходов. Число переходов равно числу
    рёбер маршрута и включает обе наземные линии.
``min_latency``
    Дейкстра по длине линий — минимальная задержка распространения.
``max_margin``
    Поиск широчайшего пути (max-min) — маршрут с наибольшим запасом по углу
    возвышения и дальности ISL, наиболее устойчивый к движению аппаратов.

Поверх стратегии работает гистерезис: пока маршрут предыдущего отсчёта
допустим и не хуже оптимального более чем на заданный допуск, он сохраняется.
Это убирает «дрожание» маршрута между равноценными вариантами и даёт метрику
числа перестроений.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from enum import Enum, IntEnum
import numpy as np

from .constants import SPEED_OF_LIGHT_KM_S
from .visibility import Topology


class LinkState(IntEnum):
    """Состояние наземного пункта на отсчёте — совпадает с легендой интерфейса."""

    NO_VISIBILITY = 0
    """Нет ни одного видимого активного аппарата."""
    VISIBLE_NO_PATH = 1
    """Покрытие есть, но сквозного маршрута до шлюза нет."""
    ROUTED = 2
    """Сквозной маршрут существует."""


class GapCause(IntEnum):
    """Причина отсутствия сквозного маршрута."""

    NONE = 0
    NO_VISIBLE_SATELLITE = 1
    """Над пунктом нет активного аппарата."""
    GATEWAY_UNAVAILABLE = 2
    """Все шлюзы находятся в периоде недоступности."""
    NO_GATEWAY_CONTACT = 3
    """Шлюз доступен, но его не видит ни один активный аппарат."""
    ISL_NETWORK_SPLIT = 4
    """Обе стороны видят аппараты, но межспутниковая сеть разорвана."""


CAUSE_LABELS: dict[int, str] = {
    GapCause.NONE: "маршрут есть",
    GapCause.NO_VISIBLE_SATELLITE: "нет видимого спутника",
    GapCause.GATEWAY_UNAVAILABLE: "шлюз недоступен",
    GapCause.NO_GATEWAY_CONTACT: "нет контакта со шлюзом",
    GapCause.ISL_NETWORK_SPLIT: "разрыв межспутниковой сети",
}


class Strategy(str, Enum):
    """Стратегия поиска маршрута."""

    MIN_HOPS = "min_hops"
    MIN_LATENCY = "min_latency"
    MAX_MARGIN = "max_margin"


STRATEGY_LABELS: dict[str, str] = {
    Strategy.MIN_HOPS.value: "минимум переходов",
    Strategy.MIN_LATENCY.value: "минимальная задержка",
    Strategy.MAX_MARGIN.value: "максимальный запас линии",
}


@dataclass(slots=True)
class StepGraph:
    """Граф сети на одном отсчёте времени.

    Узлы ``0..n_sat-1`` — аппараты, ``n_sat + g`` — шлюз с индексом ``g``.
    Шлюзы являются стоками и никогда не раскрываются при обходе.
    """

    n_sat: int
    n_gateway: int
    neighbours: list[list[int]]
    distance: list[list[float]]
    margin: list[list[float]]

    @property
    def n_nodes(self) -> int:
        return self.n_sat + self.n_gateway

    def is_gateway(self, node: int) -> bool:
        return node >= self.n_sat


def _ground_margin(elevation_deg: float, min_elevation_deg: float) -> float:
    """Нормированный запас наземной линии по углу возвышения, 0…1."""
    span = max(90.0 - min_elevation_deg, 1e-9)
    return max(0.0, min(1.0, (elevation_deg - min_elevation_deg) / span))


def _isl_margin(distance_km: float, isl_range_km: float) -> float:
    """Нормированный запас межспутниковой линии по дальности, 0…1."""
    return max(0.0, min(1.0, (isl_range_km - distance_km) / max(isl_range_km, 1e-9)))


def build_step_graph(topo: Topology, step: int) -> StepGraph:
    """Собрать граф «аппараты + шлюзы» для отсчёта ``step``."""
    scenario = topo.scenario
    env = scenario.environment
    n_sat = topo.satellite_count
    gateways = scenario.gateways
    n_nodes = n_sat + len(gateways)

    neighbours: list[list[int]] = [[] for _ in range(n_nodes)]
    distance: list[list[float]] = [[] for _ in range(n_nodes)]
    margin: list[list[float]] = [[] for _ in range(n_nodes)]

    pair_i, pair_j = topo.pairs
    active_pairs = np.flatnonzero(topo.isl[step])
    distances = topo.isl_distance[step]
    isl_range = env.isl_range_km
    for p in active_pairs:
        u = int(pair_i[p])
        v = int(pair_j[p])
        d = float(distances[p])
        m = _isl_margin(d, isl_range)
        neighbours[u].append(v)
        distance[u].append(d)
        margin[u].append(m)
        neighbours[v].append(u)
        distance[v].append(d)
        margin[v].append(m)

    min_elevation = env.min_elevation_deg
    for g, gateway in enumerate(gateways):
        node = n_sat + g
        visible = topo.ground_visible[gateway.id][step]
        elevations = topo.ground_elevation[gateway.id][step]
        ranges = topo.ground_distance[gateway.id][step]
        for sat in np.flatnonzero(visible):
            sat = int(sat)
            d = float(ranges[sat])
            m = _ground_margin(float(elevations[sat]), min_elevation)
            neighbours[sat].append(node)
            distance[sat].append(d)
            margin[sat].append(m)
            # Обратное ребро не добавляем: шлюз — сток, он ничего не ретранслирует.
    return StepGraph(
        n_sat=n_sat,
        n_gateway=len(gateways),
        neighbours=neighbours,
        distance=distance,
        margin=margin,
    )


@dataclass(slots=True)
class SourceLinks:
    """Наземные линии выбранного клиента на одном отсчёте."""

    satellites: list[int]
    distance: list[float]
    margin: list[float]


def client_sources(topo: Topology, client_id: str, step: int) -> SourceLinks:
    min_elevation = topo.scenario.environment.min_elevation_deg
    visible = np.flatnonzero(topo.ground_visible[client_id][step])
    elevations = topo.ground_elevation[client_id][step]
    ranges = topo.ground_distance[client_id][step]
    sats = [int(s) for s in visible]
    return SourceLinks(
        satellites=sats,
        distance=[float(ranges[s]) for s in sats],
        margin=[_ground_margin(float(elevations[s]), min_elevation) for s in sats],
    )


@dataclass(slots=True)
class PathResult:
    """Найденный маршрут в индексах узлов графа."""

    satellites: list[int]
    gateway: int
    hops: int
    length_km: float
    min_margin: float

    @property
    def latency_ms(self) -> float:
        return self.length_km / SPEED_OF_LIGHT_KM_S * 1000.0


def _reconstruct(parent: dict[int, int], node: int) -> list[int]:
    chain: list[int] = []
    current = node
    while current != -1:
        chain.append(current)
        current = parent.get(current, -1)
    chain.reverse()
    return chain


def _finalize(
    chain: list[int],
    graph: StepGraph,
    sources: SourceLinks,
) -> PathResult:
    """Собрать метрики маршрута по цепочке узлов ``[sat..., gateway]``."""
    satellites = [node for node in chain if not graph.is_gateway(node)]
    gateway = chain[-1] - graph.n_sat

    source_index = sources.satellites.index(satellites[0])
    length = sources.distance[source_index]
    bottleneck = sources.margin[source_index]

    for a, b in zip(chain, chain[1:]):
        position = graph.neighbours[a].index(b)
        length += graph.distance[a][position]
        bottleneck = min(bottleneck, graph.margin[a][position])

    return PathResult(
        satellites=satellites,
        gateway=gateway,
        # Рёбра: клиент→первый КА, переходы между КА, последний КА→шлюз.
        # chain это [КА..., шлюз], поэтому число рёбер совпадает с его длиной.
        hops=len(chain),
        length_km=length,
        min_margin=bottleneck,
    )


def _search_min_hops(
    graph: StepGraph, sources: SourceLinks, blocked: frozenset[int]
) -> PathResult | None:
    parent: dict[int, int] = {}
    queue: list[int] = []
    for sat in sources.satellites:
        if sat in blocked:
            continue
        parent[sat] = -1
        queue.append(sat)

    head = 0
    while head < len(queue):
        node = queue[head]
        head += 1
        if graph.is_gateway(node):
            return _finalize(_reconstruct(parent, node), graph, sources)
        for neighbour in graph.neighbours[node]:
            if neighbour in parent or neighbour in blocked:
                continue
            parent[neighbour] = node
            queue.append(neighbour)
    return None


def _search_min_latency(
    graph: StepGraph, sources: SourceLinks, blocked: frozenset[int]
) -> PathResult | None:
    best: dict[int, float] = {}
    parent: dict[int, int] = {}
    heap: list[tuple[float, int]] = []
    for sat, reach in zip(sources.satellites, sources.distance):
        if sat in blocked:
            continue
        if reach < best.get(sat, math.inf):
            best[sat] = reach
            parent[sat] = -1
            heapq.heappush(heap, (reach, sat))

    settled: set[int] = set()
    while heap:
        cost, node = heapq.heappop(heap)
        if node in settled or cost > best.get(node, math.inf):
            continue
        settled.add(node)
        if graph.is_gateway(node):
            return _finalize(_reconstruct(parent, node), graph, sources)
        for neighbour, edge in zip(graph.neighbours[node], graph.distance[node]):
            if neighbour in settled or neighbour in blocked:
                continue
            candidate = cost + edge
            if candidate < best.get(neighbour, math.inf):
                best[neighbour] = candidate
                parent[neighbour] = node
                heapq.heappush(heap, (candidate, neighbour))
    return None


def _search_max_margin(
    graph: StepGraph, sources: SourceLinks, blocked: frozenset[int]
) -> PathResult | None:
    best: dict[int, float] = {}
    parent: dict[int, int] = {}
    heap: list[tuple[float, int]] = []
    for sat, reach in zip(sources.satellites, sources.margin):
        if sat in blocked:
            continue
        if reach > best.get(sat, -math.inf):
            best[sat] = reach
            parent[sat] = -1
            heapq.heappush(heap, (-reach, sat))

    settled: set[int] = set()
    while heap:
        negative, node = heapq.heappop(heap)
        value = -negative
        if node in settled or value < best.get(node, -math.inf):
            continue
        settled.add(node)
        if graph.is_gateway(node):
            return _finalize(_reconstruct(parent, node), graph, sources)
        for neighbour, edge in zip(graph.neighbours[node], graph.margin[node]):
            if neighbour in settled or neighbour in blocked:
                continue
            candidate = min(value, edge)
            if candidate > best.get(neighbour, -math.inf):
                best[neighbour] = candidate
                parent[neighbour] = node
                heapq.heappush(heap, (-candidate, neighbour))
    return None


_SEARCHES = {
    Strategy.MIN_HOPS.value: _search_min_hops,
    Strategy.MIN_LATENCY.value: _search_min_latency,
    Strategy.MAX_MARGIN.value: _search_max_margin,
}

_EMPTY: frozenset[int] = frozenset()


def find_path(
    graph: StepGraph,
    sources: SourceLinks,
    strategy: str = Strategy.MIN_HOPS.value,
    blocked: frozenset[int] = _EMPTY,
) -> PathResult | None:
    """Найти маршрут выбранной стратегией, игнорируя аппараты из ``blocked``."""
    search = _SEARCHES.get(strategy)
    if search is None:
        raise ValueError(f"Неизвестная стратегия маршрутизации: {strategy}")
    if not sources.satellites:
        return None
    return search(graph, sources, blocked)


def disjoint_paths(
    graph: StepGraph,
    sources: SourceLinks,
    strategy: str,
    limit: int = 3,
) -> list[PathResult]:
    """Найти до ``limit`` маршрутов, не пересекающихся по аппаратам.

    Каждый следующий путь ищется после исключения всех аппаратов предыдущих —
    это даёт оценку резервирования: сколько независимых направлений передачи
    реально существует в данный момент.
    """
    found: list[PathResult] = []
    blocked: set[int] = set()
    for _ in range(limit):
        path = find_path(graph, sources, strategy, frozenset(blocked))
        if path is None:
            break
        found.append(path)
        blocked.update(path.satellites)
    return found


def path_is_valid(
    graph: StepGraph, sources: SourceLinks, path: PathResult
) -> PathResult | None:
    """Проверить, существует ли прежний маршрут на текущем отсчёте.

    Возвращает пересчитанные метрики (длина и запас меняются с движением
    аппаратов) либо ``None``, если хотя бы одно звено пропало.
    """
    if not path.satellites or path.satellites[0] not in sources.satellites:
        return None
    chain = [*path.satellites, graph.n_sat + path.gateway]
    for a, b in zip(chain, chain[1:]):
        if b not in graph.neighbours[a]:
            return None
    return _finalize(chain, graph, sources)


def diagnose(
    topo: Topology,
    client_id: str,
    step: int,
    graph: StepGraph,
    sources: SourceLinks,
) -> tuple[GapCause, float | None]:
    """Определить причину отсутствия маршрута и требуемую дальность ISL.

    Вторым значением возвращается минимальная дальность межспутниковой связи,
    при которой компонента клиента соединилась бы со «шлюзовыми» аппаратами
    (только для ``ISL_NETWORK_SPLIT``), иначе ``None``.
    """
    scenario = topo.scenario
    if not sources.satellites:
        return GapCause.NO_VISIBLE_SATELLITE, None

    online = [gw for gw in scenario.gateways if topo.gateway_online[gw.id][step]]
    if not online:
        return GapCause.GATEWAY_UNAVAILABLE, None

    gateway_side: set[int] = set()
    for gateway in online:
        gateway_side.update(int(s) for s in np.flatnonzero(topo.ground_visible[gateway.id][step]))
    if not gateway_side:
        return GapCause.NO_GATEWAY_CONTACT, None

    # Компонента связности, достижимая от клиента по существующим линиям ISL.
    reachable: set[int] = set()
    stack = [sat for sat in sources.satellites]
    reachable.update(stack)
    while stack:
        node = stack.pop()
        for neighbour in graph.neighbours[node]:
            if graph.is_gateway(neighbour) or neighbour in reachable:
                continue
            reachable.add(neighbour)
            stack.append(neighbour)

    required = _required_isl_range(topo, step, reachable, gateway_side)
    return GapCause.ISL_NETWORK_SPLIT, required


def _required_isl_range(
    topo: Topology,
    step: int,
    left: set[int],
    right: set[int],
) -> float | None:
    """Минимальная дальность ISL, соединяющая две группы аппаратов.

    Учитываются только линии, не перекрытые Землёй: те, что упираются в
    планету, увеличением дальности не восстанавливаются.
    """
    if not left or not right:
        return None
    pair_i, pair_j = topo.pairs
    clear = topo.isl_clear[step]
    distances = topo.isl_distance[step]
    active = topo.active[step]

    in_left = np.zeros(topo.satellite_count, dtype=bool)
    in_right = np.zeros(topo.satellite_count, dtype=bool)
    in_left[list(left)] = True
    in_right[list(right)] = True

    crossing = clear & (
        (in_left[pair_i] & in_right[pair_j]) | (in_right[pair_i] & in_left[pair_j])
    ) & active[pair_i] & active[pair_j]
    if not crossing.any():
        return None
    return float(distances[crossing].min())
