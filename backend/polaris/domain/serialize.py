"""Упаковка результата: компактный пакет для браузера и выгрузка по схеме ТЗ.

Полный горизонт расчёта помещается в ~150 КБ, поэтому он передаётся в браузер
целиком одним пакетом. Это снимает запросы при перемотке времени, смене пункта
и переключении стратегии: интерфейс работает по локальным данным, а обращение
к серверу происходит только при изменении конфигурации.

Массивы кодируются base64 поверх плотных типов (битовые маски, uint8, float32),
что даёт компактность без собственного бинарного протокола: в браузере такой
пакет разбирается штатными ``atob`` и типизированными массивами.
"""

from __future__ import annotations

import base64
from typing import Any

import numpy as np

from .constants import RESULT_SCHEMA_VERSION
from .engine import RunResult
from .routing import CAUSE_LABELS, STRATEGY_LABELS, GapCause, LinkState

BUNDLE_SCHEMA = "polaris-bundle-1"


def _b64(array: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode("ascii")


def _bits(mask: np.ndarray) -> str:
    """Упаковать булев массив в битовую маску (по строкам, если он двумерный)."""
    return _b64(np.packbits(mask, axis=-1))


def pack_bundle(result: RunResult, run_id: str) -> dict[str, Any]:
    """Собрать пакет с полным состоянием сети на горизонте."""
    scenario = result.scenario
    topo = result.topology
    env = scenario.environment
    pair_i, pair_j = topo.pairs

    clients: dict[str, Any] = {}
    for client_id, timeline in result.timelines.items():
        offsets = np.zeros(len(timeline.paths) + 1, dtype=np.uint32)
        nodes: list[int] = []
        for index, path in enumerate(timeline.paths):
            nodes.extend(path)
            offsets[index + 1] = len(nodes)
        clients[client_id] = {
            "state": _b64(timeline.state.astype(np.uint8)),
            "cause": _b64(timeline.cause.astype(np.uint8)),
            "gateway": _b64(timeline.gateway.astype(np.int8)),
            "hops": _b64(np.nan_to_num(timeline.hops, nan=0.0).astype(np.float32)),
            "latency_ms": _b64(np.nan_to_num(timeline.latency_ms, nan=0.0).astype(np.float32)),
            "margin": _b64(np.nan_to_num(timeline.margin, nan=0.0).astype(np.float32)),
            "diversity": _b64(timeline.diversity.astype(np.uint8)),
            "changed": _bits(timeline.changed),
            "required_range_km": _b64(
                np.nan_to_num(timeline.required_range_km, nan=0.0).astype(np.float32)
            ),
            "path_offsets": _b64(offsets),
            "path_nodes": _b64(np.asarray(nodes, dtype=np.uint16)),
            "metrics": timeline.metrics.as_dict() if timeline.metrics else None,
        }

    return {
        "schema": BUNDLE_SCHEMA,
        "run_id": run_id,
        "scenario_hash": scenario.content_hash(),
        "meta": dict(scenario.meta),
        "options": result.options.as_dict(),
        "elapsed_ms": result.elapsed_ms,
        "environment": {
            "altitude_km": env.altitude_km,
            "inclination_deg": env.inclination_deg,
            "earth_angle0_deg": env.earth_angle0_deg,
            "horizon_s": env.horizon_s,
            "step_s": env.step_s,
            "min_elevation_deg": env.min_elevation_deg,
            "isl_range_km": env.isl_range_km,
            "target_availability": env.target_availability,
        },
        "design": {
            "launch_stage": scenario.launch_stage,
            "planes": [
                {"id": p.id, "raan_deg": p.raan_deg, "phase_deg": p.phase_deg}
                for p in scenario.planes
            ],
            "satellites": [
                {
                    "id": s.id,
                    "plane_id": s.plane_id,
                    "slot_deg": s.slot_deg,
                    "launch_batch": s.launch_batch,
                }
                for s in scenario.satellites
            ],
        },
        "ground_sites": [
            {
                "id": g.id,
                "name": g.name,
                "role": g.role,
                "lat_deg": g.lat_deg,
                "lon_deg": g.lon_deg,
            }
            for g in scenario.ground_sites
        ],
        "failures": [
            {"satellite_id": f.target_id, "start_s": f.start_s, "end_s": f.end_s}
            for f in scenario.failures
        ],
        "gateway_outages": [
            {"gateway_id": o.target_id, "start_s": o.start_s, "end_s": o.end_s}
            for o in scenario.gateway_outages
        ],
        "step_count": topo.step_count,
        "satellite_count": topo.satellite_count,
        "pair_count": int(pair_i.size),
        "pairs": {"i": _b64(pair_i.astype(np.uint16)), "j": _b64(pair_j.astype(np.uint16))},
        "isl": _bits(topo.isl),
        "active": _bits(topo.active),
        "gateway_online": {
            gid: _bits(mask) for gid, mask in topo.gateway_online.items()
        },
        "ground_visible": {
            site_id: _bits(mask) for site_id, mask in topo.ground_visible.items()
        },
        "link_counts": _b64(topo.link_counts().astype(np.uint16)),
        "active_counts": _b64(topo.active_counts().astype(np.uint16)),
        "clients": clients,
        "summary": run_summary(result),
    }


def run_summary(result: RunResult) -> dict[str, Any]:
    """Компактная сводка результата — то, что показывается в панелях."""
    scenario = result.scenario
    return {
        "scenario_hash": scenario.content_hash(),
        "title": scenario.meta.get("title") or scenario.meta.get("id") or "Без названия",
        "strategy": result.options.strategy,
        "strategy_label": STRATEGY_LABELS.get(result.options.strategy, result.options.strategy),
        "launch_stage": scenario.launch_stage,
        "active_satellites": sum(
            1 for s in scenario.satellites if s.launch_batch <= scenario.launch_stage
        ),
        "total_satellites": len(scenario.satellites),
        "plane_count": len(scenario.planes),
        "isl_range_km": scenario.environment.isl_range_km,
        "min_elevation_deg": scenario.environment.min_elevation_deg,
        "altitude_km": scenario.environment.altitude_km,
        "horizon_s": scenario.environment.horizon_s,
        "step_s": scenario.environment.step_s,
        "target_pct": round(scenario.environment.target_availability * 100.0, 2),
        "min_availability_pct": result.min_availability(),
        "mean_availability_pct": result.mean_availability(),
        "worst_client": result.worst_client(),
        "target_met": all(m.target_met for m in result.metrics),
        "elapsed_ms": result.elapsed_ms,
        "clients": [m.as_dict() for m in result.metrics],
        "criticality": result.criticality.ranking(scenario.satellite_ids, limit=10),
        "recommendations": result.recommendations,
        "mean_links": round(float(result.topology.link_counts().mean()), 1),
    }


def export_result(result: RunResult) -> dict[str, Any]:
    """Выгрузка по схеме ``cosmo-A-result-1.0``.

    На каждую пару «момент расчёта — наземный пункт» приходится ровно одна
    запись с полями ``t_s``, ``client_id`` и ``path``; пустой список означает
    отсутствие построенного маршрута.
    """
    scenario = result.scenario
    topo = result.topology
    sat_ids = scenario.satellite_ids
    gateways = scenario.gateways
    times = topo.times

    routes: list[dict[str, Any]] = []
    for client_id, timeline in result.timelines.items():
        for step in range(topo.step_count):
            path: list[str] = []
            if timeline.state[step] == LinkState.ROUTED:
                gateway_index = int(timeline.gateway[step])
                path = [
                    client_id,
                    *(sat_ids[node] for node in timeline.paths[step]),
                    gateways[gateway_index].id,
                ]
            routes.append(
                {"t_s": float(times[step]), "client_id": client_id, "path": path}
            )

    return {
        "schema_version": RESULT_SCHEMA_VERSION,
        "effective_scenario": scenario.to_dict(),
        "routes": routes,
        "summary": run_summary(result),
        "diagnostics": {
            client_id: {
                "gaps": [gap.as_dict() for gap in timeline.metrics.gaps],
                "cause_totals": timeline.metrics.cause_totals,
            }
            for client_id, timeline in result.timelines.items()
            if timeline.metrics is not None
        },
        "legend": {
            "state": {int(item): item.name.lower() for item in LinkState},
            "cause": {
                int(item): {"name": item.name.lower(), "label": CAUSE_LABELS[item]}
                for item in GapCause
            },
        },
    }
