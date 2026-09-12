"""Соответствие выгрузки схеме ``cosmo-A-result-1.0``."""

from __future__ import annotations

import json
import math

from polaris.domain.constants import RESULT_SCHEMA_VERSION
from polaris.domain.engine import compute_run
from polaris.domain.scenario import parse_scenario
from polaris.domain.serialize import export_result, pack_bundle

from .conftest import load_raw


def build(scenario_id: str = "01_full_constellation"):
    scenario = parse_scenario(load_raw(scenario_id))
    return compute_run(scenario)


def test_export_has_record_per_time_and_client() -> None:
    result = build()
    payload = export_result(result)
    expected = result.topology.step_count * len(result.scenario.clients)

    assert payload["schema_version"] == RESULT_SCHEMA_VERSION
    assert len(payload["routes"]) == expected

    seen = {(row["t_s"], row["client_id"]) for row in payload["routes"]}
    assert len(seen) == expected


def test_export_paths_start_at_client_and_end_at_gateway() -> None:
    result = build()
    payload = export_result(result)
    satellites = set(result.scenario.satellite_ids)
    clients = {site.id for site in result.scenario.clients}
    gateways = {site.id for site in result.scenario.gateways}

    routed = [row for row in payload["routes"] if row["path"]]
    assert routed, "в полной группировке маршруты обязаны существовать"
    for row in routed:
        path = row["path"]
        assert path[0] == row["client_id"] and path[0] in clients
        assert path[-1] in gateways
        assert len(path) >= 3, "маршрут проходит минимум через один аппарат"
        assert all(node in satellites for node in path[1:-1])


def test_export_is_finite_json() -> None:
    """Схема требует конечных чисел: NaN и Infinity недопустимы."""
    payload = export_result(build("04_link_range"))
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    assert "NaN" not in encoded and "Infinity" not in encoded


def test_effective_scenario_reparses() -> None:
    """Выгруженный сценарий можно загрузить обратно без правок."""
    result = build("03_satellite_outages")
    payload = export_result(result)
    restored = parse_scenario(payload["effective_scenario"])
    assert restored.content_hash() == result.scenario.content_hash()


def test_bundle_is_serialisable_and_compact() -> None:
    result = build()
    bundle = pack_bundle(result, "run_test")
    encoded = json.dumps(bundle, ensure_ascii=False, allow_nan=False).encode("utf-8")
    assert bundle["schema"] == "polaris-bundle-1"
    assert bundle["step_count"] == 720
    assert len(encoded) < 1_500_000
    assert set(bundle["clients"]) == {site.id for site in result.scenario.clients}


def test_summary_reports_target_state() -> None:
    bundle = pack_bundle(build(), "run_test")
    summary = bundle["summary"]
    assert summary["target_pct"] == 90.0
    assert summary["target_met"] is True
    assert summary["min_availability_pct"] == 96.67
    assert len(summary["clients"]) == 3
