"""Управляемые пользователем снимки внешних инженерных данных.

Сервис никогда не обращается в сеть во время обычного или инженерного
расчёта.  Обновление выполняется только через ``refresh``; расчёт затем читает
зафиксированные JSON-снимки.  Это делает результат воспроизводимым и оставляет
приложение работоспособным без интернета.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from ..domain.scenario import Scenario

FetchJson = Callable[[str], Any]

SOURCE_INFO: dict[str, dict[str, Any]] = {
    "weather": {"label": "Open-Meteo Weather", "ttl_s": 3600, "kind": "observed"},
    "elevation": {"label": "Open-Meteo Elevation", "ttl_s": None, "kind": "observed"},
    "space_weather": {"label": "NOAA SWPC", "ttl_s": 900, "kind": "observed"},
    "celestrak": {"label": "CelesTrak GP/OMM", "ttl_s": 21600, "kind": "observed"},
    "satnogs": {"label": "SatNOGS DB", "ttl_s": 86400, "kind": "observed"},
    "itur": {"label": "ITU-Rpy", "ttl_s": None, "kind": "model"},
    "satkit": {"label": "SatKit data", "ttl_s": None, "kind": "model"},
    "space_track": {"label": "Space-Track CDM", "ttl_s": None, "kind": "restricted"},
    "discos": {"label": "ESA DISCOS", "ttl_s": None, "kind": "restricted"},
}

REFRESHABLE = ("weather", "elevation", "space_weather", "celestrak", "satnogs")


def utc_now_hour() -> datetime:
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


class ExternalDataService:
    """Загружает, проверяет и атомарно сохраняет снимки поставщиков."""

    def __init__(self, directory: Path, fetch_json: FetchJson | None = None) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self._fetch_json = fetch_json or self._download_json
        self._lock = threading.RLock()
        self._last_errors: dict[str, str] = {}

    @staticmethod
    def _download_json(url: str) -> Any:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "POLARIS-research/1.0 (+local engineering verification)",
            },
        )
        with urllib.request.urlopen(request, timeout=18) as response:  # noqa: S310 - фиксированные HTTPS URL
            if getattr(response, "status", 200) >= 400:
                raise RuntimeError(f"HTTP {response.status}")
            return json.loads(response.read().decode("utf-8-sig"))

    def _path(self, source: str) -> Path:
        return self.directory / f"{source}.json"

    def _load(self, source: str) -> dict[str, Any] | None:
        path = self._path(source)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            content = json.dumps(payload.get("data"), ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":")).encode("utf-8")
            if hashlib.sha256(content).hexdigest() != payload.get("sha256"):
                self._last_errors[source] = "контрольная сумма снимка не совпала"
                return None
            return payload
        except (OSError, ValueError, TypeError) as error:
            self._last_errors[source] = f"снимок повреждён: {error}"
            return None

    def _save(self, source: str, data: Any, *, context: dict[str, Any] | None = None) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        ttl = SOURCE_INFO[source]["ttl_s"]
        encoded = json.dumps(data, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":")).encode("utf-8")
        envelope = {
            "source": source,
            "provider": SOURCE_INFO[source]["label"],
            "retrieved_at": iso(now),
            "valid_until": iso(now + timedelta(seconds=ttl)) if ttl else None,
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "context": context or {},
            "data": data,
        }
        path = self._path(source)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
        self._last_errors.pop(source, None)
        return envelope

    def status(self) -> dict[str, Any]:
        """Состояние всех источников без сетевых обращений."""
        now = datetime.now(timezone.utc)
        sources: list[dict[str, Any]] = []
        for source, info in SOURCE_INFO.items():
            if info["kind"] == "restricted":
                sources.append({
                    "id": source,
                    "label": info["label"],
                    "kind": info["kind"],
                    "status": "requires_auth",
                    "origin": "not_connected",
                    "retrieved_at": None,
                    "valid_until": None,
                    "sha256": None,
                    "detail": "Необязательный источник: требуется отдельная учётная запись",
                })
                continue
            if source in {"itur", "satkit"}:
                package = "itur" if source == "itur" else "satkit"
                installed = importlib.util.find_spec(package) is not None
                detail = (
                    "Библиотека доступна локально; интернет для расчёта не нужен"
                    if installed
                    else "Используется встроенное приближение; библиотека не установлена"
                )
                if source == "satkit" and installed:
                    try:
                        import satkit as sk

                        data_dir = os.getenv("POLARIS_SATKIT_DATA_DIR")
                        if data_dir:
                            sk.utils.set_datadir(data_dir)
                        installed = bool(sk.utils.datafiles_exist())
                        detail = (
                            "EOP, гравитация и эфемериды доступны локально"
                            if installed
                            else "Библиотека установлена, но полный комплект данных отсутствует"
                        )
                    except Exception as error:  # noqa: BLE001 - статус обязан работать офлайн
                        installed = False
                        detail = f"Не удалось проверить комплект SatKit: {_clean_error(error)}"
                sources.append({
                    "id": source,
                    "label": info["label"],
                    "kind": info["kind"],
                    "status": "ready" if installed else "fallback",
                    "origin": "built_in" if installed else "approximation",
                    "retrieved_at": None,
                    "valid_until": None,
                    "sha256": None,
                    "detail": detail,
                })
                continue
            snapshot = self._load(source)
            if snapshot is None:
                sources.append({
                    "id": source,
                    "label": info["label"],
                    "kind": info["kind"],
                    "status": "fallback",
                    "origin": "default",
                    "retrieved_at": None,
                    "valid_until": None,
                    "sha256": None,
                    "detail": self._last_errors.get(source, "Снимок ещё не загружен"),
                })
                continue
            valid_until = parse_iso(snapshot.get("valid_until"))
            stale = bool(valid_until and valid_until < now)
            data = snapshot.get("data")
            not_applicable = isinstance(data, dict) and data.get("applicable") is False
            sources.append({
                "id": source,
                "label": info["label"],
                "kind": info["kind"],
                "status": "not_applicable" if not_applicable else ("stale" if stale else "ready"),
                "origin": "snapshot",
                "retrieved_at": snapshot.get("retrieved_at"),
                "valid_until": snapshot.get("valid_until"),
                "sha256": snapshot.get("sha256"),
                "detail": (
                    data.get("reason", "Не применяется к этому сценарию")
                    if not_applicable
                    else self._last_errors.get(source, "Зафиксированный воспроизводимый снимок")
                ),
                "records": _record_count(data),
                "context": snapshot.get("context", {}),
            })
        return {"sources": sources, "offline_safe": True, "refresh_policy": "manual"}

    def refresh(
        self,
        scenario: Scenario,
        sources: Iterable[str] | None = None,
        progress: Callable[[int, int], None] | None = None,
    ) -> dict[str, Any]:
        """Обновить выбранные снимки. Ошибка одного провайдера не отменяет остальные."""
        selected = [item for item in (sources or REFRESHABLE) if item in REFRESHABLE]
        completed: list[dict[str, Any]] = []
        for index, source in enumerate(selected, 1):
            try:
                data = getattr(self, f"_refresh_{source}")(scenario)
                snapshot = self._save(
                    source,
                    data,
                    context={
                        "scenario_hash": scenario.content_hash(),
                        "sites": [site.id for site in scenario.ground_sites],
                    },
                )
                completed.append({"id": source, "ok": True, "sha256": snapshot["sha256"]})
            except Exception as error:  # noqa: BLE001 - частичный результат важнее падения refresh
                message = _clean_error(error)
                self._last_errors[source] = message
                completed.append({
                    "id": source,
                    "ok": False,
                    "cached": self._load(source) is not None,
                    "error": message,
                })
            if progress:
                progress(index, len(selected))
        return {"updated": completed, **self.status()}

    def data_for_run(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Вернуть данные снимков и их паспорт для фиксации в результате."""
        data: dict[str, Any] = {}
        passports: list[dict[str, Any]] = []
        statuses = {item["id"]: item for item in self.status()["sources"]}
        for source in SOURCE_INFO:
            snapshot = self._load(source) if source in REFRESHABLE else None
            data[source] = snapshot.get("data") if snapshot else _fallback(source)
            passports.append(statuses[source])
        return data, passports

    def _refresh_elevation(self, scenario: Scenario) -> dict[str, Any]:
        sites = list(scenario.ground_sites)
        query = urllib.parse.urlencode({
            "latitude": ",".join(str(site.lat_deg) for site in sites),
            "longitude": ",".join(str(site.lon_deg) for site in sites),
        })
        payload = self._fetch_json(f"https://api.open-meteo.com/v1/elevation?{query}")
        elevations = payload.get("elevation", []) if isinstance(payload, dict) else []
        if not isinstance(elevations, list):
            elevations = [elevations]
        if len(elevations) != len(sites):
            raise RuntimeError("Open-Meteo вернул неполный список высот")
        return {
            "resolution_m": 90,
            "sites": {
                site.id: {"elevation_m": float(value), "lat_deg": site.lat_deg, "lon_deg": site.lon_deg}
                for site, value in zip(sites, elevations)
            },
        }

    def _refresh_weather(self, scenario: Scenario) -> dict[str, Any]:
        hourly = (
            "temperature_2m,relative_humidity_2m,precipitation,rain,snowfall,"
            "surface_pressure,cloud_cover,visibility"
        )
        days = min(16, max(2, math.ceil(scenario.environment.horizon_s / 86400) + 1))
        result: dict[str, Any] = {"timezone": "UTC", "sites": {}}
        for site in scenario.ground_sites:
            query = urllib.parse.urlencode({
                "latitude": site.lat_deg,
                "longitude": site.lon_deg,
                "hourly": hourly,
                "forecast_days": days,
                "timezone": "UTC",
            })
            payload = self._fetch_json(f"https://api.open-meteo.com/v1/forecast?{query}")
            if not isinstance(payload, dict) or not isinstance(payload.get("hourly"), dict):
                raise RuntimeError(f"нет почасовой погоды для {site.id}")
            result["sites"][site.id] = {
                "lat_deg": site.lat_deg,
                "lon_deg": site.lon_deg,
                "elevation_m": payload.get("elevation"),
                "hourly": payload["hourly"],
                "units": payload.get("hourly_units", {}),
            }
        return result

    def _refresh_space_weather(self, _: Scenario) -> dict[str, Any]:
        kp = self._fetch_json("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json")
        flux = self._fetch_json("https://services.swpc.noaa.gov/json/f107_cm_flux.json")
        return {
            "kp": kp,
            "f107": flux,
            "kp_value": _latest_tabular_number(kp, ("kp", "estimated_kp"), 2.0),
            "ap_value": _latest_tabular_number(kp, ("ap", "estimated_ap"), 7.0),
            "f107_value": _latest_tabular_number(flux, ("flux", "f10.7", "f107"), 120.0),
        }

    def _refresh_celestrak(self, _: Scenario) -> dict[str, Any]:
        groups = ("active", "iridium-33-debris", "cosmos-2251-debris")
        objects: list[dict[str, Any]] = []
        errors: list[str] = []
        for group in groups:
            try:
                payload = self._fetch_json(
                    f"https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
                )
                if isinstance(payload, list):
                    objects.extend({**item, "_group": group} for item in payload if isinstance(item, dict))
            except Exception as error:  # noqa: BLE001 - оставшиеся группы всё ещё полезны
                errors.append(f"{group}: {_clean_error(error)}")
        if not objects:
            raise RuntimeError("каталог не получен" + (f" ({'; '.join(errors)})" if errors else ""))
        # Один NORAD ID может попасть в несколько тематических групп.
        unique: dict[str, dict[str, Any]] = {}
        for item in objects:
            key = str(item.get("NORAD_CAT_ID") or item.get("OBJECT_ID") or len(unique))
            unique[key] = item
        return {"format": "OMM/JSON", "groups": list(groups), "objects": list(unique.values()),
                "partial_errors": errors}

    def _refresh_satnogs(self, scenario: Scenario) -> dict[str, Any]:
        raw_satellites = scenario.raw.get("design", {}).get("satellites", [])
        norad_ids = sorted({
            int(item["norad_id"])
            for item in raw_satellites
            if isinstance(item, dict) and str(item.get("norad_id", "")).isdigit()
        })
        if not norad_ids:
            return {
                "applicable": False,
                "reason": "У синтетических аппаратов S01…S48 нет NORAD ID; используются модельные профили",
                "transmitters": [],
            }
        transmitters: list[dict[str, Any]] = []
        for norad_id in norad_ids:
            query = urllib.parse.urlencode({"satellite__norad_cat_id": norad_id, "format": "json"})
            payload = self._fetch_json(f"https://db.satnogs.org/api/transmitters/?{query}")
            rows = payload.get("results", []) if isinstance(payload, dict) else payload
            if isinstance(rows, list):
                transmitters.extend(row for row in rows if isinstance(row, dict))
        return {"applicable": True, "norad_ids": norad_ids, "transmitters": transmitters}


