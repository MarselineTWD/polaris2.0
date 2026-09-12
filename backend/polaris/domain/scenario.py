"""Модель входного сценария ``cosmo-A-1.0`` и его валидация.

Набор правил дословно повторяет ``validate()`` из эталонного модуля
``Расчетный модуль/geometry.py``, но вместо одного ``ValueError`` собирает
**все** проблемы сразу и указывает путь до конкретного поля — этого требует
ТЗ: «при ошибке сервис указывает проблемное поле или объект».
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from .constants import SCENARIO_SCHEMA_VERSION

#: Защитные лимиты сервиса: не даём одним запросом исчерпать память процесса.
MAX_TIME_STEPS = 20_000
MAX_SATELLITES = 2_000
MAX_GROUND_SITES = 500

ENVIRONMENT_KEYS = (
    "altitude_km",
    "inclination_deg",
    "earth_angle0_deg",
    "horizon_s",
    "step_s",
    "min_elevation_deg",
    "isl_range_km",
    "target_availability",
)


@dataclass(frozen=True)
class Issue:
    """Одна проблема валидации, пригодная для показа в интерфейсе."""

    path: str
    message: str
    code: str
    value: Any = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "message": self.message,
            "code": self.code,
            "value": _json_safe(self.value),
        }


class ScenarioValidationError(ValueError):
    """Сценарий не прошёл проверку. Несёт полный список проблем."""

    def __init__(self, issues: Sequence[Issue]) -> None:
        self.issues = list(issues)
        head = self.issues[0].message if self.issues else "Сценарий не прошёл проверку"
        super().__init__(f"{head} (проблем: {len(self.issues)})")

    def as_dict(self) -> dict[str, Any]:
        return {
            "error_code": "scenario_invalid",
            "message": "Сценарий не прошёл проверку",
            "details": [issue.as_dict() for issue in self.issues],
        }


def _json_safe(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    if isinstance(value, float):
        return value
    return str(value)


def _finite(value: Any) -> bool:
    """Число конечно. ``bool`` числом не считается — как в эталонном модуле."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# --------------------------------------------------------------------------- #
# Датаклассы сценария
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Environment:
    altitude_km: float
    inclination_deg: float
    earth_angle0_deg: float
    horizon_s: int
    step_s: int
    min_elevation_deg: float
    isl_range_km: float
    target_availability: float

    @property
    def step_count(self) -> int:
        """Число отсчётов: правый конец горизонта в сетку не входит."""
        return self.horizon_s // self.step_s


@dataclass(frozen=True)
class Plane:
    id: str
    raan_deg: float
    phase_deg: float


@dataclass(frozen=True)
class Satellite:
    id: str
    plane_id: str
    slot_deg: float
    launch_batch: int


@dataclass(frozen=True)
class GroundSite:
    id: str
    name: str
    role: str
    lat_deg: float
    lon_deg: float

    @property
    def is_client(self) -> bool:
        return self.role == "client"

    @property
    def is_gateway(self) -> bool:
        return self.role == "gateway"


@dataclass(frozen=True)
class Outage:
    """Интервал недоступности ``[start_s; end_s)`` — левый конец включён."""

    target_id: str
    start_s: float
    end_s: float


