"""Паритет с эталонным модулем ``Расчетный модуль/geometry.py``.

Главный тест корректности: положения аппаратов, состав доступных связей и
углы возвышения должны совпадать с поставленным организаторами кодом.
"""

from __future__ import annotations

import numpy as np
import pytest

import geometry  # эталонный модуль, путь добавлен в conftest

from polaris.domain.engine import snapshot
from polaris.domain.ephemeris import positions_at
from polaris.domain.scenario import parse_scenario

CHECK_TIMES = [0.0, 120.0, 3600.0, 43200.0, 86280.0]
TOLERANCE_KM = 1e-9
TOLERANCE_DEG = 1e-9


@pytest.mark.parametrize("t_s", CHECK_TIMES)
def test_positions_match_reference(raw_scenario: dict, t_s: float) -> None:
    scenario = parse_scenario(raw_scenario)
    reference_ids, reference_inertial, reference_fixed = geometry.positions(raw_scenario, t_s)
    inertial, fixed = positions_at(scenario, np.array([t_s]))

    assert scenario.satellite_ids == reference_ids
    assert np.abs(inertial[0] - reference_inertial).max() < TOLERANCE_KM
    assert np.abs(fixed[0] - reference_fixed).max() < TOLERANCE_KM


@pytest.mark.parametrize("t_s", CHECK_TIMES)
def test_snapshot_matches_reference(raw_scenario: dict, t_s: float) -> None:
    scenario = parse_scenario(raw_scenario)
    reference = geometry.snapshot(raw_scenario, t_s)
    produced = snapshot(scenario, t_s)

    # Состав активных аппаратов и их координаты.
    reference_sats = {item["id"]: item for item in reference["satellites"]}
    for item in produced["satellites"]:
        counterpart = reference_sats[item["id"]]
        assert item["active"] == counterpart["active"]
        for axis in ("x_km", "y_km", "z_km"):
            assert abs(item[axis] - counterpart[axis]) < TOLERANCE_KM

    # Множество рёбер должно совпадать вплоть до длины линии.
    def as_map(edges: list) -> dict[tuple[str, str], float]:
        return {tuple(sorted((a, b))): length for a, b, length in edges}

    produced_edges = as_map(produced["edges"])
    reference_edges = as_map(reference["edges"])
    assert produced_edges.keys() == reference_edges.keys()
    for key, length in produced_edges.items():
        assert abs(length - reference_edges[key]) < TOLERANCE_KM

    # Углы возвышения по каждому наземному пункту.
    assert produced["elevation_deg"].keys() == reference["elevation_deg"].keys()
    for site_id, angles in produced["elevation_deg"].items():
        counterpart = reference["elevation_deg"][site_id]
        assert angles.keys() == counterpart.keys()
        for satellite_id, value in angles.items():
            assert abs(value - counterpart[satellite_id]) < TOLERANCE_DEG


def test_timeline_agrees_with_snapshot(full_raw: dict) -> None:
    """Связи на расчётной сетке совпадают с независимым разовым снимком."""
    from polaris.domain.visibility import Topology

    scenario = parse_scenario(full_raw)
    topo = Topology(scenario)
    for step in (0, 1, 137, 719):
        moment = float(topo.times[step])
        reference = geometry.snapshot(full_raw, moment)
        reference_isl = {
            tuple(sorted((a, b)))
            for a, b, _ in reference["edges"]
            if a in topo.sat_index and b in topo.sat_index
        }
        pair_i, pair_j = topo.pairs
        produced_isl = {
            tuple(sorted((topo.sat_ids[pair_i[p]], topo.sat_ids[pair_j[p]])))
            for p in np.flatnonzero(topo.isl[step])
        }
        assert produced_isl == reference_isl
