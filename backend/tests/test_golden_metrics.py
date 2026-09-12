"""Контрольные значения показателей — защита от регрессий расчёта.

Числа для полной группировки и первой очереди совпадают с эталонными
значениями из комплекта задания; остальные получены этой же моделью и
перепроверены независимым обходом связности.
"""

from __future__ import annotations

import pytest

from polaris.domain.engine import compute_run
from polaris.domain.scenario import parse_scenario

from .conftest import load_raw

GOLDEN = {
    "01_full_constellation": {
        "C65": (96.67, 97.78, 480.0, 2.29),
        "C70": (98.75, 99.86, 120.0, 2.66),
        "C72": (98.89, 100.00, 120.0, 3.15),
    },
    "02_first_launch": {
        "C65": (27.22, 38.19, 34320.0, 2.07),
        "C70": (15.83, 48.75, 39480.0, 2.14),
        "C72": (12.64, 58.47, 47760.0, 3.12),
    },
    "03_satellite_outages": {
        "C65": (79.31, 84.58, 1440.0, 2.35),
        "C70": (80.83, 90.28, 1440.0, 2.77),
        "C72": (82.50, 93.06, 1200.0, 3.28),
    },
    "04_link_range": {
        "C65": (77.50, 97.78, 5640.0, 2.07),
        "C70": (62.22, 99.86, 10680.0, 2.38),
        "C72": (65.14, 100.00, 240.0, 3.36),
    },
}


@pytest.mark.parametrize("scenario_id", sorted(GOLDEN))
def test_metrics_match_golden(scenario_id: str) -> None:
    scenario = parse_scenario(load_raw(scenario_id))
    result = compute_run(scenario)
    produced = {metric.client_id: metric for metric in result.metrics}

    for client_id, (availability, visibility, max_gap, hops) in GOLDEN[scenario_id].items():
        metric = produced[client_id]
        assert metric.availability_pct == pytest.approx(availability, abs=0.01)
        assert metric.visibility_pct == pytest.approx(visibility, abs=0.01)
        assert metric.max_gap_s == pytest.approx(max_gap, abs=0.5)
        assert metric.mean_hops == pytest.approx(hops, abs=0.01)


def test_availability_is_strategy_independent() -> None:
    """Существование пути не зависит от стратегии — меняются только его свойства."""
    from polaris.domain.analysis import compare_strategies

    scenario = parse_scenario(load_raw("04_link_range"))
    rows = compare_strategies(scenario)["strategies"]
    values = {row["min_availability_pct"] for row in rows}
    assert len(values) == 1, "доступность не должна зависеть от стратегии маршрутизации"
    # А вот запас линии обязан быть наибольшим у стратегии максимального запаса.
    by_strategy = {row["strategy"]: row for row in rows}
    assert by_strategy["max_margin"]["mean_margin"] > by_strategy["min_hops"]["mean_margin"]
    assert by_strategy["min_latency"]["mean_latency_ms"] <= by_strategy["min_hops"]["mean_latency_ms"]


def test_time_grid_excludes_right_end() -> None:
    scenario = parse_scenario(load_raw("01_full_constellation"))
    result = compute_run(scenario)
    times = result.times
    assert times[0] == 0.0
    assert times[-1] == 86280.0
    assert len(times) == 720


def test_stage_one_is_subset_of_full() -> None:
    """Первая очередь не может быть лучше полной группировки."""
    full = compute_run(parse_scenario(load_raw("01_full_constellation")))
    first = compute_run(parse_scenario(load_raw("02_first_launch")))
    assert first.min_availability() < full.min_availability()