@dataclass(frozen=True)
class Scenario:
    meta: dict[str, Any]
    environment: Environment
    launch_stage: int
    planes: tuple[Plane, ...]
    satellites: tuple[Satellite, ...]
    ground_sites: tuple[GroundSite, ...]
    failures: tuple[Outage, ...]
    gateway_outages: tuple[Outage, ...]
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    # --- производные представления ---------------------------------------- #

    @property
    def satellite_ids(self) -> list[str]:
        return [sat.id for sat in self.satellites]

    @property
    def clients(self) -> list[GroundSite]:
        return [g for g in self.ground_sites if g.is_client]

    @property
    def gateways(self) -> list[GroundSite]:
        return [g for g in self.ground_sites if g.is_gateway]

    def plane_by_id(self, plane_id: str) -> Plane:
        for plane in self.planes:
            if plane.id == plane_id:
                return plane
        raise KeyError(plane_id)

    def to_dict(self) -> dict[str, Any]:
        """Сериализация обратно в схему ``cosmo-A-1.0``.

        Используется для выгрузки ``effective_scenario`` и для content-hash.
        """
        return {
            "schema_version": SCENARIO_SCHEMA_VERSION,
            "meta": dict(self.meta),
            "environment": {
                "altitude_km": self.environment.altitude_km,
                "inclination_deg": self.environment.inclination_deg,
                "earth_angle0_deg": self.environment.earth_angle0_deg,
                "horizon_s": self.environment.horizon_s,
                "step_s": self.environment.step_s,
                "min_elevation_deg": self.environment.min_elevation_deg,
                "isl_range_km": self.environment.isl_range_km,
                "target_availability": self.environment.target_availability,
            },
            "design": {
                "launch_stage": self.launch_stage,
                "planes": [
                    {"id": p.id, "raan_deg": p.raan_deg, "phase_deg": p.phase_deg}
                    for p in self.planes
                ],
                "satellites": [
                    {
                        "id": s.id,
                        "plane_id": s.plane_id,
                        "slot_deg": s.slot_deg,
                        "launch_batch": s.launch_batch,
                    }
                    for s in self.satellites
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
                for g in self.ground_sites
            ],
            "failures": [
                {"satellite_id": f.target_id, "start_s": f.start_s, "end_s": f.end_s}
                for f in self.failures
            ],
            "gateway_outages": [
                {"gateway_id": o.target_id, "start_s": o.start_s, "end_s": o.end_s}
                for o in self.gateway_outages
            ],
        }

    def content_hash(self) -> str:
        """Стабильный хеш содержимого — ключ детерминированного кэша."""
        payload = json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False, allow_nan=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


# --------------------------------------------------------------------------- #
# Разбор и валидация
# --------------------------------------------------------------------------- #


class _Collector:
    """Копит проблемы, чтобы вернуть их пользователю все разом."""

    def __init__(self) -> None:
        self.issues: list[Issue] = []

    def add(self, path: str, message: str, code: str, value: Any = None) -> None:
        self.issues.append(Issue(path=path, message=message, code=code, value=value))

    def require_mapping(self, node: Any, path: str, label: str) -> dict[str, Any] | None:
        if not isinstance(node, dict):
            self.add(path, f"{label} должен быть объектом JSON", "type_object", node)
            return None
        return node

    def require_list(self, node: Any, path: str, label: str) -> list[Any] | None:
        if not isinstance(node, list):
            self.add(path, f"{label} должен быть списком", "type_array", node)
            return None
        return node

    def number(self, node: dict[str, Any], key: str, path: str, label: str) -> float | None:
        if key not in node:
            self.add(f"{path}.{key}", f"Отсутствует обязательное поле «{label}»", "missing")
            return None
        value = node[key]
        if not _finite(value):
            self.add(
                f"{path}.{key}",
                f"«{label}» должно быть конечным числом",
                "not_finite",
                value,
            )
            return None
        return float(value)

    def text(self, node: dict[str, Any], key: str, path: str, label: str) -> str | None:
        value = node.get(key)
        if not isinstance(value, str) or not value.strip():
            self.add(
                f"{path}.{key}",
                f"«{label}» должно быть непустой строкой",
                "not_identifier",
                value,
            )
            return None
        return value


def parse_scenario(raw: Any) -> Scenario:
    """Разобрать и проверить сценарий.

    Поднимает :class:`ScenarioValidationError` со списком всех найденных проблем.
    """
    c = _Collector()
    root = c.require_mapping(raw, "", "Сценарий")
    if root is None:
        raise ScenarioValidationError(c.issues)

    version = root.get("schema_version")
    if version != SCENARIO_SCHEMA_VERSION:
        c.add(
            "schema_version",
            f"Поддерживается только схема «{SCENARIO_SCHEMA_VERSION}»",
            "schema_version",
            version,
        )
        raise ScenarioValidationError(c.issues)

    environment = _parse_environment(root.get("environment"), c)
    planes, declared_plane_ids, satellites, launch_stage = _parse_design(root.get("design"), c)
    ground_sites = _parse_ground_sites(root.get("ground_sites"), c)

    satellite_ids = {s.id for s in satellites}
    gateway_ids = {g.id for g in ground_sites if g.is_gateway}
    horizon = environment.horizon_s if environment else None

    failures = _parse_outages(
        root.get("failures"), "failures", "satellite_id", satellite_ids, horizon, c,
        label="спутник",
    )
    gateway_outages = _parse_outages(
        root.get("gateway_outages"), "gateway_outages", "gateway_id", gateway_ids, horizon, c,
        label="шлюз",
    )

    _check_cross_references(declared_plane_ids, satellites, ground_sites, c)

    if c.issues:
        raise ScenarioValidationError(c.issues)

    assert environment is not None  # доказано отсутствием проблем выше
    meta = root.get("meta") if isinstance(root.get("meta"), dict) else {}
    return Scenario(
        meta=dict(meta),
        environment=environment,
        launch_stage=launch_stage,
        planes=tuple(planes),
        satellites=tuple(satellites),
        ground_sites=tuple(ground_sites),
        failures=tuple(failures),
        gateway_outages=tuple(gateway_outages),
        raw=root,
    )


def _parse_environment(node: Any, c: _Collector) -> Environment | None:
    env = c.require_mapping(node, "environment", "Раздел environment")
    if env is None:
        return None

    values: dict[str, float] = {}
    labels = {
        "altitude_km": "высота орбиты",
        "inclination_deg": "наклонение",
        "earth_angle0_deg": "начальный угол поворота Земли",
        "horizon_s": "продолжительность расчёта",
        "step_s": "шаг расчёта",
        "min_elevation_deg": "минимальный угол возвышения",
        "isl_range_km": "дальность межспутниковой связи",
        "target_availability": "целевая доступность",
    }
    for key in ENVIRONMENT_KEYS:
        parsed = c.number(env, key, "environment", labels[key])
        if parsed is not None:
            values[key] = parsed

    if "altitude_km" in values and not 200 <= values["altitude_km"] <= 1200:
        c.add(
            "environment.altitude_km",
            "Высота круговой орбиты должна быть в пределах 200…1200 км",
            "range",
            values["altitude_km"],
        )
    if "inclination_deg" in values and not 0 < values["inclination_deg"] <= 180:
        c.add(
            "environment.inclination_deg",
            "Наклонение должно быть в пределах (0; 180]°",
            "range",
            values["inclination_deg"],
        )

    # Шаг и горизонт обязаны быть целыми секундами — это отдельное правило ТЗ.
    for key in ("horizon_s", "step_s"):
        value = env.get(key)
        if key in values and not isinstance(value, int):
            c.add(
                f"environment.{key}",
                f"«{labels[key]}» задаётся целым числом секунд",
                "not_integer",
                value,
            )

    horizon = env.get("horizon_s")
    step = env.get("step_s")
    if isinstance(horizon, int) and isinstance(step, int):
        if step <= 0:
            c.add("environment.step_s", "Шаг расчёта должен быть положительным", "range", step)
        elif horizon < step:
            c.add(
                "environment.horizon_s",
                "Продолжительность расчёта не может быть меньше шага",
                "range",
                horizon,
            )
        elif horizon > 172_800:
            c.add(
                "environment.horizon_s",
                "Продолжительность расчёта не должна превышать 172 800 с (двое суток)",
                "range",
                horizon,
            )
        elif horizon % step != 0:
            c.add(
                "environment.horizon_s",
                f"Продолжительность расчёта должна быть кратна шагу ({step} с)",
                "not_multiple",
                horizon,
            )
        elif horizon // step > MAX_TIME_STEPS:
            c.add(
                "environment.step_s",
                f"Слишком мелкий шаг: получается {horizon // step} отсчётов, "
                f"допустимо не более {MAX_TIME_STEPS}",
                "too_many_steps",
                step,
            )

    if "min_elevation_deg" in values and not 0 <= values["min_elevation_deg"] < 90:
        c.add(
            "environment.min_elevation_deg",
            "Минимальный угол возвышения должен быть в пределах [0; 90)°",
            "range",
            values["min_elevation_deg"],
        )
    if "isl_range_km" in values and not 0 < values["isl_range_km"] <= 10_000:
        c.add(
            "environment.isl_range_km",
            "Дальность межспутниковой связи должна быть в пределах (0; 10 000] км",
            "range",
            values["isl_range_km"],
        )
    if "target_availability" in values and not 0 <= values["target_availability"] <= 1:
        c.add(
            "environment.target_availability",
            "Целевая доступность задаётся долей единицы в пределах [0; 1]",
            "range",
            values["target_availability"],
        )

    if len(values) != len(ENVIRONMENT_KEYS) or not (
        isinstance(horizon, int) and isinstance(step, int) and step > 0 and horizon >= step
    ):
        return None

    return Environment(
        altitude_km=values["altitude_km"],
        inclination_deg=values["inclination_deg"],
        earth_angle0_deg=values["earth_angle0_deg"],
        horizon_s=horizon,
        step_s=step,
        min_elevation_deg=values["min_elevation_deg"],
        isl_range_km=values["isl_range_km"],
        target_availability=values["target_availability"],
    )


def _parse_design(
    node: Any, c: _Collector
) -> tuple[list[Plane], set[str], list[Satellite], int]:
    design = c.require_mapping(node, "design", "Раздел design")
    if design is None:
        return [], set(), [], 1

    stage = design.get("launch_stage")
    if not isinstance(stage, int) or isinstance(stage, bool) or stage not in (1, 2, 3):
        c.add(
            "design.launch_stage",
            "Этап развёртывания принимает значения 1, 2 или 3",
            "enum",
            stage,
        )
        stage = 3

    planes, declared_plane_ids = _parse_planes(design.get("planes"), c)
    satellites = _parse_satellites(design.get("satellites"), c)
    return planes, declared_plane_ids, satellites, stage


def _parse_planes(node: Any, c: _Collector) -> tuple[list[Plane], set[str]]:
    """Разобрать плоскости.

    Вторым значением возвращается множество **объявленных** идентификаторов —
    включая плоскости с неверными углами. Оно нужно проверке ссылок: иначе
    одна опечатка в угле превращается в десятки наводных сообщений
    «плоскость не найдена» у всех её аппаратов, и настоящая причина теряется.
    """
    raw_planes = c.require_list(node, "design.planes", "Список орбитальных плоскостей")
    if raw_planes is None:
        return [], set()
    if not raw_planes:
        c.add("design.planes", "Нужна хотя бы одна орбитальная плоскость", "empty")
        return [], set()

    planes: list[Plane] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_planes):
        path = f"design.planes[{index}]"
        node_map = c.require_mapping(item, path, "Плоскость")
        if node_map is None:
            continue
        plane_id = c.text(node_map, "id", path, "идентификатор плоскости")
        if plane_id is None:
            continue
        if plane_id in seen:
            c.add(f"{path}.id", f"Идентификатор плоскости «{plane_id}» не уникален", "duplicate", plane_id)
            continue
        seen.add(plane_id)

        angles: dict[str, float] = {}
        for key, label in (("raan_deg", "RAAN"), ("phase_deg", "фазирование")):
            value = c.number(node_map, key, path, label)
            if value is None:
                continue
            if not 0 <= value < 360:
                c.add(
                    f"{path}.{key}",
                    f"«{label}» задаётся в градусах от 0 включительно до 360 исключительно",
                    "range",
                    value,
                )
                continue
            angles[key] = value
        if len(angles) == 2:
            planes.append(Plane(id=plane_id, raan_deg=angles["raan_deg"], phase_deg=angles["phase_deg"]))
    return planes, seen


