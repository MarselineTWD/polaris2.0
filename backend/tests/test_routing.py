"""Маршрутизация на рукотворных графах и диагностика причин разрыва."""

from __future__ import annotations

import pytest

from polaris.domain.routing import (
    GapCause,
    SourceLinks,
    StepGraph,
    Strategy,
    disjoint_paths,
    find_path,
    path_is_valid,
)


def make_graph(edges: dict[int, list[tuple[int, float, float]]], n_sat: int, n_gateway: int):
    neighbours = [[] for _ in range(n_sat + n_gateway)]
    distance = [[] for _ in range(n_sat + n_gateway)]
    margin = [[] for _ in range(n_sat + n_gateway)]
    for node, links in edges.items():
        for target, length, weight in links:
            neighbours[node].append(target)
            distance[node].append(length)
            margin[node].append(weight)
    return StepGraph(
        n_sat=n_sat, n_gateway=n_gateway, neighbours=neighbours, distance=distance, margin=margin
    )


def test_single_hop_route_counts_two_ground_links() -> None:
    """Маршрут «клиент → КА → шлюз» имеет ровно два перехода."""
    graph = make_graph({0: [(1, 500.0, 0.6)]}, n_sat=1, n_gateway=1)
    sources = SourceLinks(satellites=[0], distance=[700.0], margin=[0.4])
    path = find_path(graph, sources, Strategy.MIN_HOPS.value)
    assert path is not None
    assert path.satellites == [0]
    assert path.hops == 2
    assert path.length_km == pytest.approx(1200.0)
    assert path.min_margin == pytest.approx(0.4)


def test_strategies_pick_different_routes() -> None:
    """Короткий по числу переходов путь не обязан быть лучшим по задержке и запасу."""
    # КА0 -> шлюз напрямую (длинно и с малым запасом); КА0 -> КА1 -> шлюз (короче суммарно).
    graph = make_graph(
        {
            0: [(2, 4000.0, 0.05), (1, 500.0, 0.9)],
            1: [(0, 500.0, 0.9), (2, 600.0, 0.8)],
        },
        n_sat=2,
        n_gateway=1,
    )
    sources = SourceLinks(satellites=[0], distance=[300.0], margin=[0.7])

    hops = find_path(graph, sources, Strategy.MIN_HOPS.value)
    latency = find_path(graph, sources, Strategy.MIN_LATENCY.value)
    margin = find_path(graph, sources, Strategy.MAX_MARGIN.value)

    assert hops.satellites == [0] and hops.hops == 2
    assert latency.satellites == [0, 1]
    assert latency.length_km < hops.length_km
    assert margin.satellites == [0, 1]
    assert margin.min_margin > hops.min_margin


def test_disjoint_paths_do_not_share_satellites() -> None:
    graph = make_graph(
        {0: [(2, 100.0, 0.5)], 1: [(2, 100.0, 0.5)]},
        n_sat=2,
        n_gateway=1,
    )
    sources = SourceLinks(satellites=[0, 1], distance=[100.0, 100.0], margin=[0.5, 0.5])
    paths = disjoint_paths(graph, sources, Strategy.MIN_HOPS.value, limit=3)
    assert len(paths) == 2
    assert set(paths[0].satellites).isdisjoint(paths[1].satellites)


def test_blocked_satellite_forces_detour() -> None:
    graph = make_graph(
        {0: [(2, 100.0, 0.5)], 1: [(2, 100.0, 0.5)]},
        n_sat=2,
        n_gateway=1,
    )
    sources = SourceLinks(satellites=[0, 1], distance=[100.0, 100.0], margin=[0.5, 0.5])
    path = find_path(graph, sources, Strategy.MIN_HOPS.value, blocked=frozenset({0}))
    assert path is not None and path.satellites == [1]


def test_no_route_when_gateway_unreachable() -> None:
    graph = make_graph({0: []}, n_sat=1, n_gateway=1)
    sources = SourceLinks(satellites=[0], distance=[100.0], margin=[0.5])
    assert find_path(graph, sources, Strategy.MIN_HOPS.value) is None


def test_previous_path_revalidated_when_links_survive() -> None:
    graph = make_graph({0: [(1, 500.0, 0.6)]}, n_sat=1, n_gateway=1)
    sources = SourceLinks(satellites=[0], distance=[700.0], margin=[0.4])
    original = find_path(graph, sources, Strategy.MIN_HOPS.value)
    assert path_is_valid(graph, sources, original) is not None

    # Тот же маршрут на графе без наземной линии клиента больше не существует.
    empty = SourceLinks(satellites=[], distance=[], margin=[])
    assert path_is_valid(graph, empty, original) is None


def test_diagnosis_classifies_each_cause(full_raw: dict) -> None:
    """На реальных данных встречаются осмысленные причины разрыва."""
    from polaris.domain.engine import compute_run
    from polaris.domain.scenario import parse_scenario

    result = compute_run(parse_scenario(full_raw))
    causes = set()
    for timeline in result.timelines.values():
        causes.update(int(value) for value in timeline.cause)
    assert GapCause.NONE in causes
    # В полной группировке перерывы вызваны отсутствием контакта со шлюзом
    # или разрывом межспутниковой сети, но не пропаданием покрытия целиком.
    assert causes & {GapCause.NO_GATEWAY_CONTACT, GapCause.ISL_NETWORK_SPLIT}


def test_gateway_outage_produces_matching_cause(full_raw: dict) -> None:
    from polaris.domain.engine import compute_run
    from polaris.domain.scenario import parse_scenario

    payload = dict(full_raw)
    payload["gateway_outages"] = [{"gateway_id": "G_MUR", "start_s": 0, "end_s": 3600}]
    result = compute_run(parse_scenario(payload))
    timeline = next(iter(result.timelines.values()))
    assert int(timeline.cause[0]) == GapCause.GATEWAY_UNAVAILABLE
    assert int(timeline.state[0]) != 2
