"""Общие фикстуры: доступ к данным задания и к эталонному расчётному модулю."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_DIR / "Данные"
REFERENCE_DIR = PROJECT_DIR / "Расчетный модуль"

# Эталонный модуль организаторов подключается как есть — тест паритета
# сверяет наш расчёт именно с ним.
if str(REFERENCE_DIR) not in sys.path:
    sys.path.insert(0, str(REFERENCE_DIR))

SCENARIO_IDS = [
    "01_full_constellation",
    "02_first_launch",
    "03_satellite_outages",
    "04_link_range",
]


def load_raw(scenario_id: str) -> dict:
    return json.loads((DATA_DIR / f"{scenario_id}.json").read_text(encoding="utf-8"))


@pytest.fixture(params=SCENARIO_IDS)
def scenario_id(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture
def raw_scenario(scenario_id: str) -> dict:
    return load_raw(scenario_id)


@pytest.fixture
def full_raw() -> dict:
    return load_raw("01_full_constellation")
