"""Инженерный контур не влияет на быстрый расчёт и честно хранит допущения."""

from __future__ import annotations

import copy
from datetime import datetime, timezone

import numpy as np

from polaris.domain.ephemeris import positions_at
from polaris.domain.scenario import parse_scenario
from polaris.research import engine as research_engine
from polaris.research.engine import ResearchOptions
from polaris.research.external_data import ExternalDataService
from polaris.research.link_budget import ground_budget
from polaris.research.orbit import OrbitResult
from polaris.research.profiles import get_profile
from polaris.research.store import ResearchRegistry


def test_ground_link_requires_positive_uplink_and_downlink() -> None:
    equipment = copy.deepcopy(get_profile("nominal")["client"])
    equipment["downlink"]["eirp_dbw"] = -20.0
    shape = (1, 1)
    weather = {
        "rain": np.zeros(1), "snowfall": np.zeros(1), "cloud_cover": np.zeros(1),
        "relative_humidity_2m": np.zeros(1), "surface_pressure": np.full(1, 1013.0),
        "temperature_2m": np.full(1, 15.0), "visibility": np.full(1, 30_000.0),
    }
    budget = ground_budget(
        distance_km=np.full(shape, 800.0), elevation_deg=np.full(shape, 60.0),
        radial_velocity_km_s=np.zeros(shape), geometric_visible=np.ones(shape, dtype=bool),
        conditions=weather, equipment=equipment,
    )
    assert budget.uplink_margin_db[0, 0] > 0
    assert budget.downlink_margin_db[0, 0] < 0
    assert not budget.available[0, 0]


def test_external_data_snapshot_is_hashed_and_never_fetched_by_status(tmp_path, full_raw) -> None:
    calls: list[str] = []

    def fetch(url: str):
        calls.append(url)
        if "elevation" in url:
            return {"elevation": [100.0] * len(full_raw["ground_sites"])}
        raise AssertionError(url)

    service = ExternalDataService(tmp_path, fetch_json=fetch)
    scenario = parse_scenario(full_raw)
    result = service.refresh(scenario, sources=["elevation"])
    assert result["updated"][0]["ok"] is True
    before = len(calls)
    status = service.status()
    assert len(calls) == before
    elevation = next(item for item in status["sources"] if item["id"] == "elevation")
    assert elevation["status"] == "ready"
    assert len(elevation["sha256"]) == 64


def test_research_result_has_range_physics_and_sources(monkeypatch, tmp_path, full_raw) -> None:
    raw = copy.deepcopy(full_raw)
    raw["environment"]["horizon_s"] = 600
    raw["environment"]["step_s"] = 120
    scenario = parse_scenario(raw)

    def analytic_orbit(scenario, epoch, times, satellite_profile, space_weather, progress):
        inertial, fixed = positions_at(scenario, times)
        velocity_i = np.gradient(inertial, times, axis=0)
        velocity_f = np.gradient(fixed, times, axis=0)
        progress(len(scenario.satellites), len(scenario.satellites))
        return OrbitResult(
            times, inertial, fixed, velocity_i, velocity_f,
            {"engine": "test-orbit", "version": "1", "gravity": "test", "fallback": False,
             "assumptions": {"eccentricity": 0.0}},
        )

    monkeypatch.setattr(research_engine, "propagate_project", analytic_orbit)
    service = ExternalDataService(tmp_path)
    data, sources = service.data_for_run()
    result = research_engine.run_research(
        scenario, data, sources, ResearchOptions(step_s=60, link_mode="hybrid")
    )
    assert result["schema"] == "polaris-research-result-1"
    assert result["operational_use"] is False
    assert len(result["profiles"]) == 3
    assert result["availability_range"]["min_pct"] <= result["availability_range"]["max_pct"]
    assert result["link_models"]["max_margin_unit"] == "dB"
    passport = result["profiles"][1]["line_passport"]
    assert passport is not None
    assert {"fspl_db", "uplink_cn0_dbhz", "uplink_ebn0_db", "margin_db"} <= passport.keys()
    assert any(source["status"] == "fallback" for source in result["sources"])


def test_hazard_becomes_outage_only_after_explicit_command(tmp_path, full_raw) -> None:
    registry = ResearchRegistry(tmp_path)
    registry.save({
        "id": "research_test123456",
        "scenario": full_raw,
        "hazards": {"events": [{
            "id": "haz_event", "satellite_id": "S01", "window_start_s": 100,
            "window_end_s": 700,
        }]},
    })
    original = registry.get("research_test123456")
    assert original["scenario"]["failures"] == full_raw["failures"]
    generated = registry.hazard_scenario("research_test123456", "haz_event")
    assert generated is not None
    assert generated["scenario"]["failures"][-1] == {
        "satellite_id": "S01", "start_s": 100, "end_s": 700,
    }


def test_refined_boundaries_drive_duration_metrics() -> None:
    outcome: dict = {}
    states = np.asarray([True, False, False, True], dtype=bool)
    causes = ["none", "weather", "weather", "none"]
    research_engine._apply_refined_timing(
        outcome,
        states,
        causes,
        np.asarray([0.0, 60.0, 120.0, 180.0]),
        240,
        {1: 43, 3: 177},
    )
    assert outcome["gaps"][0]["start_s"] == 43
    assert outcome["gaps"][0]["end_s"] == 177
    assert outcome["gaps"][0]["boundary_resolution_s"] == 1
    assert outcome["cause_totals_s"] == {"weather": 134}
    assert outcome["availability_pct"] == 44.17
