"""Орбитальная модель: положения аппаратов на сетке времени.

Формулы взяты из документа «Описание данных» и обязаны совпадать с
``Расчетный модуль/geometry.py`` бит в бит — на этом держится тест паритета.

Круговая орбита, сферическая Земля::

    r = R + altitude_km
    n = sqrt(mu / r^3)
    u(t) = slot_deg + phase_deg + n * t

    x = r * (cos O * cos u - sin O * sin u * cos i)
    y = r * (sin O * cos u + cos O * sin u * cos i)
    z = r * (sin u * sin i)

Переход в связанную с Землёй систему поворотом на theta = earth_angle0 + OMEGA * t.
"""

from __future__ import annotations

import math

import numpy as np

from .constants import EARTH_ANGULAR_RATE, EARTH_RADIUS_KM, MU_KM3_S2
from .scenario import GroundSite, Scenario


def time_grid(scenario: Scenario) -> np.ndarray:
    """Сетка отсчётов ``0, step, ..., horizon - step``.

    Правый конец расчётного периода в список отсчётов не включается —
    это явное требование «Описания данных».
    """
    env = scenario.environment
    return np.arange(0, env.horizon_s, env.step_s, dtype=np.float64)


def mean_motion(scenario: Scenario) -> float:
    """Угловая скорость обращения по круговой орбите, рад/с."""
    r = EARTH_RADIUS_KM + scenario.environment.altitude_km
    return math.sqrt(MU_KM3_S2 / r**3)


def orbit_radius(scenario: Scenario) -> float:
    return EARTH_RADIUS_KM + scenario.environment.altitude_km


def initial_arguments(scenario: Scenario) -> tuple[np.ndarray, np.ndarray]:
    """Начальный аргумент широты ``u0`` и RAAN каждого аппарата, радианы."""
    planes = {plane.id: plane for plane in scenario.planes}
    u0 = np.array(
        [
            math.radians(sat.slot_deg + planes[sat.plane_id].phase_deg)
            for sat in scenario.satellites
        ],
        dtype=np.float64,
    )
    raan = np.array(
        [math.radians(planes[sat.plane_id].raan_deg) for sat in scenario.satellites],
        dtype=np.float64,
    )
    return u0, raan


def positions_at(scenario: Scenario, times: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Положения всех аппаратов в моменты ``times``.

    Возвращает пару массивов ``(T, N, 3)``: инерциальные координаты и
    координаты в связанной с Землёй системе, обе в километрах.
    """
    times = np.atleast_1d(np.asarray(times, dtype=np.float64))
    env = scenario.environment
    r = orbit_radius(scenario)
    n = mean_motion(scenario)
    inclination = math.radians(env.inclination_deg)
    cos_i, sin_i = math.cos(inclination), math.sin(inclination)

    u0, raan = initial_arguments(scenario)
    # (T, N): аргумент широты каждого аппарата в каждый момент времени.
    u = u0[None, :] + n * times[:, None]
    cos_u, sin_u = np.cos(u), np.sin(u)
    cos_o, sin_o = np.cos(raan), np.sin(raan)

    inertial = np.stack(
        (
            r * (cos_o * cos_u - sin_o * sin_u * cos_i),
            r * (sin_o * cos_u + cos_o * sin_u * cos_i),
            r * (sin_u * sin_i),
        ),
        axis=2,
    )

    theta = math.radians(env.earth_angle0_deg) + EARTH_ANGULAR_RATE * times
    cos_t, sin_t = np.cos(theta)[:, None], np.sin(theta)[:, None]
    fixed = np.empty_like(inertial)
    fixed[:, :, 0] = cos_t * inertial[:, :, 0] + sin_t * inertial[:, :, 1]
    fixed[:, :, 1] = -sin_t * inertial[:, :, 0] + cos_t * inertial[:, :, 1]
    fixed[:, :, 2] = inertial[:, :, 2]
    return inertial, fixed


def ground_position(site: GroundSite) -> np.ndarray:
    """Декартовы координаты наземного пункта на сфере радиуса ``R``, км."""
    lat = math.radians(site.lat_deg)
    lon = math.radians(site.lon_deg)
    return EARTH_RADIUS_KM * np.array(
        [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)],
        dtype=np.float64,
    )


def active_mask(scenario: Scenario, times: np.ndarray) -> np.ndarray:
    """Маска ``(T, N)``: аппарат выведен по выбранной очереди и не в отказе.

    Недоступный аппарат сохраняет расчётное положение, но исключается из
    состава связей на период отказа — как требует «Описание данных».
    """
    times = np.atleast_1d(np.asarray(times, dtype=np.float64))
    index = {sat.id: k for k, sat in enumerate(scenario.satellites)}
    deployed = np.array(
        [sat.launch_batch <= scenario.launch_stage for sat in scenario.satellites],
        dtype=bool,
    )
    mask = np.broadcast_to(deployed, (times.size, deployed.size)).copy()
    for outage in scenario.failures:
        k = index.get(outage.target_id)
        if k is None:
            continue
        window = (times >= outage.start_s) & (times < outage.end_s)
        mask[window, k] = False
    return mask


def gateway_online_mask(scenario: Scenario, times: np.ndarray) -> dict[str, np.ndarray]:
    """Маска ``(T,)`` доступности каждого шлюза."""
    times = np.atleast_1d(np.asarray(times, dtype=np.float64))
    online = {gw.id: np.ones(times.size, dtype=bool) for gw in scenario.gateways}
    for outage in scenario.gateway_outages:
        if outage.target_id not in online:
            continue
        window = (times >= outage.start_s) & (times < outage.end_s)
        online[outage.target_id][window] = False
    return online