def _parse_satellites(node: Any, c: _Collector) -> list[Satellite]:
    raw_sats = c.require_list(node, "design.satellites", "Список спутников")
    if raw_sats is None:
        return []
    if not raw_sats:
        c.add("design.satellites", "Нужен хотя бы один спутник", "empty")
        return []
    if len(raw_sats) > MAX_SATELLITES:
        c.add(
            "design.satellites",
            f"Слишком много аппаратов: {len(raw_sats)}, допустимо не более {MAX_SATELLITES}",
            "too_many",
            len(raw_sats),
        )
        return []

    satellites: list[Satellite] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_sats):
        path = f"design.satellites[{index}]"
        node_map = c.require_mapping(item, path, "Спутник")
        if node_map is None:
            continue
        sat_id = c.text(node_map, "id", path, "идентификатор спутника")
        if sat_id is None:
            continue
        if sat_id in seen:
            c.add(f"{path}.id", f"Идентификатор спутника «{sat_id}» не уникален", "duplicate", sat_id)
            continue
        seen.add(sat_id)

        plane_id = c.text(node_map, "plane_id", path, "ссылка на плоскость")
        slot = c.number(node_map, "slot_deg", path, "положение внутри плоскости")
        batch = node_map.get("launch_batch")
        if not isinstance(batch, int) or isinstance(batch, bool) or batch not in (1, 2, 3):
            c.add(
                f"{path}.launch_batch",
                "Очередь запуска принимает значения 1, 2 или 3",
                "enum",
                batch,
            )
            batch = None
        if plane_id is None or slot is None or batch is None:
            continue
        satellites.append(
            Satellite(id=sat_id, plane_id=plane_id, slot_deg=slot, launch_batch=batch)
        )
    return satellites


