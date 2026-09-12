"""DTO запросов и ответов.

Сам сценарий принимается сырым ``dict`` и проверяется собственным разборщиком
(``domain.scenario.parse_scenario``): он возвращает полный список проблем с
путями до полей, чего стандартная валидация pydantic не даёт.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from ..domain.routing import Strategy


class RunOptionsIn(BaseModel):
    strategy: Literal["min_hops", "min_latency", "max_margin"] = Strategy.MIN_HOPS.value
    hysteresis: float = Field(default=0.15, ge=0.0, le=1.0)
    backup_limit: int = Field(default=3, ge=1, le=5)
    with_criticality: bool = True


class RunRequest(BaseModel):
    scenario: dict[str, Any]
    options: RunOptionsIn = Field(default_factory=RunOptionsIn)


class ValidateRequest(BaseModel):
    scenario: dict[str, Any]


class VariantCreate(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    scenario: dict[str, Any]
    note: str = Field(default="", max_length=1000)
    options: RunOptionsIn = Field(default_factory=RunOptionsIn)


class CompareRequest(BaseModel):
    """Сравнение двух вариантов: либо по идентификаторам, либо телом запроса."""

    base_variant_id: str | None = None
    other_variant_id: str | None = None
    base_scenario: dict[str, Any] | None = None
    other_scenario: dict[str, Any] | None = None
    options: RunOptionsIn = Field(default_factory=RunOptionsIn)


class MultiCompareRequest(BaseModel):
    """Сопоставление от двух до пяти равноправных сохранённых вариантов."""

    variant_ids: list[str] = Field(min_length=2, max_length=5)
    options: RunOptionsIn = Field(default_factory=RunOptionsIn)


class StrategyCompareRequest(BaseModel):
    scenario: dict[str, Any]
    strategies: list[Literal["min_hops", "min_latency", "max_margin"]] | None = None


class SpofRequest(BaseModel):
    scenario: dict[str, Any]
    satellites: list[str] | None = None


class OptimizeRequest(BaseModel):
    scenario: dict[str, Any]
    max_evaluations: int = Field(default=160, ge=10, le=600)
