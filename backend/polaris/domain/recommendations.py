"""Выводы и рекомендации, выведенные из посчитанных величин.

Каждая рекомендация несёт поле ``evidence`` — те самые числа, из которых она
получена. Это принципиально: ТЗ оценивает «связь рекомендаций с выполненными
расчётами», поэтому текст без подтверждающих значений здесь не появляется.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .engine import RunResult
from .routing import CAUSE_LABELS, GapCause

def num(value: float, digits: int = 2) -> str:
    """Число с русским десятичным разделителем — как во всём интерфейсе."""
    return f"{value:.{digits}f}".replace(".", ",")


CRITICAL = "critical"
WARNING = "warning"
INFO = "info"

_STAGE_CAPACITY = {1: "до 16 аппаратов", 2: "до 32 аппаратов", 3: "все 48"}


def _entry(
    severity: str, title: str, detail: str, evidence: dict[str, Any]
) -> dict[str, Any]:
    return {"severity": severity, "title": title, "detail": detail, "evidence": evidence}


def build_recommendations(result: RunResult) -> list[dict[str, Any]]:
    """Собрать список рекомендаций по результату расчёта."""
    scenario = result.scenario
    metrics = result.metrics
    if not metrics:
        return []

    items: list[dict[str, Any]] = []
    target = scenario.environment.target_availability * 100.0
    failing = sorted(
        (m for m in metrics if not m.target_met), key=lambda m: m.availability_pct
    )

    items.append(_target_verdict(metrics, failing, target))
    items.extend(_cause_advice(result))
    items.extend(_isl_advice(result))
    items.extend(_resilience_advice(result))
    items.extend(_deployment_advice(result))
    return items


def _target_verdict(metrics, failing, target: float) -> dict[str, Any]:
    best = max(metrics, key=lambda m: m.availability_pct)
    worst = min(metrics, key=lambda m: m.availability_pct)
    if not failing:
        return _entry(
            INFO,
            f"Целевой уровень {num(target, 0)}% достигнут для всех пунктов",
            f"Минимальная доступность — {num(worst.availability_pct)}% у {worst.client_id}, "
            f"запас {num(worst.availability_pct - target)} п.п. "
            f"Максимальный перерыв по группе — {num(worst.max_gap_s / 60, 0)} мин.",
            {
                "min_availability_pct": worst.availability_pct,
                "max_availability_pct": best.availability_pct,
                "target_pct": target,
                "limiting_client": worst.client_id,
            },
        )
    names = ", ".join(f"{m.client_id} ({num(m.availability_pct)}%)" for m in failing)
    return _entry(
        CRITICAL,
        f"Целевой уровень {num(target, 0)}% не достигнут для {len(failing)} из {len(metrics)} пунктов",
        f"Ниже цели: {names}. Лимитирующий пункт — {failing[0].client_id}, "
        f"разрыв {num(target - failing[0].availability_pct)} п.п., "
        f"максимальный перерыв {num(failing[0].max_gap_s / 60, 0)} мин "
        f"({failing[0].gap_count} перерывов за период).",
        {
            "failing_clients": [m.client_id for m in failing],
            "limiting_client": failing[0].client_id,
            "gap_pp": round(target - failing[0].availability_pct, 2),
            "target_pct": target,
        },
    )


def _cause_advice(result: RunResult) -> list[dict[str, Any]]:
    """Разобрать доминирующую причину перерывов по всей группе пунктов."""
    totals: dict[str, int] = {}
    for metric in result.metrics:
        for cause, count in metric.cause_totals.items():
            totals[cause] = totals.get(cause, 0) + count
    totals.pop(GapCause.NONE.name.lower(), None)
    if not totals:
        return []

    total = sum(totals.values())
    cause, count = max(totals.items(), key=lambda item: item[1])
    share = count / total * 100.0
    label = CAUSE_LABELS[GapCause[cause.upper()]]

    advice = {
        "no_visible_satellite": (
            "Над пунктами не хватает аппаратов. Помогает не дальность связи, "
            "а состав группировки: следующая очередь запуска либо перераспределение "
            "RAAN плоскостей в сторону обслуживаемых долгот."
        ),
        "isl_network_split": (
            "Покрытие есть, но межспутниковая сеть распадается на несвязные части. "
            "Это лечится дальностью ISL или сближением фазирования соседних плоскостей."
        ),
        "no_gateway_contact": (
            "Над шлюзом нет активного аппарата — узкое место на выходе из спутниковой сети. "
            "Второй шлюз в другой долготе снимает ограничение."
        ),
        "gateway_unavailable": (
            "Перерывы вызваны заданной недоступностью самого шлюза, "
            "а не геометрией группировки."
        ),
    }.get(cause, "")

    return [
        _entry(
            WARNING,
            f"Основная причина перерывов — {label} ({num(share, 0)}% отсчётов без маршрута)",
            advice,
            {"cause": cause, "share_pct": round(share, 2), "steps": count, "breakdown": totals},
        )
    ]


def _isl_advice(result: RunResult) -> list[dict[str, Any]]:
    """Насколько нужно поднять дальность ISL, чтобы убрать разрывы сети."""
    required = np.concatenate(
        [timeline.required_range_km for timeline in result.timelines.values()]
    )
    required = required[np.isfinite(required)]
    if required.size == 0:
        return []

    current = result.scenario.environment.isl_range_km
    p90 = float(np.percentile(required, 90))
    median = float(np.median(required))
    covered = float((required <= p90).mean() * 100.0)
    if p90 <= current:
        return []

    return [
        _entry(
            WARNING,
            f"Дальность ISL {num(current, 0)} км — узкое место связности",
            f"В отсчётах с разрывом сети ближайшая недостающая линия требует "
            f"в медиане {num(median, 0)} км, в 90% случаев — до {num(p90, 0)} км. "
            f"Увеличение предельной дальности до {num(p90, 0)} км устранило бы "
            f"{num(covered, 0)}% разрывов этого типа "
            f"(прирост {num(p90 - current, 0)} км к текущему значению).",
            {
                "current_isl_range_km": current,
                "median_required_km": round(median, 1),
                "p90_required_km": round(p90, 1),
                "delta_km": round(p90 - current, 1),
                "split_steps": int(required.size),
            },
        )
    ]


def _resilience_advice(result: RunResult) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    ranking = result.criticality.ranking(result.scenario.satellite_ids, limit=5)
    if ranking and ranking[0]["critical_steps"] > 0:
        head = ranking[0]
        listed = ", ".join(
            f"{row['satellite_id']} ({num(row['critical_share_pct'], 1)}%)" for row in ranking[:3]
        )
        items.append(
            _entry(
                WARNING if head["critical_share_pct"] < 10 else CRITICAL,
                "Найдены аппараты, на которых сеть держится без резерва",
                f"Наиболее уязвимы: {listed}. Указана доля отсчётов с маршрутом, "
                f"в которых отказ этого аппарата немедленно разорвал бы связь. "
                f"Для {head['satellite_id']} это затрагивает пункты: "
                f"{', '.join(head['affected_clients'])}.",
                {"top": ranking},
            )
        )

    diversities = [
        metric.mean_diversity for metric in result.metrics if metric.mean_diversity is not None
    ]
    if diversities:
        mean_diversity = sum(diversities) / len(diversities)
        if mean_diversity < 1.5:
            items.append(
                _entry(
                    WARNING,
                    f"Слабое резервирование маршрутов: в среднем {num(mean_diversity)} независимых пути",
                    "Большую часть времени существует единственный маршрут до шлюза — "
                    "любой отказ на нём сразу приводит к перерыву. "
                    "Резерв растёт от плотности межплоскостных связей.",
                    {"mean_path_diversity": round(mean_diversity, 2)},
                )
            )
    return items


def _deployment_advice(result: RunResult) -> list[dict[str, Any]]:
    scenario = result.scenario
    stage = scenario.launch_stage
    active = sum(1 for sat in scenario.satellites if sat.launch_batch <= stage)
    if stage >= 3:
        return []
    return [
        _entry(
            INFO,
            f"Расчёт выполнен на этапе развёртывания {stage} — {_STAGE_CAPACITY.get(stage, '')}",
            f"В расчёте участвует {active} из {len(scenario.satellites)} аппаратов. "
            f"Показатели промежуточного этапа нельзя сравнивать с целевыми напрямую: "
            f"для проверки достижимости цели нужен расчёт на полной группировке.",
            {
                "launch_stage": stage,
                "active_satellites": active,
                "total_satellites": len(scenario.satellites),
            },
        )
    ]
