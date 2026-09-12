"""Единый реестр отменяемых фоновых задач приложения.

Через него выполняются оптимизация, свип точек отказа, обновление внешних
снимков и инженерная верификация. Реестр живёт в памяти процесса, а готовые
инженерные результаты отдельно сохраняются на диск.
"""

from __future__ import annotations

import threading
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


class JobCancelled(Exception):
    """Фоновая задача остановлена по запросу пользователя."""


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    progress: float = 0.0
    done: int = 0
    total: int = 0
    queue_position: int | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    started_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    finished_at: str | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 3),
            "done": self.done,
            "total": self.total,
            "queue_position": self.queue_position,
            "result": self.result,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "cancel_requested": self.cancel_event.is_set(),
        }


class JobRegistry:
    """Реестр задач с ограничением на число одновременно выполняемых."""

    def __init__(
        self, max_concurrent: int = 1, max_queued: int = 3, keep: int = 32
    ) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._pending: list[tuple[Job, Callable[[Job], dict[str, Any]]]] = []
        self._lock = threading.Lock()
        self._running = 0
        self._max_concurrent = max(1, max_concurrent)
        self._max_queued = max(0, max_queued)
        self._keep = keep

    def submit(self, kind: str, work: Callable[[Job], dict[str, Any]]) -> Job:
        with self._lock:
            if self._running >= self._max_concurrent and len(self._pending) >= self._max_queued:
                raise RuntimeError(
                    "Очередь фоновых расчётов заполнена. Дождитесь завершения текущего."
                )
            job = Job(id=f"job_{uuid.uuid4().hex[:12]}", kind=kind)
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._evict()
            if self._running < self._max_concurrent:
                self._launch_locked(job, work)
            else:
                self._pending.append((job, work))
                job.queue_position = len(self._pending)
            return job

    def _launch_locked(self, job: Job, work: Callable[[Job], dict[str, Any]]) -> None:
        """Запустить задачу; вызывается только при удерживаемом ``_lock``."""
        self._running += 1
        job.status = "running"
        job.queue_position = None

        def runner() -> None:
            try:
                job.result = work(job)
                if job.cancel_event.is_set():
                    raise JobCancelled()
                job.status = "done"
                job.progress = 1.0
            except JobCancelled:
                job.status = "cancelled"
                job.result = None
                job.error = None
            except Exception as error:  # noqa: BLE001 - задача не должна ронять процесс
                job.status = "failed"
                job.error = str(error) or error.__class__.__name__
                traceback.print_exc()
            finally:
                job.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
                with self._lock:
                    self._running -= 1
                    self._launch_next_locked()

        threading.Thread(target=runner, name=f"polaris-{job.kind}", daemon=True).start()

    def _launch_next_locked(self) -> None:
        while self._pending and self._running < self._max_concurrent:
            job, work = self._pending.pop(0)
            if job.status == "cancelled":
                continue
            self._launch_locked(job, work)
        self._refresh_queue_positions_locked()

    def _refresh_queue_positions_locked(self) -> None:
        for index, (job, _) in enumerate(self._pending, 1):
            job.queue_position = index

    def get(self, job_id: str) -> Job | None:
        job = self._jobs.get(job_id)
        if job is not None and job.status == "queued":
            with self._lock:
                job.queue_position = next(
                    (index for index, (queued, _) in enumerate(self._pending, 1) if queued.id == job_id),
                    None,
                )
        return job

    def list(self) -> list[Job]:
        with self._lock:
            return [self._jobs[key] for key in reversed(self._order) if key in self._jobs]

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is None:
            return None
        if job.status == "queued":
            with self._lock:
                self._pending = [(item, work) for item, work in self._pending if item.id != job_id]
                self._refresh_queue_positions_locked()
                job.cancel_event.set()
                job.status = "cancelled"
                job.queue_position = None
                job.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            return job
        if job.status in {"running", "cancelling"}:
            job.cancel_event.set()
            job.status = "cancelling"
        return job

    def _evict(self) -> None:
        while len(self._order) > self._keep:
            oldest = self._order.pop(0)
            job = self._jobs.get(oldest)
            if job is not None and job.status in {"queued", "running", "cancelling"}:
                self._order.append(oldest)  # выполняющиеся не вытесняем
                return
            self._jobs.pop(oldest, None)


def progress_reporter(job: Job) -> Callable[[int, int], None]:
    def report(done: int, total: int) -> None:
        if job.cancel_event.is_set():
            raise JobCancelled()
        job.done = done
        job.total = total
        job.progress = done / total if total else 0.0

    return report
