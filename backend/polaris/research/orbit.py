"""Орбитальный слой инженерной верификации.

Если SatKit установлен, проектные круговые орбиты превращаются в начальные
состояния GCRF и распространяются численным интегратором.  Если библиотека
недоступна, возвращается детерминированный результат штатной геометрии с
явной отметкой fallback — инженерный API продолжает работать офлайн.
"""

from __future__ import annotations

import importlib.metadata
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

import numpy as np

from ..domain.ephemeris import positions_at
from ..domain.scenario import Scenario


@dataclass(slots=True)
class OrbitResult:
    times: np.ndarray
    inertial_km: np.ndarray
    fixed_km: np.ndarray
    velocity_inertial_km_s: np.ndarray
    velocity_fixed_km_s: np.ndarray
    metadata: dict[str, Any]


def propagate_project(
    scenario: Scenario,
    epoch: datetime,
    times: np.ndarray,
    satellite_profile: dict[str, float],
    space_weather: dict[str, Any] | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> OrbitResult:
    """Распространить проектную группировку; прогресс считается по аппаратам."""
    try:
        import satkit as sk

        return _with_satkit(
            sk, scenario, epoch, times, satellite_profile, space_weather or {}, progress
        )
    except Exception as error:  # noqa: BLE001 - fallback является частью контракта
        return _fallback(scenario, times, error, progress)


def _with_satkit(
    sk: Any,
    scenario: Scenario,
    epoch: datetime,
    times: np.ndarray,
    satellite_profile: dict[str, float],
    space_weather: dict[str, Any],
    progress: Callable[[int, int], None] | None,
) -> OrbitResult:
    data_dir = os.getenv("POLARIS_SATKIT_DATA_DIR")
    if data_dir:
        sk.utils.set_datadir(data_dir)

    epoch = epoch.astimezone(timezone.utc)
    begin = sk.time.from_datetime(epoch)
    sk_times = [begin.add_utc_days(float(second) / 86400.0) for second in times]
    n_steps = len(times)
    n_sats = len(scenario.satellites)
    inertial = np.empty((n_steps, n_sats, 3), dtype=np.float64)
    velocity = np.empty_like(inertial)

    full_data = bool(sk.utils.datafiles_exist())
    settings = sk.propsettings(
        gravity_degree=8,
        gravity_order=8,
        enable_interp=True,
        use_spaceweather=False,  # NOAA-снимок входит через зафиксированный density scale ниже.
        use_sun_gravity=full_data,
        use_moon_gravity=full_data,
        use_relativistic_correction=full_data,
        tide_model=sk.tidemodel.solid_step1 if full_data else sk.tidemodel.none,
    )

    density_scale = _density_scale(space_weather)
    mass = max(float(satellite_profile.get("mass_kg", 260.0)), 1.0)
    area = max(float(satellite_profile.get("area_m2", 3.2)), 0.0)
    cd = max(float(satellite_profile.get("cd", 2.2)), 0.0)
    cr = max(float(satellite_profile.get("cr", 1.3)), 0.0)
    properties = sk.satproperties(
        cdaoverm=cd * area / mass * density_scale,
        craoverm=cr * area / mass if full_data else 0.0,
    )

    # Получаем состояние в ITRF, полностью совпадающее со сценарием в t=0,
    # и переводим его в реальный GCRF выбранной эпохи. Так инженерная модель
    # не получает произвольного сдвига долготы относительно быстрого режима.
    _, fixed0 = positions_at(scenario, np.array([0.0]))
    epsilon = 0.05
    _, fixed_pair = positions_at(scenario, np.array([-epsilon, epsilon]))
    fixed_velocity0 = (fixed_pair[1] - fixed_pair[0]) / (2.0 * epsilon)

    for sat in range(n_sats):
        p0, v0 = sk.frametransform.itrf_to_gcrf_state(
            fixed0[0, sat] * 1000.0,
            fixed_velocity0[sat] * 1000.0,
            begin,
        )
        propagated = sk.propagate(
            np.concatenate((p0, v0)),
            begin,
            duration_secs=max(float(times[-1]) if n_steps else 0.0, 1.0),
            propsettings=settings,
            satproperties=properties,
        )
        states = np.asarray(propagated.interp(sk_times), dtype=np.float64)
        if states.ndim == 1:
            states = states[None, :]
        inertial[:, sat] = states[:, :3] / 1000.0
        velocity[:, sat] = states[:, 3:] / 1000.0
        if progress:
            progress(sat + 1, n_sats)

    quaternions = sk.frametransform.qgcrf2itrf(sk_times)
    rotations = np.stack([np.asarray(q.as_rotation_matrix(), dtype=np.float64) for q in quaternions])
    fixed = np.einsum("tij,tsj->tsi", rotations, inertial)
    # Скорость в связанной системе нужна для Doppler. Численная производная
    # фиксированных координат уже включает вращение Земли и устойчива на сетке.
    velocity_fixed = _gradient(fixed, times)

    return OrbitResult(
        times=times,
        inertial_km=inertial,
        fixed_km=fixed,
        velocity_inertial_km_s=velocity,
        velocity_fixed_km_s=velocity_fixed,
        metadata={
            "engine": "satkit",
            "version": importlib.metadata.version("satkit"),
            "frame": "GCRF→ITRF (IERS 2010)",
            "gravity": "EGM96 8×8",
            "sun_moon": full_data,
            "radiation_pressure": full_data,
            "drag": True,
            "density_scale": round(density_scale, 4),
            "eop_status": str(sk.frametransform.eop_status(begin)),
            "fallback": False,
            "assumptions": {
                "eccentricity": 0.0,
                "mass_kg": mass,
                "area_m2": area,
                "cd": cd,
                "cr": cr,
            },
        },
    )


def _fallback(
    scenario: Scenario,
    times: np.ndarray,
    error: Exception,
    progress: Callable[[int, int], None] | None,
) -> OrbitResult:
    inertial, fixed = positions_at(scenario, times)
    if progress:
        progress(len(scenario.satellites), len(scenario.satellites))
    return OrbitResult(
        times=times,
        inertial_km=inertial,
        fixed_km=fixed,
        velocity_inertial_km_s=_gradient(inertial, times),
        velocity_fixed_km_s=_gradient(fixed, times),
        metadata={
            "engine": "polaris-circular-fallback",
            "version": "1",
            "frame": "система быстрого режима",
            "gravity": "центральное поле",
            "sun_moon": False,
            "radiation_pressure": False,
            "drag": False,
            "fallback": True,
            "fallback_reason": (str(error) or error.__class__.__name__)[:240],
            "assumptions": {"eccentricity": 0.0},
        },
    )


def _gradient(values: np.ndarray, times: np.ndarray) -> np.ndarray:
    if len(times) < 2:
        return np.zeros_like(values)
    edge_order = 2 if len(times) >= 3 else 1
    return np.gradient(values, times, axis=0, edge_order=edge_order)


def _density_scale(payload: dict[str, Any]) -> float:
    """Сводный масштаб drag из зафиксированных F10.7/Kp/Ap.

    SatKit не принимает произвольный массив NOAA напрямую, поэтому индексы
    меняют эффективное CdA/m. Это исследовательская чувствительность, а не
    подмена полноценной ассимиляции космической погоды.
    """
    f107 = _find_number(payload, ("f107_value", "flux", "f10.7", "f107"), 120.0)
    kp = _find_number(payload, ("kp_value", "kp", "kP"), 2.0)
    ap = _find_number(payload, ("ap_value", "ap"), 7.0)
    return min(3.0, max(0.6, 1.0 + (f107 - 120.0) / 300.0 + kp / 18.0 + ap / 250.0))


def _find_number(value: Any, keys: tuple[str, ...], default: float) -> float:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in {candidate.lower() for candidate in keys}:
                try:
                    return float(child)
                except (TypeError, ValueError):
                    pass
        for child in reversed(list(value.values())):
            found = _find_number(child, keys, math.nan)
            if math.isfinite(found):
                return found
    elif isinstance(value, list):
        for child in reversed(value[-24:]):
            found = _find_number(child, keys, math.nan)
            if math.isfinite(found):
                return found
    return default
