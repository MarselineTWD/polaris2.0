"""Каталожный screening сближений без недостоверной вероятности столкновения."""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone
from typing import Any

import numpy as np

from ..domain.constants import EARTH_RADIUS_KM, MU_KM3_S2
from .orbit import OrbitResult


def screen_hazards(
    catalog: dict[str, Any], orbit: OrbitResult, epoch: datetime, inclination_deg: float
) -> dict[str, Any]:
    objects = catalog.get("objects", []) if isinstance(catalog, dict) else []
    if not isinstance(objects, list) or not objects:
        return {
            "status": "unavailable",
            "events": [],
            "screened_objects": 0,
            "detail": "Снимок CelesTrak отсутствует; слой рисков не рассчитан",
            "probability_computed": False,
        }

    project_altitude = float(np.linalg.norm(orbit.inertial_km[0, 0]) - EARTH_RADIUS_KM)
    candidates: list[tuple[dict[str, Any], dict[str, float]]] = []
    for item in objects:
        elements = _elements(item, epoch)
        if elements is None:
            continue
        shell_delta = abs(elements["a_km"] - EARTH_RADIUS_KM - project_altitude)
        inc_delta = min(
            abs(elements["inclination_rad"] - math.radians(inclination_deg)),
            abs(elements["inclination_rad"] - math.radians(180.0 - inclination_deg)),
        )
        if shell_delta <= 350.0 and inc_delta <= math.radians(28.0):
            elements["shell_delta"] = shell_delta
            candidates.append((item, elements))

    # Ограничение делает screening предсказуемым по времени; ближние оболочки
    # имеют приоритет. Это фильтр предварительного анализа, не CDM-анализ.
    candidates.sort(key=lambda pair: pair[1]["shell_delta"])
    candidates = candidates[:500]
    if not candidates:
        return {
            "status": "ready",
            "events": [],
            "screened_objects": 0,
            "catalog_objects": len(objects),
            "detail": "В соседних орбитальных оболочках объектов не найдено",
            "probability_computed": False,
        }

    stride = max(1, int(round(600.0 / max(float(np.median(np.diff(orbit.times))), 1.0))))
    indices = np.arange(0, len(orbit.times), stride, dtype=int)
    if indices[-1] != len(orbit.times) - 1:
        indices = np.append(indices, len(orbit.times) - 1)
    sample_times = orbit.times[indices]
    project_pos = orbit.inertial_km[indices]
    project_vel = orbit.velocity_inertial_km_s[indices]

    events: list[dict[str, Any]] = []
    for item, elements in candidates:
        position, velocity = _propagate(elements, sample_times)
        delta = position[:, None, :] - project_pos
        distance = np.linalg.norm(delta, axis=2)
        flat = int(np.argmin(distance))
        time_index, sat_index = np.unravel_index(flat, distance.shape)
        miss = float(distance[time_index, sat_index])
        if miss > 250.0:
            continue
        relative_velocity = float(
            np.linalg.norm(velocity[time_index] - project_vel[time_index, sat_index])
        )
        t_s = float(sample_times[time_index])
        norad = str(item.get("NORAD_CAT_ID") or item.get("OBJECT_ID") or "unknown")
        event_key = f"{norad}|{sat_index}|{round(t_s)}"
        event_id = "haz_" + hashlib.sha256(event_key.encode()).hexdigest()[:10]
        group = str(item.get("_group", ""))
        object_type = str(item.get("OBJECT_TYPE", "")).upper()
        is_debris = "DEBRIS" in object_type or "debris" in group
        severity = "critical" if miss < 10 else ("warning" if miss < 50 else "watch")
        events.append({
            "id": event_id,
            "t_s": round(t_s),
            "window_start_s": max(0, round(t_s - 600)),
            "window_end_s": min(round(float(orbit.times[-1]) + 1), round(t_s + 600)),
            "satellite_index": int(sat_index),
            "object_name": str(item.get("OBJECT_NAME") or norad),
            "norad_id": norad,
            "object_class": "debris" if is_debris else "catalogued_spacecraft",
            "miss_distance_km": round(miss, 2),
            "relative_velocity_km_s": round(relative_velocity, 3),
            "severity": severity,
            "sampling_s": 600,
            "scenario_available": True,
        })
    events.sort(key=lambda item: (item["miss_distance_km"], item["t_s"]))
    return {
        "status": "ready",
        "events": events[:30],
        "screened_objects": len(candidates),
        "catalog_objects": len(objects),
        "sampling_s": 600,
        "probability_computed": False,
        "detail": (
            "Предварительный TLE/OMM-screening. Вероятность столкновения не вычисляется: "
            "для неё требуются CDM и ковариации Space-Track."
        ),
    }


