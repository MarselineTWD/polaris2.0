"""Проверка HTTP-слоя поверх приложения."""

from __future__ import annotations

import copy
import time

import pytest
from fastapi.testclient import TestClient

from polaris.main import app

from .conftest import load_raw


@pytest.fixture(scope="module")
def client() -> TestClient:
    with TestClient(app) as instance:
        yield instance


@pytest.fixture
def payload() -> dict:
    return copy.deepcopy(load_raw("01_full_constellation"))


def test_health(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["presets"] == 4


def test_presets_are_listed_and_loadable(client: TestClient) -> None:
    presets = client.get("/api/presets").json()["presets"]
    assert [item["id"] for item in presets] == [
        "01_full_constellation",
        "02_first_launch",
        "03_satellite_outages",
        "04_link_range",
    ]
    scenario = client.get("/api/presets/01_full_constellation").json()
    assert scenario["schema_version"] == "cosmo-A-1.0"
    assert client.get("/api/presets/unknown").status_code == 404


def test_run_returns_bundle_with_summary(client: TestClient, payload: dict) -> None:
    response = client.post("/api/runs", json={"scenario": payload})
    assert response.status_code == 200
    bundle = response.json()
    assert bundle["schema"] == "polaris-bundle-1"
    assert bundle["step_count"] == 720
    assert bundle["summary"]["min_availability_pct"] == 96.67
    assert bundle["summary"]["target_met"] is True
    assert bundle["summary"]["recommendations"]


def test_invalid_scenario_returns_field_paths(client: TestClient, payload: dict) -> None:
    payload["design"]["satellites"][17]["slot_deg"] = "abc"
    response = client.post("/api/runs", json={"scenario": payload})
    assert response.status_code == 422
    body = response.json()
    assert body["error_code"] == "scenario_invalid"
    assert body["details"][0]["path"] == "design.satellites[17].slot_deg"


def test_validate_endpoint_does_not_compute(client: TestClient, payload: dict) -> None:
    good = client.post("/api/scenarios/validate", json={"scenario": payload}).json()
    assert good["valid"] is True
    assert good["summary"]["satellites"] == 48

    payload["environment"]["horizon_s"] = 86401
    bad = client.post("/api/scenarios/validate", json={"scenario": payload}).json()
    assert bad["valid"] is False
    assert bad["errors"][0]["path"] == "environment.horizon_s"


def test_snapshot_matches_reference_module(client: TestClient, payload: dict) -> None:
    """Ответ /snapshot сверяется с эталонным модулем организаторов."""
    import geometry

    run_id = client.post("/api/runs", json={"scenario": payload}).json()["run_id"]
    produced = client.get(f"/api/runs/{run_id}/snapshot", params={"t_s": 0}).json()
    reference = geometry.snapshot(payload, 0.0)

    assert len(produced["edges"]) == len(reference["edges"])
    assert {item["id"] for item in produced["satellites"]} == {
        item["id"] for item in reference["satellites"]
    }


def test_coverage_grid_uses_completed_run(client: TestClient, payload: dict) -> None:
    run_id = client.post("/api/runs", json={"scenario": payload}).json()["run_id"]
    response = client.get(f"/api/runs/{run_id}/coverage")
    assert response.status_code == 200
    grid = response.json()
    assert grid["cell_deg"] == 10
    assert len(grid["availability_pct"]) == len(grid["latitudes"]) * len(grid["longitudes"])
    assert 0 <= grid["minimum_pct"] <= grid["mean_pct"] <= grid["maximum_pct"] <= 100


def test_export_downloads_result_schema(client: TestClient, payload: dict) -> None:
    run_id = client.post("/api/runs", json={"scenario": payload}).json()["run_id"]
    response = client.get(f"/api/runs/{run_id}/export")
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    body = response.json()
    assert body["schema_version"] == "cosmo-A-result-1.0"
    assert len(body["routes"]) == 720 * 3


def test_variant_save_list_and_compare(client: TestClient, payload: dict) -> None:
    first = client.post(
        "/api/variants", json={"label": "Полная группировка", "scenario": payload}
    )
    assert first.status_code == 201
    base_id = first.json()["id"]

    staged = copy.deepcopy(payload)
    staged["design"]["launch_stage"] = 1
    second = client.post("/api/variants", json={"label": "Первая очередь", "scenario": staged})
    other_id = second.json()["id"]

    assert any(item["id"] == base_id for item in client.get("/api/variants").json()["variants"])

    comparison = client.post(
        "/api/compare", json={"base_variant_id": base_id, "other_variant_id": other_id}
    ).json()
    assert comparison["verdict"]["delta_min_availability_pp"] < 0
    assert comparison["verdict"]["recommended"] == "base"
    diff = {row["field"] for row in comparison["parameter_diff"]}
    assert "launch_stage" in diff
    assert len(comparison["client_diff"]) == 3

    client.delete(f"/api/variants/{base_id}")
    client.delete(f"/api/variants/{other_id}")


def test_strategy_comparison_endpoint(client: TestClient, payload: dict) -> None:
    body = client.post("/api/analysis/strategies", json={"scenario": payload}).json()
    assert {row["strategy"] for row in body["strategies"]} == {
        "min_hops",
        "min_latency",
        "max_margin",
    }


def test_optimize_job_runs_to_completion(client: TestClient) -> None:
    scenario = load_raw("04_link_range")
    accepted = client.post(
        "/api/analysis/optimize", json={"scenario": scenario, "max_evaluations": 20}
    )
    assert accepted.status_code == 202
    job_id = accepted.json()["id"]

    for _ in range(120):
        status = client.get(f"/api/jobs/{job_id}").json()
        if status["status"] != "running":
            break
        time.sleep(0.25)

    assert status["status"] == "done", status.get("error")
    assert status["result"]["best"]["min_availability_pct"] >= status["result"]["baseline"][
        "min_availability_pct"
    ]


def test_unknown_run_is_reported_clearly(client: TestClient) -> None:
    response = client.get("/api/runs/run_missing/export")
    assert response.status_code == 404
    assert "заново" in response.json()["detail"]
