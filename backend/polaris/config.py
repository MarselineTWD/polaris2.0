"""Настройки сервиса. Значения берутся из переменных окружения."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BASE_DIR.parent


def _path(name: str, default: Path) -> Path:
    value = os.getenv(name)
    return Path(value).expanduser().resolve() if value else default


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    data_dir: Path = _path("POLARIS_DATA_DIR", PROJECT_DIR / "Данные")
    frontend_dir: Path = _path("POLARIS_FRONTEND_DIR", PROJECT_DIR / "frontend")
    state_dir: Path = _path("POLARIS_STATE_DIR", BASE_DIR / ".state")
    run_cache_size: int = _int("POLARIS_RUN_CACHE", 24)
    max_upload_bytes: int = _int("POLARIS_MAX_UPLOAD", 8 * 1024 * 1024)
    optimizer_workers: int = _int("POLARIS_OPTIMIZER_WORKERS", max(1, (os.cpu_count() or 2) - 1))

    @property
    def database_path(self) -> Path:
        return self.state_dir / "polaris.sqlite3"


settings = Settings()
settings.state_dir.mkdir(parents=True, exist_ok=True)