def _elements(item: dict[str, Any], run_epoch: datetime) -> dict[str, float] | None:
    try:
        mean_motion = float(item["MEAN_MOTION"])
        if mean_motion <= 0:
            return None
        n_rad_s = mean_motion * 2.0 * math.pi / 86400.0
        a_km = (MU_KM3_S2 / n_rad_s**2) ** (1.0 / 3.0)
        eccentricity = min(0.95, max(0.0, float(item.get("ECCENTRICITY", 0.0))))
        epoch = datetime.fromisoformat(str(item["EPOCH"]).replace("Z", "+00:00"))
        if epoch.tzinfo is None:
            epoch = epoch.replace(tzinfo=timezone.utc)
        return {
            "a_km": a_km,
            "eccentricity": eccentricity,
            "inclination_rad": math.radians(float(item["INCLINATION"])),
            "raan_rad": math.radians(float(item["RA_OF_ASC_NODE"])),
            "argp_rad": math.radians(float(item.get("ARG_OF_PERICENTER", 0.0))),
            "mean_anomaly_rad": math.radians(float(item.get("MEAN_ANOMALY", 0.0))),
            "mean_motion_rad_s": n_rad_s,
            "epoch_offset_s": (run_epoch - epoch.astimezone(timezone.utc)).total_seconds(),
        }
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def _propagate(elements: dict[str, float], run_times: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    e = elements["eccentricity"]
    mean = (
        elements["mean_anomaly_rad"]
        + elements["mean_motion_rad_s"] * (run_times + elements["epoch_offset_s"])
    )
    mean_wrapped = np.mod(mean, 2.0 * math.pi)
    eccentric = mean_wrapped.copy()
    for _ in range(6):
        eccentric -= (eccentric - e * np.sin(eccentric) - mean_wrapped) / np.maximum(
            1.0 - e * np.cos(eccentric), 1e-9
        )
    cos_e, sin_e = np.cos(eccentric), np.sin(eccentric)
    radius = elements["a_km"] * (1.0 - e * cos_e)
    true = np.arctan2(math.sqrt(max(1.0 - e * e, 1e-9)) * sin_e, cos_e - e)
    p = elements["a_km"] * (1.0 - e * e)
    local_pos = np.stack((radius * np.cos(true), radius * np.sin(true), np.zeros_like(true)), axis=1)
    scale = math.sqrt(MU_KM3_S2 / max(p, 1e-9))
    local_vel = np.stack(
        (-scale * np.sin(true), scale * (e + np.cos(true)), np.zeros_like(true)), axis=1
    )
    rotation = _rotation(elements["raan_rad"], elements["inclination_rad"], elements["argp_rad"])
    return local_pos @ rotation.T, local_vel @ rotation.T


def _rotation(raan: float, inclination: float, argp: float) -> np.ndarray:
    co, so = math.cos(raan), math.sin(raan)
    ci, si = math.cos(inclination), math.sin(inclination)
    cw, sw = math.cos(argp), math.sin(argp)
    return np.array(
        [
            [co * cw - so * sw * ci, -co * sw - so * cw * ci, so * si],
            [so * cw + co * sw * ci, -so * sw + co * cw * ci, -co * si],
            [sw * si, cw * si, ci],
        ],
        dtype=np.float64,
    )
