"""Физические запасы RF/optical-линий для инженерного графа."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import numpy as np

from ..domain.constants import SPEED_OF_LIGHT_KM_S


@dataclass(slots=True)
class BudgetMatrix:
    available: np.ndarray
    margin_db: np.ndarray
    distance_km: np.ndarray
    doppler_hz: np.ndarray
    uplink_margin_db: np.ndarray
    downlink_margin_db: np.ndarray
    uplink_cn0_dbhz: np.ndarray
    downlink_cn0_dbhz: np.ndarray
    uplink_ebn0_db: np.ndarray
    downlink_ebn0_db: np.ndarray
    atmosphere_db: np.ndarray
    pointing_db: np.ndarray
    clear_margin_db: np.ndarray
    cause: np.ndarray


CAUSE_NAME = {
    0: "none",
    1: "geometry",
    2: "weather",
    3: "insufficient_margin",
    4: "doppler",
    5: "pointing",
    6: "terminal_busy",
    7: "network_split",
    8: "gateway_unavailable",
}

CAUSE_LABEL = {
    "none": "маршрут доступен",
    "geometry": "нет геометрической видимости",
    "weather": "погодные потери",
    "insufficient_margin": "недостаточный энергетический запас",
    "doppler": "Doppler вне полосы сопровождения",
    "pointing": "потери наведения",
    "terminal_busy": "заняты терминалы",
    "network_split": "разрыв сети",
    "gateway_unavailable": "шлюз недоступен",
}


def fspl_db(distance_km: np.ndarray | float, frequency_ghz: float) -> np.ndarray:
    distance = np.maximum(np.asarray(distance_km, dtype=np.float64), 1e-9)
    return 92.45 + 20.0 * np.log10(distance) + 20.0 * math.log10(frequency_ghz)


def weather_series(
    weather: dict[str, Any], site_id: str, epoch: datetime, times: np.ndarray
) -> dict[str, np.ndarray]:
    """Сопоставить почасовой снимок погоде расчётной сетки."""
    defaults = {
        "rain": 0.0,
        "snowfall": 0.0,
        "cloud_cover": 15.0,
        "temperature_2m": 15.0,
        "relative_humidity_2m": 50.0,
        "surface_pressure": 1013.25,
        "visibility": 30000.0,
    }
    output = {key: np.full(times.size, value, dtype=np.float64) for key, value in defaults.items()}
    hourly = weather.get("sites", {}).get(site_id, {}).get("hourly", {})
    raw_times = hourly.get("time", []) if isinstance(hourly, dict) else []
    if not raw_times:
        return output
    parsed: list[float] = []
    for value in raw_times:
        try:
            instant = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if instant.tzinfo is None:
                instant = instant.replace(tzinfo=epoch.tzinfo)
            parsed.append((instant - epoch).total_seconds())
        except (TypeError, ValueError):
            parsed.append(math.nan)
    source_times = np.asarray(parsed, dtype=np.float64)
    valid_time = np.isfinite(source_times)
    if not valid_time.any():
        return output
    source_times = source_times[valid_time]
    for key in defaults:
        values = hourly.get(key, [])
        if not isinstance(values, list) or len(values) != len(raw_times):
            continue
        numeric = np.asarray(
            [float(item) if item is not None else math.nan for item in values], dtype=np.float64
        )[valid_time]
        good = np.isfinite(numeric)
        if good.any():
            output[key] = np.interp(
                times, source_times[good], numeric[good], left=numeric[good][0], right=numeric[good][-1]
            )
    return output


def atmospheric_loss_db(
    frequency_ghz: float,
    elevation_deg: np.ndarray,
    conditions: dict[str, np.ndarray],
) -> np.ndarray:
    """Текущие потери по ITU-подобным компонентам.

    ITU-Rpy используется для климатического паспорта в engine; для фактической
    почасовой погоды здесь нужна детерминированная модель, принимающая именно
    измеренные rain/cloud/pressure поля снимка.
    """
    sin_el = np.maximum(np.sin(np.radians(np.maximum(elevation_deg, 2.0))), 0.035)
    rain = np.maximum(conditions["rain"], 0.0)[:, None]
    snow = np.maximum(conditions["snowfall"], 0.0)[:, None]
    cloud = np.clip(conditions["cloud_cover"], 0.0, 100.0)[:, None]
    pressure = np.clip(conditions["surface_pressure"], 750.0, 1080.0)[:, None]
    humidity = np.clip(conditions["relative_humidity_2m"], 0.0, 100.0)[:, None]

    gas = (0.035 + 0.017 * frequency_ghz) * (pressure / 1013.25) / sin_el
    vapour = 0.00006 * frequency_ghz**1.55 * humidity / sin_el
    # Удельное ослабление и эффективная длина дождевого участка. Коэффициент
    # подобран консервативно для Ku/Ka и сохраняет физически верный порядок.
    rain_specific = 0.00010 * frequency_ghz**2.0 * np.power(rain, 0.88)
    rain_path = np.minimum(7.0, 2.2 / sin_el)
    rain_loss = rain_specific * rain_path
    cloud_loss = 0.00022 * frequency_ghz * cloud / sin_el
    snow_loss = 0.008 * frequency_ghz * np.sqrt(snow) / sin_el
    return gas + vapour + rain_loss + cloud_loss + snow_loss


def ground_budget(
    *,
    distance_km: np.ndarray,
    elevation_deg: np.ndarray,
    radial_velocity_km_s: np.ndarray,
    geometric_visible: np.ndarray,
    conditions: dict[str, np.ndarray],
    equipment: dict[str, Any],
) -> BudgetMatrix:
    uplink = equipment["uplink"]
    downlink = equipment["downlink"]
    up = _rf_direction(distance_km, elevation_deg, radial_velocity_km_s, conditions, uplink)
    down = _rf_direction(distance_km, elevation_deg, radial_velocity_km_s, conditions, downlink)
    margin = np.minimum(up["margin"], down["margin"])
    clear_margin = np.minimum(up["clear_margin"], down["clear_margin"])
    atmosphere = np.maximum(up["atmosphere"], down["atmosphere"])
    pointing = np.maximum(up["pointing"], down["pointing"])
    doppler = np.maximum(np.abs(up["doppler"]), np.abs(down["doppler"]))
    available = geometric_visible & (up["margin"] > 0.0) & (down["margin"] > 0.0)
    cause = classify_failure(
        geometric_visible, available, margin, clear_margin, atmosphere,
        np.maximum(up["doppler_loss"], down["doppler_loss"]), pointing,
    )
    return BudgetMatrix(
        available=available,
        margin_db=margin,
        distance_km=distance_km,
        doppler_hz=doppler,
        uplink_margin_db=up["margin"],
        downlink_margin_db=down["margin"],
        uplink_cn0_dbhz=up["cn0"],
        downlink_cn0_dbhz=down["cn0"],
        uplink_ebn0_db=up["ebn0"],
        downlink_ebn0_db=down["ebn0"],
        atmosphere_db=atmosphere,
        pointing_db=pointing,
        clear_margin_db=clear_margin,
        cause=cause,
    )


def rf_isl_budget(
    distance_km: np.ndarray,
    radial_velocity_km_s: np.ndarray,
    geometric_visible: np.ndarray,
    equipment: dict[str, Any],
) -> BudgetMatrix:
    empty_conditions = {
        key: np.zeros(distance_km.shape[0], dtype=np.float64)
        for key in ("rain", "snowfall", "cloud_cover", "relative_humidity_2m")
    }
    empty_conditions["surface_pressure"] = np.zeros(distance_km.shape[0], dtype=np.float64)
    empty_conditions["temperature_2m"] = np.zeros(distance_km.shape[0], dtype=np.float64)
    empty_conditions["visibility"] = np.full(distance_km.shape[0], 1e9, dtype=np.float64)
    direction = _rf_direction(
        distance_km,
        np.full_like(distance_km, 90.0),
        radial_velocity_km_s,
        empty_conditions,
        equipment,
        atmosphere=False,
    )
    margin = direction["margin"]
    available = geometric_visible & (margin > 0.0)
    cause = classify_failure(
        geometric_visible, available, margin, direction["clear_margin"],
        np.zeros_like(margin), direction["doppler_loss"], direction["pointing"],
    )
    return BudgetMatrix(
        available=available,
        margin_db=margin,
        distance_km=distance_km,
        doppler_hz=np.abs(direction["doppler"]),
        uplink_margin_db=margin,
        downlink_margin_db=margin,
        uplink_cn0_dbhz=direction["cn0"],
        downlink_cn0_dbhz=direction["cn0"],
        uplink_ebn0_db=direction["ebn0"],
        downlink_ebn0_db=direction["ebn0"],
        atmosphere_db=np.zeros_like(margin),
        pointing_db=direction["pointing"],
        clear_margin_db=direction["clear_margin"],
        cause=cause,
    )


def optical_isl_budget(
    distance_km: np.ndarray,
    geometric_visible: np.ndarray,
    equipment: dict[str, Any],
) -> BudgetMatrix:
    frequency_ghz = 299792458.0 / (float(equipment["wavelength_nm"]) * 1e-9) / 1e9
    spreading = fspl_db(distance_km, frequency_ghz)
    pointing = np.full_like(distance_km, float(equipment["pointing_loss_db"]))
    received = (
        float(equipment["tx_power_dbw"])
        + float(equipment["tx_gain_dbi"])
        + float(equipment["rx_gain_dbi"])
        - spreading
        - pointing
    )
    margin = received - float(equipment["required_rx_dbw"])
    available = geometric_visible & (margin > 0.0)
    cause = np.where(~geometric_visible, 1, np.where(margin <= 0, 3, 0)).astype(np.int8)
    zeros = np.zeros_like(margin)
    return BudgetMatrix(
        available=available,
        margin_db=margin,
        distance_km=distance_km,
        doppler_hz=zeros,
        uplink_margin_db=margin,
        downlink_margin_db=margin,
        uplink_cn0_dbhz=np.full_like(margin, np.nan),
        downlink_cn0_dbhz=np.full_like(margin, np.nan),
        uplink_ebn0_db=np.full_like(margin, np.nan),
        downlink_ebn0_db=np.full_like(margin, np.nan),
        atmosphere_db=zeros,
        pointing_db=pointing,
        clear_margin_db=margin + pointing,
        cause=cause,
    )


def apply_terminal_capacity(
    budget: BudgetMatrix,
    pairs: tuple[np.ndarray, np.ndarray],
    satellite_count: int,
    terminals: int,
) -> None:
    """Оставить лучшие физически доступные ISL при ограниченном числе терминалов."""
    terminals = max(1, int(terminals))
    pair_i, pair_j = pairs
    for step in range(budget.available.shape[0]):
        candidates = np.flatnonzero(budget.available[step])
        if candidates.size == 0:
            continue
        order = candidates[np.argsort(budget.margin_db[step, candidates])[::-1]]
        degree = np.zeros(satellite_count, dtype=np.int16)
        keep = np.zeros(budget.available.shape[1], dtype=bool)
        for edge in order:
            u, v = int(pair_i[edge]), int(pair_j[edge])
            if degree[u] >= terminals or degree[v] >= terminals:
                continue
            keep[edge] = True
            degree[u] += 1
            degree[v] += 1
        dropped = budget.available[step] & ~keep
        budget.available[step, dropped] = False
        budget.cause[step, dropped] = 6


def passport(
    budget: BudgetMatrix,
    step: int,
    link: int,
    *,
    link_type: str,
    endpoints: list[str],
    frequency: str,
) -> dict[str, Any]:
    distance = float(budget.distance_km[step, link])
    return {
        "type": link_type,
        "endpoints": endpoints,
        "frequency": frequency,
        "distance_km": round(distance, 2),
        "fspl_db": round(float(fspl_db(distance, _frequency_ghz(frequency))), 2),
        "atmosphere_db": round(float(budget.atmosphere_db[step, link]), 2),
        "pointing_db": round(float(budget.pointing_db[step, link]), 2),
        "doppler_hz": round(float(budget.doppler_hz[step, link])),
        "uplink_margin_db": round(float(budget.uplink_margin_db[step, link]), 2),
        "downlink_margin_db": round(float(budget.downlink_margin_db[step, link]), 2),
        "uplink_cn0_dbhz": _finite_round(budget.uplink_cn0_dbhz[step, link]),
        "downlink_cn0_dbhz": _finite_round(budget.downlink_cn0_dbhz[step, link]),
        "uplink_ebn0_db": _finite_round(budget.uplink_ebn0_db[step, link]),
        "downlink_ebn0_db": _finite_round(budget.downlink_ebn0_db[step, link]),
        "margin_db": round(float(budget.margin_db[step, link]), 2),
        "available": bool(budget.available[step, link]),
        "cause": CAUSE_NAME[int(budget.cause[step, link])],
    }


def _rf_direction(
    distance_km: np.ndarray,
    elevation_deg: np.ndarray,
    radial_velocity_km_s: np.ndarray,
    conditions: dict[str, np.ndarray],
    equipment: dict[str, Any],
    *,
    atmosphere: bool = True,
) -> dict[str, np.ndarray]:
    frequency = float(equipment["frequency_ghz"])
    path = fspl_db(distance_km, frequency)
    atmospheric = (
        atmospheric_loss_db(frequency, elevation_deg, conditions)
        if atmosphere
        else np.zeros_like(distance_km)
    )
    pointing = np.full_like(distance_km, float(equipment.get("pointing_loss_db", 0.0)))
    doppler = radial_velocity_km_s / SPEED_OF_LIGHT_KM_S * frequency * 1e9
    tracking_hz = float(equipment.get("doppler_tracking_hz", max(350_000.0, frequency * 35_000.0)))
    excess = np.maximum(np.abs(doppler) - tracking_hz, 0.0)
    doppler_loss = np.minimum(12.0, 3.0 * excess / max(tracking_hz, 1.0))
    cn0 = (
        float(equipment["eirp_dbw"])
        + float(equipment["g_over_t_db_k"])
        - path
        - atmospheric
        - pointing
        - doppler_loss
        + 228.6
    )
    ebn0 = cn0 - 10.0 * math.log10(float(equipment["bitrate_mbps"]) * 1e6)
    margin = ebn0 - float(equipment["required_ebn0_db"])
    clear_margin = margin + atmospheric + pointing + doppler_loss
    return {
        "margin": margin,
        "clear_margin": clear_margin,
        "atmosphere": atmospheric,
        "pointing": pointing,
        "doppler": doppler,
        "doppler_loss": doppler_loss,
        "cn0": cn0,
        "ebn0": ebn0,
    }


def classify_failure(
    geometric: np.ndarray,
    available: np.ndarray,
    margin: np.ndarray,
    clear_margin: np.ndarray,
    atmosphere: np.ndarray,
    doppler_loss: np.ndarray,
    pointing: np.ndarray,
) -> np.ndarray:
    cause = np.zeros(available.shape, dtype=np.int8)
    cause[~geometric] = 1
    failed = geometric & ~available
    weather = failed & (clear_margin > 0.0) & (margin + atmosphere > 0.0) & (atmosphere > 0.2)
    cause[weather] = 2
    doppler = failed & ~weather & (margin + doppler_loss > 0.0) & (doppler_loss > 0.05)
    cause[doppler] = 4
    pointing_failed = failed & ~weather & ~doppler & (margin + pointing > 0.0)
    cause[pointing_failed] = 5
    cause[failed & (cause == 0)] = 3
    return cause


def _frequency_ghz(label: str) -> float:
    value = label.lower().replace("ghz", "").replace("ггц", "").strip().split("/")[0]
    try:
        return float(value)
    except ValueError:
        return 193_414.0 if "1550" in label else 1.0


def _finite_round(value: float) -> float | None:
    number = float(value)
    return round(number, 2) if math.isfinite(number) else None
