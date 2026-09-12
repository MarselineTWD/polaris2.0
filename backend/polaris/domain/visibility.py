"""Состав доступных связей: наземные линии и межспутниковые линии (ISL).

Наземный контакт возможен, когда угол возвышения не ниже порога
``min_elevation_deg`` и аппарат активен. Для линии со шлюзом дополнительно
учитывается доступность самого шлюза.

Межспутниковая линия возможна, когда расстояние меньше ``isl_range_km``
и отрезок между аппаратами не перекрывается Землёй: ближайшая к центру точка
отрезка должна лежать дальше ``R``.

Расчёт идёт чанками по времени: временные массивы для пар аппаратов имеют
размер ``T x P x 3``, и при мелком шаге они легко вырастают до гигабайтов.
"""

from __future__ import annotations

import numpy as np

from .constants import EARTH_RADIUS_KM
from .ephemeris import (
    active_mask,
    gateway_online_mask,
    ground_position,
    positions_at,
    time_grid,
)
from .scenario import Scenario

#: Верхняя граница временных массивов внутри одного чанка, элементов float64.
#: 25e6 элементов ≈ 200 МБ пиковой памяти на промежуточные результаты.
_CHUNK_BUDGET = 25_000_000

#: Предел на объём задачи: число пар «шаг времени × пара аппаратов».
MAX_PAIR_STEPS = 40_000_000


class TaskTooLargeError(ValueError):
    """Задача превышает ресурсные лимиты сервиса."""

    def __init__(self, message: str, *, steps: int, pairs: int) -> None:
        self.steps = steps
        self.pairs = pairs
        super().__init__(message)


def pair_indices(n_satellites: int) -> tuple[np.ndarray, np.ndarray]:
    """Индексы всех неупорядоченных пар аппаратов."""
    return np.triu_indices(n_satellites, 1)