def _parse_ground_sites(node: Any, c: _Collector) -> list[GroundSite]:
    raw_sites = c.require_list(node, "ground_sites", "Список наземных пунктов")
    if raw_sites is None:
        return []
    if len(raw_sites) > MAX_GROUND_SITES:
        c.add(
            "ground_sites",
            f"Слишком много наземных пунктов: {len(raw_sites)}, "
            f"допустимо не более {MAX_GROUND_SITES}",
            "too_many",
            len(raw_sites),
        )
        return []

    sites: list[GroundSite] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_sites):
        path = f"ground_sites[{index}]"
        node_map = c.require_mapping(item, path, "Наземный пункт")
        if node_map is None:
            continue
        site_id = c.text(node_map, "id", path, "идентификатор пункта")
        if site_id is None:
            continue
        if site_id in seen:
            c.add(f"{path}.id", f"Идентификатор пункта «{site_id}» не уникален", "duplicate", site_id)
            continue
        seen.add(site_id)

        role = node_map.get("role")
        if role not in ("client", "gateway"):
            c.add(
                f"{path}.role",
                "Роль пункта принимает значение «client» или «gateway»",
                "enum",
                role,
            )
            continue

        lat = c.number(node_map, "lat_deg", path, "широта")
        lon = c.number(node_map, "lon_deg", path, "долгота")
        if lat is not None and not -90 <= lat <= 90:
            c.add(f"{path}.lat_deg", "Широта задаётся в пределах [−90; 90]°", "range", lat)
            lat = None
        if lon is not None and not -180 <= lon <= 180:
            c.add(f"{path}.lon_deg", "Долгота задаётся в пределах [−180; 180]°", "range", lon)
            lon = None
        if lat is None or lon is None:
            continue

        name = node_map.get("name")
        sites.append(
            GroundSite(
                id=site_id,
                name=name if isinstance(name, str) and name.strip() else site_id,
                role=role,
                lat_deg=lat,
                lon_deg=lon,
            )
        )

    if sites:
        if not any(site.is_client for site in sites):
            c.add("ground_sites", "Нужен хотя бы один клиентский пункт (role=client)", "missing_client")
        if not any(site.is_gateway for site in sites):
            c.add("ground_sites", "Нужен хотя бы один шлюз (role=gateway)", "missing_gateway")
    return sites


