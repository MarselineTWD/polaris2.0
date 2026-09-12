"""Фоновый инженерный расчёт: орбита → бюджеты линий → маршрутизация."""

from __future__ import annotations

import math
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

import numpy as np

from ..domain.constants import EARTH_RADIUS_KM, SPEED_OF_LIGHT_KM_S
from ..domain.engine import RunOptions, compute_run
from ..domain.ephemeris import active_mask, gateway_online_mask
from ..domain.routing import SourceLinks, StepGraph, find_path
from ..domain.scenario import GroundSite, Scenario
from ..domain.visibility import isl_links, pair_indices
from .hazards import screen_hazards
from .link_budget import (
    CAUSE_LABEL,
    BudgetMatrix,
    apply_terminal_capacity,
    ground_budget,
    optical_isl_budget,
    passport,
    rf_isl_budget,
    weather_series,
)
from .orbit import OrbitResult, propagate_project
from .profiles import get_profile, profile_catalog


@dataclass(slots=True)
class ResearchOptions:
    link_mode: str = "hybrid"
    strategy: str = "max_margin"
    step_s: int = 60
    profile_ids: tuple[str, ...] = ("conservative", "nominal", "enhanced")
    epoch: datetime | None = None

    def validate(self) -> None:
        if self.link_mode not in {"rf", "optical", "hybrid"}:
            raise ValueError("Тип линий должен быть rf, optical или hybrid")
        if self.strategy not in {"min_hops", "min_latency", "max_margin"}:
            raise ValueError("Неизвестная стратегия маршрутизации")
        if not 1 <= self.step_s <= 300:
            raise ValueError("Шаг инженерного расчёта должен быть от 1 до 300 секунд")
        known = {item["id"] for item in profile_catalog()}
        if not self.profile_ids or any(item not in known for item in self.profile_ids):
            raise ValueError("Неизвестный профиль оборудования")


