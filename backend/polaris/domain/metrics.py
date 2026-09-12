"""Показатели результата по каждому наземному пункту.

Доли равны числу соответствующих отсчётов, делённому на общее число отсчётов.
Максимальный перерыв — самая длинная последовательность отсчётов без пути,
умноженная на ``step_s``. Перерывы, упирающиеся в границу расчётного периода,
помечаются флагом ``truncated``: их истинная длительность неизвестна, поэтому
в выводах они трактуются отдельно.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .routing import CAUSE_LABELS, GapCause, LinkState


@dataclass(slots=True)
class Gap:
    """Непрерывный период без сквозного маршрута."""

    start_s: float
    end_s: float
    duration_s: float
    cause: int
    cause_label: str
    cause_breakdown: dict[str, int]
    truncated_start: bool
    truncated_end: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "start_s": self.start_s,
            "end_s": self.end_s,
            "duration_s": self.duration_s,
            "duration_min": round(self.duration_s / 60.0, 2),
            "cause": GapCause(self.cause).name.lower(),
            "cause_label": self.cause_label,
            "cause_breakdown": self.cause_breakdown,
            "truncated_start": self.truncated_start,
            "truncated_end": self.truncated_end,
        }


@dataclass(slots=True)
class ClientMetrics:
    """Сводка по одному клиентскому пункту."""

    client_id: str
    client_name: str
    step_count: int
    availability_pct: float
    visibility_pct: float
    max_gap_s: float
    max_gap_bounded_s: float
    gap_count: int
    total_gap_s: float
    mean_hops: float | None
    mean_latency_ms: float | None
    mean_margin: float | None
    mean_diversity: float | None
    route_changes: int
    target_pct: float
    target_met: bool
    gaps: list[Gap] = field(default_factory=list)
    cause_totals: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id,
            "client_name": self.client_name,
            "step_count": self.step_count,
            "availability_pct": self.availability_pct,
            "visibility_pct": self.visibility_pct,
            "max_gap_s": self.max_gap_s,
            "max_gap_min": round(self.max_gap_s / 60.0, 2),
            "max_gap_bounded_s": self.max_gap_bounded_s,
            "gap_count": self.gap_count,
            "total_gap_s": self.total_gap_s,
            "mean_hops": self.mean_hops,
            "mean_latency_ms": self.mean_latency_ms,
            "mean_margin": self.mean_margin,
            "mean_diversity": self.mean_diversity,
            "route_changes": self.route_changes,
            "target_pct": self.target_pct,
            "target_met": self.target_met,
            "gap_to_target_pp": round(self.target_pct - self.availability_pct, 2),
            "cause_totals": self.cause_totals,
            "gaps": [gap.as_dict() for gap in self.gaps],
        }


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Границы максимальных серий ``True`` как список ``(начало, конец]``."""
    if mask.size == 0 or not mask.any():
        return []
    padded = np.concatenate(([False], mask, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2])]


def find_gaps(
    state: np.ndarray,
    cause: np.ndarray,
    times: np.ndarray,
    step_s: float,
) -> list[Gap]:
    """Выделить перерывы связи и определить причину каждого."""
    gaps: list[Gap] = []
    total = state.size
    for start, stop in _runs(state != LinkState.ROUTED):
        window = cause[start:stop]
        counts = Counter(int(value) for value in window)
        dominant = max(counts.items(), key=lambda item: (item[1], -item[0]))[0]
        gaps.append(
            Gap(
                start_s=float(times[start]),
                end_s=float(times[stop - 1] + step_s),
                duration_s=float((stop - start) * step_s),
                cause=dominant,
                cause_label=CAUSE_LABELS[GapCause(dominant)],
                cause_breakdown={
                    GapCause(key).name.lower(): value for key, value in sorted(counts.items())
                },
                truncated_start=start == 0,
                truncated_end=stop == total,
            )
        )
    return gaps


def _mean_or_none(values: np.ndarray, mask: np.ndarray, digits: int = 2) -> float | None:
    if not mask.any():
        return None
    return round(float(values[mask].mean()), digits)


def summarize_client(
    *,
    client_id: str,
    client_name: str,
    state: np.ndarray,
    cause: np.ndarray,
    hops: np.ndarray,
    latency_ms: np.ndarray,
    margin: np.ndarray,
    diversity: np.ndarray,
    changed: np.ndarray,
    times: np.ndarray,
    step_s: float,
    target_availability: float,
) -> ClientMetrics:
    """Собрать все показатели по одному пункту."""
    total = int(state.size)
    routed = state == LinkState.ROUTED
    visible = state != LinkState.NO_VISIBILITY

    gaps = find_gaps(state, cause, times, step_s)
    bounded = [gap for gap in gaps if not (gap.truncated_start or gap.truncated_end)]

    cause_totals: dict[str, int] = {}
    for value, count in Counter(int(x) for x in cause[~routed]).items():
        cause_totals[GapCause(value).name.lower()] = count

    availability = round(float(routed.sum()) / total * 100.0, 2) if total else 0.0
    target_pct = round(target_availability * 100.0, 2)

    return ClientMetrics(
        client_id=client_id,
        client_name=client_name,
        step_count=total,
        availability_pct=availability,
        visibility_pct=round(float(visible.sum()) / total * 100.0, 2) if total else 0.0,
        max_gap_s=max((gap.duration_s for gap in gaps), default=0.0),
        max_gap_bounded_s=max((gap.duration_s for gap in bounded), default=0.0),
        gap_count=len(gaps),
        total_gap_s=float((~routed).sum() * step_s),
        mean_hops=_mean_or_none(hops, routed),
        mean_latency_ms=_mean_or_none(latency_ms, routed),
        mean_margin=_mean_or_none(margin, routed, digits=3),
        mean_diversity=_mean_or_none(diversity.astype(np.float64), routed),
        route_changes=int(changed.sum()),
        target_pct=target_pct,
        target_met=availability >= target_pct,
        gaps=gaps,
        cause_totals=cause_totals,
    )
