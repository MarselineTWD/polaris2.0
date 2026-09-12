"""Проверка HTTP-слоя поверх приложения."""

from __future__ import annotations

import copy
import csv
import io
import json
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


def test_research_discovery_endpoints(client: TestClient) -> None:
    profiles = client.get("/api/research/profiles")
    assert profiles.status_code == 200
    assert [item["id"] for item in profiles.json()["profiles"]] == [
        "conservative", "nominal", "enhanced"
    ]
    status = client.get("/api/external-data/status")
    assert status.status_code == 200
    assert status.json()["refresh_policy"] == "manual"
    assert {item["id"] for item in status.json()["sources"]} >= {
        "weather", "elevation", "space_weather", "celestrak", "satnogs", "itur", "satkit"
    }


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
    assert response.content.startswith(b"{\n  \"")
    assert response.content.endswith(b"\n")
    body = response.json()
    assert body["schema_version"] == "cosmo-A-result-1.0"
    assert len(body["routes"]) == 720 * 3


def test_export_downloads_csv_with_full_scenario(client: TestClient, payload: dict) -> None:
    run_id = client.post("/api/runs", json={"scenario": payload}).json()["run_id"]
    response = client.get(f"/api/runs/{run_id}/export.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"].endswith('-result.csv"')
    assert response.content.startswith(b"\xef\xbb\xbf")

    rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert len(rows) == 720 * 3
    assert rows[0]["schema_version"] == "cosmo-A-result-1.0"
    assert json.loads(rows[0]["effective_scenario"])["schema_version"] == "cosmo-A-1.0"


def test_variant_save_list_and_compare(client: TestClient, payload: dict) -> None:
    first = client.post(
        "/api/variants", json={"label": "Полная группировка", "scenario": payload}
    )
    assert first.status_code == 201
    base_id = first.json()["id"]

    staged = copy.deepcopy(payload)
    staged["design"]["launch_stage"] = 1
    staged["design"]["planes"][0]["raan_deg"] = 15
    staged["failures"] = [{"satellite_id": "S01", "start_s": 0, "end_s": 120}]
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

    multiple = client.post(
        "/api/compare/multiple", json={"variant_ids": [base_id, other_id]}
    )
    assert multiple.status_code == 200
    multi_body = multiple.json()
    assert [item["id"] for item in multi_body["variants"]] == [base_id, other_id]
    assert multi_body["recommended_id"] == base_id
    assert all(len(item["clients"]) == 3 for item in multi_body["variants"])
    changed = {item["field"] for item in multi_body["parameter_rows"]}
    assert {"design.launch_stage", "design.planes.P1.raan_deg", "failures"} <= changed

    exported = client.get(f"/api/variants/{other_id}/export")
    assert exported.status_code == 200
    assert "attachment" in exported.headers["content-disposition"]
    assert exported.json()["schema_version"] == "cosmo-A-1.0"
    assert exported.json()["design"]["launch_stage"] == 1
    assert exported.json()["design"]["planes"][0]["raan_deg"] == 15
    assert exported.json()["failures"] == staged["failures"]

    client.delete(f"/api/variants/{base_id}")
    client.delete(f"/api/variants/{other_id}")
    assert client.get(f"/api/variants/{other_id}/export").status_code == 404


def test_multi_compare_rejects_different_time_grids(client: TestClient, payload: dict) -> None:
    first = client.post("/api/variants", json={"label": "24 часа", "scenario": payload}).json()
    changed = copy.deepcopy(payload)
    changed["environment"]["horizon_s"] = 43200
    second = client.post("/api/variants", json={"label": "12 часов", "scenario": changed}).json()
    try:
        response = client.post(
            "/api/compare/multiple",
            json={"variant_ids": [first["id"], second["id"]]},
        )
        assert response.status_code == 422
        assert "horizon_s и step_s" in response.json()["detail"]
    finally:
        client.delete(f"/api/variants/{first['id']}")
        client.delete(f"/api/variants/{second['id']}")


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


def test_optimize_job_can_be_cancelled(client: TestClient) -> None:
    scenario = load_raw("04_link_range")
    accepted = client.post(
        "/api/analysis/optimize", json={"scenario": scenario, "max_evaluations": 600}
    )
    assert accepted.status_code == 202
    job_id = accepted.json()["id"]

    # Отмена должна работать не только сразу после постановки в очередь, но и
    # после того, как пул уже закончил первую порцию вариантов.
    for _ in range(80):
        running = client.get(f"/api/jobs/{job_id}").json()
        if running["done"] > 0 or running["status"] != "running":
            break
        time.sleep(0.05)
    cancelled = client.post(f"/api/jobs/{job_id}/cancel")
    assert cancelled.status_code == 200

    for _ in range(80):
        status = client.get(f"/api/jobs/{job_id}").json()
        if status["status"] == "cancelled":
            break
        time.sleep(0.1)
    assert status["status"] == "cancelled"


def test_unknown_run_is_reported_clearly(client: TestClient) -> None:
    response = client.get("/api/runs/run_missing/export")
    assert response.status_code == 404
    assert "заново" in response.json()["detail"]
