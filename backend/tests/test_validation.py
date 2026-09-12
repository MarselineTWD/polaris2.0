"""Проверка входа: каждое правило указывает на конкретное поле."""

from __future__ import annotations

import copy

import pytest

from polaris.domain.scenario import ScenarioValidationError, parse_scenario

from .conftest import load_raw


@pytest.fixture
def payload() -> dict:
    return copy.deepcopy(load_raw("01_full_constellation"))


def issues_for(payload: dict) -> dict[str, str]:
    with pytest.raises(ScenarioValidationError) as error:
        parse_scenario(payload)
    return {issue.path: issue.code for issue in error.value.issues}


def test_valid_scenario_round_trips(payload: dict) -> None:
    scenario = parse_scenario(payload)
    again = parse_scenario(scenario.to_dict())
    assert again.content_hash() == scenario.content_hash()


def test_unsupported_schema_version(payload: dict) -> None:
    payload["schema_version"] = "cosmo-B-2.0"
    assert issues_for(payload) == {"schema_version": "schema_version"}


def test_non_finite_value_points_at_field(payload: dict) -> None:
    payload["design"]["satellites"][17]["slot_deg"] = "abc"
    assert issues_for(payload)["design.satellites[17].slot_deg"] == "not_finite"


def test_duplicate_satellite_id(payload: dict) -> None:
    payload["design"]["satellites"][5]["id"] = payload["design"]["satellites"][4]["id"]
    assert issues_for(payload)["design.satellites[5].id"] == "duplicate"


def test_unknown_plane_reference(payload: dict) -> None:
    payload["design"]["satellites"][0]["plane_id"] = "P9"
    assert issues_for(payload)["design.satellites[0].plane_id"] == "unknown_reference"


def test_horizon_must_be_multiple_of_step(payload: dict) -> None:
    payload["environment"]["horizon_s"] = 86401
    assert issues_for(payload)["environment.horizon_s"] == "not_multiple"


def test_step_must_be_integer_seconds(payload: dict) -> None:
    payload["environment"]["step_s"] = 120.5
    assert issues_for(payload)["environment.step_s"] == "not_integer"


def test_angles_outside_range(payload: dict) -> None:
    payload["design"]["planes"][1]["raan_deg"] = 360.0
    assert issues_for(payload)["design.planes[1].raan_deg"] == "range"


def test_altitude_outside_model_range(payload: dict) -> None:
    payload["environment"]["altitude_km"] = 42_000.0
    assert issues_for(payload)["environment.altitude_km"] == "range"


def test_outage_must_fit_inside_horizon(payload: dict) -> None:
    payload["failures"] = [{"satellite_id": "S01", "start_s": 0, "end_s": 999_999}]
    assert issues_for(payload)["failures[0].end_s"] == "range"


def test_outage_requires_positive_duration(payload: dict) -> None:
    payload["failures"] = [{"satellite_id": "S01", "start_s": 600, "end_s": 600}]
    assert issues_for(payload)["failures[0].end_s"] == "range"


def test_outage_reference_must_resolve(payload: dict) -> None:
    payload["failures"] = [{"satellite_id": "S99", "start_s": 0, "end_s": 600}]
    assert issues_for(payload)["failures[0].satellite_id"] == "unknown_reference"


def test_gateway_outage_must_reference_gateway(payload: dict) -> None:
    payload["gateway_outages"] = [{"gateway_id": "C65", "start_s": 0, "end_s": 600}]
    assert issues_for(payload)["gateway_outages[0].gateway_id"] == "unknown_reference"


def test_node_ids_must_be_distinct(payload: dict) -> None:
    payload["ground_sites"][1]["id"] = "S01"
    assert issues_for(payload)["ground_sites[1].id"] == "duplicate"


def test_client_and_gateway_required(payload: dict) -> None:
    payload["ground_sites"] = [site for site in payload["ground_sites"] if site["role"] != "gateway"]
    assert issues_for(payload)["ground_sites"] == "missing_gateway"


def test_launch_stage_enumeration(payload: dict) -> None:
    payload["design"]["launch_stage"] = 4
    assert issues_for(payload)["design.launch_stage"] == "enum"


def test_too_many_steps_is_rejected(payload: dict) -> None:
    payload["environment"]["step_s"] = 1
    payload["environment"]["horizon_s"] = 86_400
    assert issues_for(payload)["environment.step_s"] == "too_many_steps"


def test_all_problems_are_reported_at_once(payload: dict) -> None:
    """Пользователь получает полный список, а не первую попавшуюся ошибку."""
    payload["environment"]["isl_range_km"] = -5
    payload["design"]["planes"][0]["phase_deg"] = 900
    payload["ground_sites"][2]["lat_deg"] = 120
    problems = issues_for(payload)
    assert "environment.isl_range_km" in problems
    assert "design.planes[0].phase_deg" in problems
    assert "ground_sites[2].lat_deg" in problems


def test_broken_plane_does_not_cascade_into_satellites(payload: dict) -> None:
    """Ошибка в угле плоскости не должна порождать ошибки у всех её аппаратов.

    Плоскость с неверным RAAN остаётся «объявленной», поэтому ссылки на неё
    разрешаются, и пользователь видит одну настоящую причину, а не два десятка
    наводных сообщений.
    """
    payload["design"]["planes"][1]["raan_deg"] = 400
    problems = issues_for(payload)
    assert problems == {"design.planes[1].raan_deg": "range"}


def test_several_independent_problems_stay_separate(payload: dict) -> None:
    payload["design"]["satellites"][17]["slot_deg"] = "abc"
    payload["design"]["planes"][1]["raan_deg"] = 400
    payload["ground_sites"][2]["lat_deg"] = 120
    problems = issues_for(payload)
    assert len(problems) == 3
    assert set(problems) == {
        "design.satellites[17].slot_deg",
        "design.planes[1].raan_deg",
        "ground_sites[2].lat_deg",
    }


def test_missing_plane_reference_is_still_reported(payload: dict) -> None:
    """Настоящая висячая ссылка по-прежнему выявляется."""
    payload["design"]["planes"] = payload["design"]["planes"][:1]
    problems = issues_for(payload)
    assert any(path.endswith(".plane_id") for path in problems)