def chunk_size(n_pairs: int) -> int:
    """Сколько шагов времени обрабатывать за раз, чтобы удержать память."""
    per_step = max(1, n_pairs * 6)  # delta(3) + dist + lam + closest
    return max(1, _CHUNK_BUDGET // per_step)


def isl_links(
    fixed: np.ndarray,
    active: np.ndarray,
    isl_range_km: float,
    pairs: tuple[np.ndarray, np.ndarray],
) -> tuple[np.ndarray, np.ndarray]:
    """Доступность и длина межспутниковых линий для одного чанка.

    ``fixed`` — координаты ``(T, N, 3)``, ``active`` — маска ``(T, N)``.
    Возвращает ``(доступна, длина, не перекрыта Землёй)``, каждый ``(T, P)``.
    Маска «не перекрыта Землёй» нужна диагностике: она отделяет линии, которые
    нельзя восстановить увеличением дальности, от тех, которым не хватило дальности.
    """
    i, j = pairs
    a = fixed[:, i, :]
    b = fixed[:, j, :]
    delta = b - a
    distance = np.linalg.norm(delta, axis=2)

    # Ближайшая к центру Земли точка отрезка [a; b]: a + q*(b-a), q из [0; 1].
    denominator = np.sum(delta * delta, axis=2)
    q = np.clip(-np.sum(a * delta, axis=2) / np.maximum(denominator, 1e-12), 0.0, 1.0)
    closest = np.linalg.norm(a + q[:, :, None] * delta, axis=2)

    clear = closest > EARTH_RADIUS_KM
    available = (distance < isl_range_km) & clear & active[:, i] & active[:, j]
    return available, distance, clear


def ground_links(
    fixed: np.ndarray,
    active: np.ndarray,
    site_xyz: np.ndarray,
    min_elevation_deg: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Видимость аппаратов из наземного пункта для одного чанка.

    Возвращает ``(видим: (T, N) bool, угол возвышения: (T, N), дальность: (T, N))``.
    Доступность самого шлюза здесь не учитывается — она накладывается выше.
    """
    difference = fixed - site_xyz
    distance = np.linalg.norm(difference, axis=2)
    cosine = np.sum(difference * (site_xyz / EARTH_RADIUS_KM), axis=2) / distance
    elevation = np.degrees(np.arcsin(np.clip(cosine, -1.0, 1.0)))
    visible = (elevation >= min_elevation_deg) & active
    return visible, elevation, distance


class Topology:
    """Геометрическое состояние сети на всей расчётной сетке.

    Все массивы имеют ведущую ось времени. Хранится в ``float64``, чтобы
    результат совпадал с эталонным модулем; сжатие в компактный вид происходит
    только на границе с сетью (см. ``serialize.py``).
    """

    __slots__ = (
        "scenario", "times", "sat_ids", "sat_index", "pairs",
        "inertial", "fixed", "active", "isl", "isl_distance", "isl_clear",
        "ground_visible", "ground_elevation", "ground_distance", "gateway_online",
    )

    def __init__(self, scenario: Scenario) -> None:
        self.scenario = scenario
        self.times = time_grid(scenario)
        self.sat_ids = scenario.satellite_ids
        self.sat_index = {sid: k for k, sid in enumerate(self.sat_ids)}
        self.pairs = pair_indices(len(self.sat_ids))

        steps = self.times.size
        n_pairs = self.pairs[0].size
        if steps * max(n_pairs, 1) > MAX_PAIR_STEPS:
            raise TaskTooLargeError(
                f"Задача слишком велика: {steps} отсчётов × {n_pairs} пар аппаратов. "
                f"Увеличьте шаг расчёта или сократите состав группировки.",
                steps=steps,
                pairs=n_pairs,
            )

        n_sats = len(self.sat_ids)
        self.inertial = np.empty((steps, n_sats, 3), dtype=np.float64)
        self.fixed = np.empty((steps, n_sats, 3), dtype=np.float64)
        self.isl = np.empty((steps, n_pairs), dtype=bool)
        self.isl_distance = np.empty((steps, n_pairs), dtype=np.float64)
        self.isl_clear = np.empty((steps, n_pairs), dtype=bool)
        self.active = active_mask(scenario, self.times)
        self.gateway_online = gateway_online_mask(scenario, self.times)

        self.ground_visible: dict[str, np.ndarray] = {}
        self.ground_elevation: dict[str, np.ndarray] = {}
        self.ground_distance: dict[str, np.ndarray] = {}
        for site in scenario.ground_sites:
            self.ground_visible[site.id] = np.empty((steps, n_sats), dtype=bool)
            self.ground_elevation[site.id] = np.empty((steps, n_sats), dtype=np.float64)
            self.ground_distance[site.id] = np.empty((steps, n_sats), dtype=np.float64)

        self._fill(scenario, n_pairs)

    def _fill(self, scenario: Scenario, n_pairs: int) -> None:
        env = scenario.environment
        site_positions = {site.id: ground_position(site) for site in scenario.ground_sites}
        step = chunk_size(max(n_pairs, 1))

        for start in range(0, self.times.size, step):
            stop = min(start + step, self.times.size)
            window = slice(start, stop)
            chunk_times = self.times[window]

            inertial, fixed = positions_at(scenario, chunk_times)
            self.inertial[window] = inertial
            self.fixed[window] = fixed

            active = self.active[window]
            available, distance, clear = isl_links(
                fixed, active, env.isl_range_km, self.pairs
            )
            self.isl[window] = available
            self.isl_distance[window] = distance
            self.isl_clear[window] = clear

            for site in scenario.ground_sites:
                visible, elevation, site_distance = ground_links(
                    fixed, active, site_positions[site.id], env.min_elevation_deg
                )
                if site.is_gateway:
                    # Шлюз в отказе не принимает ни одной линии.
                    visible = visible & self.gateway_online[site.id][window][:, None]
                self.ground_visible[site.id][window] = visible
                self.ground_elevation[site.id][window] = elevation
                self.ground_distance[site.id][window] = site_distance

    @property
    def step_count(self) -> int:
        return int(self.times.size)

    @property
    def satellite_count(self) -> int:
        return len(self.sat_ids)

    def link_counts(self) -> np.ndarray:
        """Число доступных межспутниковых линий на каждом шаге."""
        return self.isl.sum(axis=1).astype(np.int32)

    def active_counts(self) -> np.ndarray:
        """Число активных аппаратов на каждом шаге."""
        return self.active.sum(axis=1).astype(np.int32)