def run_research(
    scenario: Scenario,
    external_data: dict[str, Any],
    source_passports: list[dict[str, Any]],
    options: ResearchOptions | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Выполнить воспроизводимую инженерную верификацию."""
    options = options or ResearchOptions()
    options.validate()
    started = time.perf_counter()
    epoch = (options.epoch or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(
        minute=0, second=0, microsecond=0
    )
    step_s = min(options.step_s, scenario.environment.step_s)
    times = np.arange(0, scenario.environment.horizon_s, step_s, dtype=np.float64)
    if times.size == 0:
        raise ValueError("Пустой горизонт инженерного расчёта")

    report = _reporter(progress)
    report(2)
    nominal = get_profile("nominal")
    orbit = propagate_project(
        scenario,
        epoch,
        times,
        nominal["satellite"],
        external_data.get("space_weather", {}),
        lambda done, total: report(5 + round(35 * done / max(total, 1))),
    )
    active = active_mask(scenario, times)
    gateway_online = gateway_online_mask(scenario, times)
    geometry = _geometry(scenario, orbit, active, external_data.get("elevation", {}))
    report(43)

    fast = compute_run(
        scenario,
        RunOptions(strategy=options.strategy, backup_limit=1, with_criticality=False),
    )
    fast_summary = {
        "min_availability_pct": fast.min_availability(),
        "mean_availability_pct": fast.mean_availability(),
        "step_s": scenario.environment.step_s,
        "model": "Быстрый режим ТЗ",
    }

    profiles: list[dict[str, Any]] = []
    for number, profile_id in enumerate(options.profile_ids):
        profile = get_profile(profile_id)
        outcome = _run_profile(
            scenario,
            epoch,
            times,
            active,
            gateway_online,
            geometry,
            external_data.get("weather", {}),
            profile,
            options,
        )
        profiles.append(outcome)
        report(45 + round(38 * (number + 1) / len(options.profile_ids)))

    hazards = screen_hazards(
        external_data.get("celestrak", {}), orbit, epoch, scenario.environment.inclination_deg
    )
    sat_ids = scenario.satellite_ids
    for event in hazards["events"]:
        index = int(event.pop("satellite_index"))
        event["satellite_id"] = sat_ids[index]
    report(91)

    climate = _climate_summary(scenario)
    events = _environment_events(
        scenario, epoch, times, external_data.get("weather", {}), external_data.get("space_weather", {})
    )
    values = [item["availability"]["min_pct"] for item in profiles]
    warnings = _warnings(source_passports, orbit, external_data)
    result_id = f"research_{uuid.uuid4().hex[:12]}"
    result = {
        "schema": "polaris-research-result-1",
        "id": result_id,
        "created_at": _iso(datetime.now(timezone.utc)),
        "epoch": _iso(epoch),
        "scenario_hash": scenario.content_hash(),
        "scenario": scenario.to_dict(),
        "status": "ready",
        "classification": "Исследовательский расчёт с модельными параметрами оборудования",
        "operational_use": False,
        "options": {
            "link_mode": options.link_mode,
            "strategy": options.strategy,
            "step_s": step_s,
            "boundary_resolution_s": 1,
            "profile_ids": list(options.profile_ids),
        },
        "fast_baseline": fast_summary,
        "availability_range": {
            "min_pct": round(min(values), 2),
            "max_pct": round(max(values), 2),
            "nominal_pct": next(
                (item["availability"]["min_pct"] for item in profiles if item["id"] == "nominal"),
                None,
            ),
        },
        "profiles": profiles,
        "orbit_model": orbit.metadata,
        "link_models": {
            "rf": "двунаправленный budget: FSPL + газ/пар + дождь + облака + снег + Doppler + наведение",
            "optical": "1550 нм: геометрические потери + апертуры + наведение",
            "climate": climate,
            "max_margin_unit": "dB",
        },
        "sources": source_passports,
        "events": events,
        "hazards": hazards,
        "warnings": warnings,
        "assumptions": _assumptions(profiles, orbit),
        "elapsed_ms": round((time.perf_counter() - started) * 1000.0, 2),
    }
    report(100)
    return result


def _geometry(
    scenario: Scenario,
    orbit: OrbitResult,
    active: np.ndarray,
    elevation_data: dict[str, Any],
) -> dict[str, Any]:
    pairs = pair_indices(len(scenario.satellites))
    isl, isl_distance, isl_clear = isl_links(
        orbit.fixed_km, active, scenario.environment.isl_range_km, pairs
    )
    pair_i, pair_j = pairs
    delta = orbit.fixed_km[:, pair_j] - orbit.fixed_km[:, pair_i]
    relative_velocity = orbit.velocity_fixed_km_s[:, pair_j] - orbit.velocity_fixed_km_s[:, pair_i]
    unit = delta / np.maximum(isl_distance[:, :, None], 1e-9)
    isl_radial = np.sum(relative_velocity * unit, axis=2)

    ground: dict[str, dict[str, np.ndarray]] = {}
    elevations = elevation_data.get("sites", {}) if isinstance(elevation_data, dict) else {}
    for site in scenario.ground_sites:
        height = float(elevations.get(site.id, {}).get("elevation_m", 0.0) or 0.0)
        site_xyz = _ground_position(site, height)
        difference = orbit.fixed_km - site_xyz
        distance = np.linalg.norm(difference, axis=2)
        normal = site_xyz / np.linalg.norm(site_xyz)
        cosine = np.sum(difference * normal, axis=2) / np.maximum(distance, 1e-9)
        elevation = np.degrees(np.arcsin(np.clip(cosine, -1.0, 1.0)))
        visible = (elevation >= scenario.environment.min_elevation_deg) & active
        radial = np.sum(orbit.velocity_fixed_km_s * difference / np.maximum(distance[:, :, None], 1e-9), axis=2)
        ground[site.id] = {
            "distance": distance,
            "elevation": elevation,
            "visible": visible,
            "radial": radial,
            "elevation_m": np.array(height),
        }
    return {
        "pairs": pairs,
        "isl": isl,
        "isl_distance": isl_distance,
        "isl_clear": isl_clear,
        "isl_radial": isl_radial,
        "ground": ground,
    }


def _run_profile(
    scenario: Scenario,
    epoch: datetime,
    times: np.ndarray,
    active: np.ndarray,
    gateway_online: dict[str, np.ndarray],
    geometry: dict[str, Any],
    weather: dict[str, Any],
    profile: dict[str, Any],
    options: ResearchOptions,
) -> dict[str, Any]:
    ground_budgets: dict[str, BudgetMatrix] = {}
    weather_by_site: dict[str, dict[str, np.ndarray]] = {}
    for site in scenario.ground_sites:
        conditions = weather_series(weather, site.id, epoch, times)
        weather_by_site[site.id] = conditions
        equipment = profile["client" if site.is_client else "gateway"]
        geo = geometry["ground"][site.id]
        visible = geo["visible"].copy()
        if site.is_gateway:
            visible &= gateway_online[site.id][:, None]
        budget = ground_budget(
            distance_km=geo["distance"],
            elevation_deg=geo["elevation"],
            radial_velocity_km_s=geo["radial"],
            geometric_visible=visible,
            conditions=conditions,
            equipment=equipment,
        )
        _limit_ground_terminals(budget, int(equipment["terminals"]))
        ground_budgets[site.id] = budget

    rf = rf_isl_budget(
        geometry["isl_distance"], geometry["isl_radial"], geometry["isl"], profile["rf_isl"]
    )
    optical = optical_isl_budget(
        geometry["isl_distance"], geometry["isl"], profile["optical_isl"]
    )
    if options.link_mode == "rf":
        isl_budget = rf
        terminal_count = int(profile["rf_isl"]["terminals"])
    elif options.link_mode == "optical":
        isl_budget = optical
        terminal_count = int(profile["optical_isl"]["terminals"])
    else:
        isl_budget = _hybrid(rf, optical)
        terminal_count = int(profile["rf_isl"]["terminals"]) + int(profile["optical_isl"]["terminals"])
    apply_terminal_capacity(isl_budget, geometry["pairs"], len(scenario.satellites), terminal_count)

    clients: list[dict[str, Any]] = []
    representative: dict[str, Any] | None = None
    for client in scenario.clients:
        outcome, candidate_passport = _route_client(
            scenario,
            client,
            times,
            active,
            geometry,
            ground_budgets,
            isl_budget,
            rf,
            optical,
            options,
        )
        clients.append(outcome)
        if candidate_passport and (
            representative is None
            or candidate_passport["margin_db"] < representative["margin_db"]
        ):
            representative = candidate_passport

    availabilities = [client["availability_pct"] for client in clients]
    causes: Counter[str] = Counter()
    for client in clients:
        causes.update(client["cause_totals_s"])
    return {
        "id": profile["id"],
        "label": profile["label"],
        "description": profile["description"],
        "tone": profile["tone"],
        "assumption": True,
        "availability": {
            "min_pct": round(min(availabilities), 2) if availabilities else 0.0,
            "mean_pct": round(sum(availabilities) / len(availabilities), 2) if availabilities else 0.0,
            "max_pct": round(max(availabilities), 2) if availabilities else 0.0,
        },
        "clients": clients,
        "cause_totals_s": dict(causes),
        "line_passport": representative,
        "equipment": profile,
    }


def _route_client(
    scenario: Scenario,
    client: GroundSite,
    times: np.ndarray,
    active: np.ndarray,
    geometry: dict[str, Any],
    ground_budgets: dict[str, BudgetMatrix],
    isl_budget: BudgetMatrix,
    rf_budget: BudgetMatrix,
    optical_budget: BudgetMatrix,
    options: ResearchOptions,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    n_sat = len(scenario.satellites)
    pair_i, pair_j = geometry["pairs"]
    pair_lookup = {(int(a), int(b)): index for index, (a, b) in enumerate(zip(pair_i, pair_j))}
    states = np.zeros(times.size, dtype=bool)
    causes: list[str] = ["none"] * times.size
    margins = np.full(times.size, np.nan)
    latencies = np.full(times.size, np.nan)
    hops = np.full(times.size, np.nan)
    routes: list[list[str]] = [[] for _ in times]
    representative: dict[str, Any] | None = None
    client_budget = ground_budgets[client.id]

    for step in range(times.size):
        graph = _step_graph(scenario, step, geometry, ground_budgets, isl_budget)
        available = np.flatnonzero(client_budget.available[step])
        sources = SourceLinks(
            satellites=[int(sat) for sat in available],
            distance=[float(client_budget.distance_km[step, sat]) for sat in available],
            margin=[float(client_budget.margin_db[step, sat]) for sat in available],
        )
        path = find_path(graph, sources, options.strategy)
        if path is None:
            causes[step] = _diagnose_engineering(
                scenario, step, client_budget, ground_budgets, isl_budget
            )
            continue
        states[step] = True
        margins[step] = path.min_margin
        latencies[step] = path.latency_ms
        hops[step] = path.hops
        gateway = scenario.gateways[path.gateway]
        routes[step] = [
            client.id,
            *(scenario.satellite_ids[index] for index in path.satellites),
            gateway.id,
        ]
        candidate = _path_passport(
            scenario, step, client, gateway, path.satellites, ground_budgets,
            isl_budget, rf_budget, optical_budget, pair_lookup, options.link_mode,
        )
        if candidate and (representative is None or candidate["margin_db"] < representative["margin_db"]):
            representative = {**candidate, "t_s": round(float(times[step])), "client_id": client.id}

    gaps = _gaps(states, causes, times, float(np.median(np.diff(times))) if times.size > 1 else 1.0)
    cause_totals: Counter[str] = Counter()
    step_s = float(np.median(np.diff(times))) if times.size > 1 else 1.0
    for cause in np.asarray(causes, dtype=object)[~states]:
        cause_totals[str(cause)] += step_s
    routed = int(states.sum())
    timeline = _segments(states, causes, times, step_s)
    return {
        "id": client.id,
        "name": client.name,
        "availability_pct": round(routed / max(states.size, 1) * 100.0, 2),
        "routed_steps": routed,
        "step_count": int(states.size),
        "mean_margin_db": round(float(np.nanmean(margins)), 2) if states.any() else None,
        "mean_latency_ms": round(float(np.nanmean(latencies)), 2) if states.any() else None,
        "mean_hops": round(float(np.nanmean(hops)), 2) if states.any() else None,
        "max_gap_s": max((gap["duration_s"] for gap in gaps), default=0),
        "gaps": gaps,
        "cause_totals_s": dict(cause_totals),
        "timeline": timeline,
        # Для экспорта сохраняются только изменения маршрута, а не тысячи дублей.
        "route_changes": _route_changes(routes, times),
    }, representative


def _step_graph(
    scenario: Scenario,
    step: int,
    geometry: dict[str, Any],
    ground: dict[str, BudgetMatrix],
    isl: BudgetMatrix,
) -> StepGraph:
    n_sat = len(scenario.satellites)
    neighbours: list[list[int]] = [[] for _ in range(n_sat + len(scenario.gateways))]
    distance: list[list[float]] = [[] for _ in neighbours]
    margin: list[list[float]] = [[] for _ in neighbours]
    pair_i, pair_j = geometry["pairs"]
    for edge in np.flatnonzero(isl.available[step]):
        u, v = int(pair_i[edge]), int(pair_j[edge])
        d, m = float(isl.distance_km[step, edge]), float(isl.margin_db[step, edge])
        neighbours[u].append(v); distance[u].append(d); margin[u].append(m)
        neighbours[v].append(u); distance[v].append(d); margin[v].append(m)
    for gateway_index, gateway in enumerate(scenario.gateways):
        node = n_sat + gateway_index
        budget = ground[gateway.id]
        for sat in np.flatnonzero(budget.available[step]):
            sat = int(sat)
            neighbours[sat].append(node)
            distance[sat].append(float(budget.distance_km[step, sat]))
            margin[sat].append(float(budget.margin_db[step, sat]))
    return StepGraph(n_sat, len(scenario.gateways), neighbours, distance, margin)


def _diagnose_engineering(
    scenario: Scenario,
    step: int,
    client: BudgetMatrix,
    ground: dict[str, BudgetMatrix],
    isl: BudgetMatrix,
) -> str:
    source = _dominant_link_cause(client, step)
    if not client.available[step].any():
        return source
    gateway_available = any(ground[gateway.id].available[step].any() for gateway in scenario.gateways)
    if not gateway_available:
        cause = Counter(
            _dominant_link_cause(ground[gateway.id], step) for gateway in scenario.gateways
        ).most_common(1)
        return cause[0][0] if cause else "gateway_unavailable"
    if not isl.available[step].any():
        cause = _dominant_link_cause(isl, step)
        return cause if cause not in {"none", "geometry"} else "network_split"
    return "network_split"


def _dominant_link_cause(budget: BudgetMatrix, step: int) -> str:
    codes = budget.cause[step]
    if budget.available[step].any():
        return "none"
    # Среди геометрически видимых кандидатов причина с наибольшим clear margin
    # информативнее простого большинства невидимых линий.
    candidate = int(np.argmax(budget.clear_margin_db[step])) if codes.size else 0
    code = int(codes[candidate]) if codes.size else 1
    return {
        1: "geometry", 2: "weather", 3: "insufficient_margin", 4: "doppler",
        5: "pointing", 6: "terminal_busy",
    }.get(code, "insufficient_margin")


def _path_passport(
    scenario: Scenario,
    step: int,
    client: GroundSite,
    gateway: GroundSite,
    satellites: list[int],
    ground: dict[str, BudgetMatrix],
    isl: BudgetMatrix,
    rf: BudgetMatrix,
    optical: BudgetMatrix,
    pair_lookup: dict[tuple[int, int], int],
    mode: str,
) -> dict[str, Any] | None:
    if not satellites:
        return None
    entries: list[dict[str, Any]] = []
    first, last = satellites[0], satellites[-1]
    entries.append(passport(
        ground[client.id], step, first, link_type="ground-user",
        endpoints=[client.id, scenario.satellite_ids[first]], frequency="14/12 GHz",
    ))
    for a, b in zip(satellites, satellites[1:]):
        index = pair_lookup[(min(a, b), max(a, b))]
        selected = isl
        kind, frequency = "RF ISL", "26 GHz"
        if mode == "optical" or (mode == "hybrid" and optical.margin_db[step, index] >= rf.margin_db[step, index]):
            selected, kind, frequency = optical, "Optical ISL", "193414 GHz"
        entries.append(passport(
            selected, step, index, link_type=kind,
            endpoints=[scenario.satellite_ids[a], scenario.satellite_ids[b]], frequency=frequency,
        ))
    entries.append(passport(
        ground[gateway.id], step, last, link_type="ground-gateway",
        endpoints=[scenario.satellite_ids[last], gateway.id], frequency="30/20 GHz",
    ))
    return min(entries, key=lambda item: item["margin_db"])


def _hybrid(rf: BudgetMatrix, optical: BudgetMatrix) -> BudgetMatrix:
    choose_optical = optical.margin_db >= rf.margin_db
    choose = lambda a, b: np.where(choose_optical, b, a)
    return BudgetMatrix(
        available=rf.available | optical.available,
        margin_db=np.maximum(rf.margin_db, optical.margin_db),
        distance_km=rf.distance_km,
        doppler_hz=choose(rf.doppler_hz, optical.doppler_hz),
        uplink_margin_db=choose(rf.uplink_margin_db, optical.uplink_margin_db),
        downlink_margin_db=choose(rf.downlink_margin_db, optical.downlink_margin_db),
        uplink_cn0_dbhz=choose(rf.uplink_cn0_dbhz, optical.uplink_cn0_dbhz),
        downlink_cn0_dbhz=choose(rf.downlink_cn0_dbhz, optical.downlink_cn0_dbhz),
        uplink_ebn0_db=choose(rf.uplink_ebn0_db, optical.uplink_ebn0_db),
        downlink_ebn0_db=choose(rf.downlink_ebn0_db, optical.downlink_ebn0_db),
        atmosphere_db=choose(rf.atmosphere_db, optical.atmosphere_db),
        pointing_db=choose(rf.pointing_db, optical.pointing_db),
        clear_margin_db=np.maximum(rf.clear_margin_db, optical.clear_margin_db),
        cause=choose(rf.cause, optical.cause).astype(np.int8),
    )


def _limit_ground_terminals(budget: BudgetMatrix, terminals: int) -> None:
    terminals = max(1, terminals)
    for step in range(budget.available.shape[0]):
        available = np.flatnonzero(budget.available[step])
        if available.size <= terminals:
            continue
        keep = available[np.argsort(budget.margin_db[step, available])[-terminals:]]
        mask = np.zeros(budget.available.shape[1], dtype=bool)
        mask[keep] = True
        dropped = budget.available[step] & ~mask
        budget.available[step, dropped] = False
        budget.cause[step, dropped] = 6


def _gaps(states: np.ndarray, causes: list[str], times: np.ndarray, step_s: float) -> list[dict[str, Any]]:
    missing = ~states
    padded = np.concatenate(([False], missing, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    gaps: list[dict[str, Any]] = []
    for start, stop in zip(edges[::2], edges[1::2]):
        # Переход между инженерными отсчётами интерполируется до целой секунды.
        begin = round(max(0.0, float(times[start]) - step_s / 2.0))
        end = round(float(times[stop - 1]) + step_s / 2.0)
        breakdown = Counter(causes[start:stop])
        cause = breakdown.most_common(1)[0][0]
        gaps.append({
            "start_s": begin,
            "end_s": end,
            "duration_s": max(0, end - begin),
            "cause": cause,
            "cause_label": CAUSE_LABEL.get(cause, cause),
            "cause_breakdown": dict(breakdown),
            "boundary_resolution_s": 1,
        })
    return gaps


def _segments(states: np.ndarray, causes: list[str], times: np.ndarray, step_s: float) -> list[dict[str, Any]]:
    labels = ["routed" if ok else cause for ok, cause in zip(states, causes)]
    if not labels:
        return []
    output: list[dict[str, Any]] = []
    start = 0
    for index in range(1, len(labels) + 1):
        if index < len(labels) and labels[index] == labels[start]:
            continue
        output.append({
            "start_s": round(max(0.0, float(times[start]) - (step_s / 2 if start else 0))),
            "end_s": round(float(times[index - 1]) + step_s / 2),
            "state": labels[start],
            "label": "маршрут доступен" if labels[start] == "routed" else CAUSE_LABEL.get(labels[start], labels[start]),
        })
        start = index
    return output


def _route_changes(routes: list[list[str]], times: np.ndarray) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    previous: list[str] | None = None
    for route, t_s in zip(routes, times):
        if route == previous:
            continue
        output.append({"t_s": round(float(t_s)), "path": route})
        previous = route
    return output


def _environment_events(
    scenario: Scenario,
    epoch: datetime,
    times: np.ndarray,
    weather: dict[str, Any],
    space_weather: dict[str, Any],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for site in scenario.ground_sites:
        values = weather_series(weather, site.id, epoch, times)
        rain = values["rain"]
        if rain.size and float(rain.max()) >= 0.2:
            index = int(np.argmax(rain))
            events.append({
                "type": "weather", "severity": "warning" if rain[index] >= 2 else "info",
                "site_id": site.id, "t_s": round(float(times[index])),
                "title": f"Осадки у {site.id}", "detail": f"до {rain[index]:.1f} мм/ч",
            })
        cloud = values["cloud_cover"]
        if cloud.size and float(cloud.max()) >= 90:
            index = int(np.argmax(cloud))
            events.append({
                "type": "weather", "severity": "info", "site_id": site.id,
                "t_s": round(float(times[index])), "title": f"Плотная облачность у {site.id}",
                "detail": f"{cloud[index]:.0f}% — критично только для оптической наземной линии",
            })
    kp = _extract_number(space_weather, ("kp_value", "kp"), 2.0)
    f107 = _extract_number(space_weather, ("f107_value", "flux", "f10.7"), 120.0)
    events.append({
        "type": "space_weather", "severity": "warning" if kp >= 5 else "info", "t_s": 0,
        "title": "Космическая погода NOAA",
        "detail": f"Kp≈{kp:.1f}, F10.7≈{f107:.0f}; учтено в чувствительности drag",
    })
    return sorted(events, key=lambda item: item["t_s"])


def _climate_summary(scenario: Scenario) -> dict[str, Any]:
    try:
        import itur

        samples: dict[str, float] = {}
        for site in scenario.ground_sites:
            frequency = 14.0 if site.is_client else 30.0
            value = itur.models.itu618.rain_attenuation(
                site.lat_deg, site.lon_deg, frequency, 10.0, p=0.1
            )
            samples[site.id] = round(float(getattr(value, "value", value)), 2)
        import importlib.metadata

        return {
            "engine": "ITU-Rpy",
            "version": importlib.metadata.version("itur"),
            "rain_attenuation_p0_1_db": samples,
            "status": "ready",
        }
    except Exception as error:  # noqa: BLE001 - текущая погода всё равно посчитана
        return {
            "engine": "POLARIS ITU-inspired approximation",
            "status": "fallback",
            "detail": (str(error) or error.__class__.__name__)[:180],
        }


def _warnings(
    passports: list[dict[str, Any]], orbit: OrbitResult, external_data: dict[str, Any]
) -> list[str]:
    warnings = [
        "Параметры передатчиков и антенн являются модельными; результат не предназначен для эксплуатации или сертификации."
    ]
    fallback = [item["label"] for item in passports if item.get("status") in {"fallback", "stale"}]
    if fallback:
        warnings.append("Fallback/устаревшие источники: " + ", ".join(fallback))
    if orbit.metadata.get("fallback"):
        warnings.append("SatKit недоступен: движение рассчитано круговой моделью быстрого режима.")
    if not external_data.get("celestrak", {}).get("objects"):
        warnings.append("Каталог сближений не загружен; слой опасных объектов пуст.")
    return warnings


def _assumptions(profiles: list[dict[str, Any]], orbit: OrbitResult) -> list[dict[str, Any]]:
    return [
        {"field": "hardware", "value": "conservative / nominal / enhanced", "kind": "model"},
        {"field": "eccentricity", "value": orbit.metadata.get("assumptions", {}).get("eccentricity", 0), "kind": "model"},
        {"field": "mass_and_area", "value": orbit.metadata.get("assumptions", {}), "kind": "model"},
        {"field": "duplex_rule", "value": "uplink margin > 0 dB AND downlink margin > 0 dB", "kind": "model"},
        {"field": "profile_count", "value": len(profiles), "kind": "model"},
    ]


def _ground_position(site: GroundSite, elevation_m: float) -> np.ndarray:
    lat, lon = math.radians(site.lat_deg), math.radians(site.lon_deg)
    radius = EARTH_RADIUS_KM + elevation_m / 1000.0
    return radius * np.array(
        [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)],
        dtype=np.float64,
    )


def _extract_number(value: Any, keys: tuple[str, ...], default: float) -> float:
    wanted = {item.lower() for item in keys}
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in wanted:
                try:
                    return float(child)
                except (TypeError, ValueError):
                    pass
        for child in reversed(list(value.values())):
            result = _extract_number(child, keys, math.nan)
            if math.isfinite(result):
                return result
    if isinstance(value, list):
        for child in reversed(value[-24:]):
            result = _extract_number(child, keys, math.nan)
            if math.isfinite(result):
                return result
    return default


def _reporter(progress: Callable[[int, int], None] | None) -> Callable[[int], None]:
    last = -1

    def report(value: int) -> None:
        nonlocal last
        value = max(last, min(100, int(value)))
        if progress and value != last:
            progress(value, 100)
        last = value

    return report


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