def _record_count(data: Any) -> int | None:
    if isinstance(data, list):
        return len(data)
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("objects"), list):
        return len(data["objects"])
    if isinstance(data.get("sites"), dict):
        return len(data["sites"])
    if isinstance(data.get("transmitters"), list):
        return len(data["transmitters"])
    return None


def _fallback(source: str) -> Any:
    if source == "weather":
        return {"fallback": True, "sites": {}, "assumption": "стандартная сухая атмосфера"}
    if source == "elevation":
        return {"fallback": True, "sites": {}, "assumption": "высота 0 м"}
    if source == "space_weather":
        return {"fallback": True, "kp_value": 2.0, "ap_value": 7.0, "f107_value": 120.0}
    if source == "celestrak":
        return {"fallback": True, "objects": []}
    if source == "satnogs":
        return {"fallback": True, "applicable": False, "transmitters": []}
    return {"built_in": True}


def _clean_error(error: Exception) -> str:
    text = str(error).replace("\r", " ").replace("\n", " ").strip()
    return (text or error.__class__.__name__)[:240]


def _latest_tabular_number(payload: Any, keys: tuple[str, ...], default: float) -> float:
    """Извлечь последнее числовое значение из JSON NOAA (dict или header+rows)."""
    wanted = {key.lower() for key in keys}
    if isinstance(payload, list) and payload and isinstance(payload[0], list):
        header = [str(item).lower() for item in payload[0]]
        columns = [index for index, item in enumerate(header) if item in wanted]
        for row in reversed(payload[1:]):
            for index in columns:
                try:
                    return float(row[index])
                except (IndexError, TypeError, ValueError):
                    continue
    if isinstance(payload, list):
        for row in reversed(payload):
            value = _latest_tabular_number(row, keys, math.nan)
            if math.isfinite(value):
                return value
    if isinstance(payload, dict):
        for key, value in payload.items():
            if str(key).lower() in wanted:
                try:
                    return float(value)
                except (TypeError, ValueError):
                    continue
        for value in reversed(list(payload.values())):
            found = _latest_tabular_number(value, keys, math.nan)
            if math.isfinite(found):
                return found
    return default
