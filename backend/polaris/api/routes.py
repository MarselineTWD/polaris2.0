"""HTTP-маршруты сервиса."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response

from ..config import settings
from ..domain import analysis, optimizer
from ..domain.coverage import coverage_grid
from ..domain.engine import RunOptions, snapshot
from ..domain.routing import CAUSE_LABELS, STRATEGY_LABELS, GapCause, LinkState, Strategy
from ..domain.scenario import ScenarioValidationError
from ..domain.serialize import export_result
from .jobs import Job, progress_reporter
from .schemas import (
    CompareRequest,
    MultiCompareRequest,
    OptimizeRequest,
    RunOptionsIn,
    RunRequest,
    SpofRequest,
    StrategyCompareRequest,
    ValidateRequest,
    VariantCreate,
)
from .services import jobs, load_scenario, presets, runs, variants

router = APIRouter(prefix="/api")


def _options(payload: RunOptionsIn) -> RunOptions:
    return RunOptions(**payload.model_dump())


def _json(
    payload: dict[str, Any],
    *,
    filename: str | None = None,
    status_code: int = 200,
) -> Response:
    """Отдать JSON без NaN/Infinity — схема выгрузки требует конечных значений."""
    body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    headers = (
        {"Content-Disposition": f'attachment; filename="{filename}"'} if filename else None
    )
    return Response(
        content=body,
        media_type="application/json",
        headers=headers,
        status_code=status_code,
    )


# --------------------------------------------------------------------------- #
# Служебное
# --------------------------------------------------------------------------- #


@router.get("/health")
def health() -> dict[str, Any]:
    from .. import __version__

    return {
        "status": "ok",
        "version": __version__,
        "runs": runs.stats(),
        "presets": len(presets.available()),
        "jobs": [job.as_dict() for job in jobs.list()[:5]],
    }


@router.get("/legend")
def legend() -> dict[str, Any]:
    """Словарь кодов состояний — интерфейс не дублирует их у себя."""
    return {
        "state": {
            int(item): {"name": item.name.lower(), "label": label}
            for item, label in (
                (LinkState.NO_VISIBILITY, "нет покрытия"),
                (LinkState.VISIBLE_NO_PATH, "есть покрытие, нет пути"),
                (LinkState.ROUTED, "маршрут доступен"),
            )
        },
        "cause": {
            int(item): {"name": item.name.lower(), "label": CAUSE_LABELS[item]}
            for item in GapCause
        },
        "strategy": [
            {"value": item.value, "label": STRATEGY_LABELS[item.value]} for item in Strategy
        ],
    }


# --------------------------------------------------------------------------- #
# Сценарии
# --------------------------------------------------------------------------- #


@router.get("/presets")
def list_presets() -> dict[str, Any]:
    return {"presets": presets.available()}


@router.get("/presets/{preset_id}")
def get_preset(preset_id: str) -> Response:
    payload = presets.load(preset_id)
    if payload is None:
        raise HTTPException(status_code=404, detail=f"Сценарий «{preset_id}» не найден")
    return _json(payload)


@router.post("/scenarios/validate")
def validate_scenario(request: ValidateRequest) -> dict[str, Any]:
    """Проверить сценарий, не запуская расчёт."""
    try:
        scenario = load_scenario(request.scenario)
    except ScenarioValidationError as error:
        return {"valid": False, "errors": [issue.as_dict() for issue in error.issues]}
    return {
        "valid": True,
        "errors": [],
        "scenario_hash": scenario.content_hash(),
        "summary": {
            "satellites": len(scenario.satellites),
            "planes": len(scenario.planes),
            "clients": [site.id for site in scenario.clients],
            "gateways": [site.id for site in scenario.gateways],
            "step_count": scenario.environment.step_count,
            "failures": len(scenario.failures),
            "gateway_outages": len(scenario.gateway_outages),
        },
    }


# --------------------------------------------------------------------------- #
# Расчёт
# --------------------------------------------------------------------------- #


@router.post("/runs")
def create_run(request: RunRequest) -> Response:
    """Рассчитать сценарий и вернуть полный пакет состояния сети."""
    scenario = load_scenario(request.scenario)
    _, bundle = runs.run(scenario, _options(request.options))
    return _json(bundle)


@router.get("/runs/{run_id}/export")
def export_run(run_id: str) -> Response:
    entry = runs.get(run_id)
    if entry is None:
        raise HTTPException(
            status_code=404,
            detail="Расчёт не найден: вероятно, он вытеснен из кэша. Запустите расчёт заново.",
        )
    result, _ = entry
    payload = export_result(result)
    title = result.scenario.meta.get("id") or "polaris"
    return _json(payload, filename=f"{title}-result.json")


@router.get("/runs/{run_id}/snapshot")
def run_snapshot(run_id: str, t_s: float = Query(default=0.0, ge=0.0)) -> Response:
    """Состояние сети в момент ``t_s`` в формате эталонного модуля geometry.py."""
    entry = runs.get(run_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Расчёт не найден")
    result, _ = entry
    horizon = result.scenario.environment.horizon_s
    if t_s > horizon:
        raise HTTPException(
            status_code=422,
            detail=f"Момент {t_s} с выходит за период расчёта (0…{horizon} с)",
        )
    return _json(snapshot(result.scenario, t_s))


@router.get("/runs/{run_id}/coverage")
def run_coverage(run_id: str) -> Response:
    """Карта доли времени со сквозным маршрутом по сетке 10°×10°."""
    entry = runs.get(run_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Расчёт не найден")
    result, _ = entry
    return _json(coverage_grid(result))


# --------------------------------------------------------------------------- #
# Варианты и сравнение
# --------------------------------------------------------------------------- #


@router.get("/variants")
def list_variants() -> dict[str, Any]:
    return {"variants": variants.list()}


@router.post("/variants", status_code=201)
def create_variant(request: VariantCreate) -> Response:
    scenario = load_scenario(request.scenario)
    _, bundle = runs.run(scenario, _options(request.options))
    saved = variants.save(
        label=request.label,
        note=request.note,
        scenario=scenario.to_dict(),
        scenario_hash=scenario.content_hash(),
        summary=bundle["summary"],
        options=request.options.model_dump(),
    )
    return _json(saved, status_code=201)


@router.get("/variants/{variant_id}/export")
def export_variant(variant_id: str) -> Response:
    """Скачать сохранённую конфигурацию в формате, пригодном для повторного импорта."""
    saved = variants.get(variant_id)
    if saved is None:
        raise HTTPException(status_code=404, detail="Вариант не найден")
    return _json(saved["scenario"], filename=f"{variant_id}-scenario.json")


@router.delete("/variants/{variant_id}")
def delete_variant(variant_id: str) -> dict[str, Any]:
    if not variants.delete(variant_id):
        raise HTTPException(status_code=404, detail="Вариант не найден")
    return {"deleted": variant_id}


@router.post("/compare")
def compare(request: CompareRequest) -> Response:
    """Сопоставить два варианта на одинаковой сетке времени."""
    base_payload, base_label = _resolve_scenario(
        request.base_scenario, request.base_variant_id, "базовый"
    )
    other_payload, other_label = _resolve_scenario(
        request.other_scenario, request.other_variant_id, "сравниваемый"
    )
    options = _options(request.options)

    base = load_scenario(base_payload)
    other = load_scenario(other_payload)
    _, base_bundle = runs.run(base, options)
    _, other_bundle = runs.run(other, options)

    # Название варианта, данное пользователем, точнее названия сценария:
    # два варианта часто происходят из одного файла и заголовок у них общий.
    base_summary = {**base_bundle["summary"], "label": base_label}
    other_summary = {**other_bundle["summary"], "label": other_label}

    return _json(
        {
            "base": base_summary,
            "other": other_summary,
            "parameter_diff": _parameter_diff(base.to_dict(), other.to_dict()),
            "client_diff": _client_diff(base_bundle["summary"], other_bundle["summary"]),
            "verdict": _verdict(base_summary, other_summary),
        }
    )


@router.post("/compare/multiple")
def compare_multiple(request: MultiCompareRequest) -> Response:
    """Посчитать 2–5 вариантов на одной сетке без ролей «база» и «новый»."""
    if len(set(request.variant_ids)) != len(request.variant_ids):
        raise HTTPException(status_code=422, detail="Варианты в сравнении не должны повторяться")

    options = _options(request.options)
    rows: list[dict[str, Any]] = []
    for variant_id in request.variant_ids:
        saved = variants.get(variant_id)
        if saved is None:
            raise HTTPException(status_code=404, detail=f"Вариант «{variant_id}» не найден")
        scenario = load_scenario(saved["scenario"])
        _, bundle = runs.run(scenario, options)
        summary = bundle["summary"]
        rows.append(
            {
                "id": variant_id,
                "label": saved["label"],
                "min_availability_pct": summary["min_availability_pct"],
                "mean_availability_pct": summary["mean_availability_pct"],
                "max_gap_s": max((client["max_gap_s"] for client in summary["clients"]), default=0),
                "mean_links": summary["mean_links"],
                "target_met": summary["target_met"],
                "launch_stage": summary["launch_stage"],
                "active_satellites": summary["active_satellites"],
                "isl_range_km": summary["isl_range_km"],
                "clients": summary["clients"],
            }
        )

    recommended = max(
        rows,
        key=lambda row: (
            row["min_availability_pct"],
            row["mean_availability_pct"],
            -row["max_gap_s"],
        ),
    )
    return _json(
        {
            "variants": rows,
            "recommended_id": recommended["id"],
            "recommended_label": recommended["label"],
            "strategy": request.options.strategy,
        }
    )


def _resolve_scenario(
    inline: dict[str, Any] | None, variant_id: str | None, role: str
) -> tuple[dict[str, Any], str | None]:
    """Вернуть сценарий и подпись варианта, если он был взят из хранилища."""
    if inline is not None:
        return inline, None
    if variant_id is None:
        raise HTTPException(
            status_code=422,
            detail=f"Не задан {role} вариант: передайте сценарий или идентификатор варианта",
        )
    saved = variants.get(variant_id)
    if saved is None:
        raise HTTPException(status_code=404, detail=f"Вариант «{variant_id}» не найден")
    return saved["scenario"], saved["label"]


def _parameter_diff(base: dict[str, Any], other: dict[str, Any]) -> list[dict[str, Any]]:
    """Какие именно параметры проекта различаются."""
    rows: list[dict[str, Any]] = []
    labels = {
        "altitude_km": "Высота орбиты, км",
        "inclination_deg": "Наклонение, °",
        "earth_angle0_deg": "Начальный угол Земли, °",
        "min_elevation_deg": "Мин. угол возвышения, °",
        "isl_range_km": "Дальность ISL, км",
        "target_availability": "Целевая доступность",
        "horizon_s": "Горизонт, с",
        "step_s": "Шаг, с",
    }
    for key, label in labels.items():
        left, right = base["environment"][key], other["environment"][key]
        if left != right:
            rows.append({"field": key, "label": label, "base": left, "other": right})

    if base["design"]["launch_stage"] != other["design"]["launch_stage"]:
        rows.append(
            {
                "field": "launch_stage",
                "label": "Этап развёртывания",
                "base": base["design"]["launch_stage"],
                "other": other["design"]["launch_stage"],
            }
        )

    base_planes = {p["id"]: p for p in base["design"]["planes"]}
    for plane in other["design"]["planes"]:
        reference = base_planes.get(plane["id"])
        if reference is None:
            continue
        for key, label in (("raan_deg", "RAAN"), ("phase_deg", "Фазирование")):
            if reference[key] != plane[key]:
                rows.append(
                    {
                        "field": f"planes.{plane['id']}.{key}",
                        "label": f"{label} {plane['id']}, °",
                        "base": reference[key],
                        "other": plane[key],
                    }
                )

    if len(base["failures"]) != len(other["failures"]):
        rows.append(
            {
                "field": "failures",
                "label": "Периодов недоступности аппаратов",
                "base": len(base["failures"]),
                "other": len(other["failures"]),
            }
        )
    if len(base["gateway_outages"]) != len(other["gateway_outages"]):
        rows.append(
            {
                "field": "gateway_outages",
                "label": "Периодов недоступности шлюзов",
                "base": len(base["gateway_outages"]),
                "other": len(other["gateway_outages"]),
            }
        )
    return rows


def _client_diff(base: dict[str, Any], other: dict[str, Any]) -> list[dict[str, Any]]:
    other_by_id = {row["client_id"]: row for row in other["clients"]}
    rows: list[dict[str, Any]] = []
    for row in base["clients"]:
        counterpart = other_by_id.get(row["client_id"])
        if counterpart is None:
            continue
        rows.append(
            {
                "client_id": row["client_id"],
                "client_name": row["client_name"],
                "base_availability_pct": row["availability_pct"],
                "other_availability_pct": counterpart["availability_pct"],
                "delta_pp": round(
                    counterpart["availability_pct"] - row["availability_pct"], 2
                ),
                "base_max_gap_s": row["max_gap_s"],
                "other_max_gap_s": counterpart["max_gap_s"],
                "delta_max_gap_s": counterpart["max_gap_s"] - row["max_gap_s"],
                "base_mean_hops": row["mean_hops"],
                "other_mean_hops": counterpart["mean_hops"],
                "base_target_met": row["target_met"],
                "other_target_met": counterpart["target_met"],
            }
        )
    return rows


def _verdict(base: dict[str, Any], other: dict[str, Any]) -> dict[str, Any]:
    delta = round(other["min_availability_pct"] - base["min_availability_pct"], 2)
    winner = other if delta > 0.01 else base
    if delta > 0.01:
        headline = "Сравниваемый вариант лучше по минимальной доступности"
    elif delta < -0.01:
        headline = "Сравниваемый вариант хуже по минимальной доступности"
    else:
        headline = "Варианты равнозначны по минимальной доступности"
    return {
        "headline": headline,
        "delta_min_availability_pp": delta,
        "delta_mean_availability_pp": round(
            other["mean_availability_pct"] - base["mean_availability_pct"], 2
        ),
        "base_target_met": base["target_met"],
        "other_target_met": other["target_met"],
        "recommended": "other" if delta > 0.01 else "base",
        "recommended_label": winner.get("label") or winner["title"],
    }


# --------------------------------------------------------------------------- #
# Анализ
# --------------------------------------------------------------------------- #


@router.post("/analysis/strategies")
def strategies(request: StrategyCompareRequest) -> Response:
    scenario = load_scenario(request.scenario)
    return _json(analysis.compare_strategies(scenario, request.strategies))


@router.post("/analysis/spof", status_code=202)
def spof(request: SpofRequest) -> dict[str, Any]:
    """Свип точек отказа. Долгая операция — выполняется фоново."""
    scenario = load_scenario(request.scenario)

    def work(job: Job) -> dict[str, Any]:
        return analysis.spof_sweep(
            scenario,
            candidates=request.satellites,
            workers=settings.optimizer_workers,
            progress=progress_reporter(job),
        )

    return _submit("spof", work)


@router.post("/analysis/optimize", status_code=202)
def optimize(request: OptimizeRequest) -> dict[str, Any]:
    """Подбор ориентации и фазирования плоскостей. Долгая операция."""
    scenario = load_scenario(request.scenario)

    def work(job: Job) -> dict[str, Any]:
        return optimizer.optimize(
            scenario,
            max_evaluations=request.max_evaluations,
            workers=settings.optimizer_workers,
            progress=progress_reporter(job),
        )

    return _submit("optimize", work)


def _submit(kind: str, work: Any) -> dict[str, Any]:
    try:
        return jobs.submit(kind, work).as_dict()
    except RuntimeError as error:
        raise HTTPException(status_code=429, detail=str(error)) from error


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> Response:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    return _json(job.as_dict())


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> Response:
    job = jobs.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    return _json(job.as_dict())


@router.get("/jobs")
def job_list() -> Response:
    return _json({"jobs": [job.as_dict() for job in jobs.list()]})
