"""Инженерная верификация группировки.

Модуль намеренно отделён от эталонного быстрого расчёта.  Никакой импорт из
этого пакета не меняет формулы ``domain.ephemeris``/``domain.visibility`` —
это позволяет сохранять битовый паритет с расчётным модулем задания.
"""

from .engine import ResearchOptions, run_research
from .profiles import profile_catalog

__all__ = ["ResearchOptions", "profile_catalog", "run_research"]
