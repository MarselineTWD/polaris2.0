"""Последовательная очередь фоновых задач для малоресурсного сервера."""

from __future__ import annotations

import threading
import time

import pytest

from polaris.api.jobs import JobRegistry


def _wait_status(job, expected: str) -> None:
    for _ in range(100):
        if job.status == expected:
            return
        time.sleep(0.01)
    assert job.status == expected


def test_second_job_waits_and_starts_after_first() -> None:
    registry = JobRegistry(max_concurrent=1, max_queued=2)
    release = threading.Event()
    first = registry.submit("first", lambda _: (release.wait(), {"value": 1})[1])
    second = registry.submit("second", lambda _: {"value": 2})

    assert first.status == "running"
    assert second.status == "queued"
    assert registry.get(second.id).as_dict()["queue_position"] == 1

    release.set()
    _wait_status(first, "done")
    _wait_status(second, "done")
    assert second.result == {"value": 2}


def test_queued_job_can_be_cancelled_and_queue_is_bounded() -> None:
    registry = JobRegistry(max_concurrent=1, max_queued=1)
    release = threading.Event()
    first = registry.submit("first", lambda _: (release.wait(), {})[1])
    queued = registry.submit("queued", lambda _: {})

    with pytest.raises(RuntimeError, match="Очередь"):
        registry.submit("overflow", lambda _: {})

    cancelled = registry.cancel(queued.id)
    assert cancelled is not None
    assert cancelled.status == "cancelled"
    assert cancelled.queue_position is None

    release.set()
    _wait_status(first, "done")