def _parse_outages(
    node: Any,
    section: str,
    key: str,
    valid_ids: set[str],
    horizon_s: int | None,
    c: _Collector,
    *,
    label: str,
) -> list[Outage]:
    if node is None:
        return []
    raw_items = c.require_list(node, section, f"Список периодов недоступности ({label})")
    if raw_items is None:
        return []

    outages: list[Outage] = []
    for index, item in enumerate(raw_items):
        path = f"{section}[{index}]"
        node_map = c.require_mapping(item, path, "Период недоступности")
        if node_map is None:
            continue
        target = node_map.get(key)
        if not isinstance(target, str) or target not in valid_ids:
            c.add(
                f"{path}.{key}",
                f"Ссылка на {label} «{target}» не разрешается в составе сценария",
                "unknown_reference",
                target,
            )
            continue
        start = c.number(node_map, "start_s", path, "начало интервала")
        end = c.number(node_map, "end_s", path, "конец интервала")
        if start is None or end is None:
            continue
        if start < 0:
            c.add(f"{path}.start_s", "Начало интервала не может быть отрицательным", "range", start)
            continue
        if end <= start:
            c.add(
                f"{path}.end_s",
                "Конец интервала должен быть строго больше начала",
                "range",
                end,
            )
            continue
        if horizon_s is not None and end > horizon_s:
            c.add(
                f"{path}.end_s",
                f"Интервал должен полностью помещаться в период расчёта (0…{horizon_s} с)",
                "range",
                end,
            )
            continue
        outages.append(Outage(target_id=target, start_s=start, end_s=end))
    return outages


def _check_cross_references(
    plane_ids: set[str],
    satellites: Iterable[Satellite],
    ground_sites: Iterable[GroundSite],
    c: _Collector,
) -> None:
    satellite_ids: set[str] = set()
    for index, sat in enumerate(satellites):
        satellite_ids.add(sat.id)
        if sat.plane_id not in plane_ids:
            c.add(
                f"design.satellites[{index}].plane_id",
                f"Плоскость «{sat.plane_id}» не найдена в списке design.planes",
                "unknown_reference",
                sat.plane_id,
            )
    for index, site in enumerate(ground_sites):
        if site.id in satellite_ids:
            c.add(
                f"ground_sites[{index}].id",
                f"Идентификатор «{site.id}» уже используется спутником — "
                "идентификаторы узлов должны различаться",
                "duplicate",
                site.id,
            )
