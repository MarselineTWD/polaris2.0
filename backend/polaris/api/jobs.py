"""Фоновые задачи: свип точек отказа и подбор конфигурации.

Всё остальное в сервисе считается синхронно за десятки миллисекунд, поэтому
очередь нужна ровно для двух длительных операций. Реестр живёт в памяти
процесса: задачи короткие, и переживать перезапуск им не требуется.
"""

from __future__ import annotations

import threading
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


@dataclass
class Job:
    id: str
    kind: str
    status: str = "running"
    progress: float = 0.0
    done: int = 0
    total: int = 0
    result: dict[str, Any] | None = None
    error: str | None = None
    started_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    finished_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 3),
            "done": self.done,
            "total": self.total,
            "result": self.result,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class JobRegistry:
    """Реестр задач с ограничением на число одновременно выполняемых."""

    def __init__(self, max_concurrent: int = 2, keep: int = 32) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._running = 0
        self._max_concurrent = max_concurrent
        self._keep = keep

    def submit(self, kind: str, work: Callable[[Job], dict[str, Any]]) -> Job:
        with self._lock:
            if self._running >= self._max_concurrent:
                raise RuntimeError(
                    "Уже выполняется максимальное число фоновых расчётов. "
                    "Дождитесь завершения текущего."
                )
            self._running += 1
            job = Job(id=f"job_{uuid.uuid4().hex[:12]}", kind=kind)
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._evict()

        def runner() -> None:
            try:
                job.result = work(job)
                job.status = "done"
                job.progress = 1.0
            except Exception as error:  # noqa: BLE001 - задача не должна ронять процесс
                job.status = "failed"
                job.error = str(error) or error.__class__.__name__
                traceback.print_exc()
            finally:
                job.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
                with self._lock:
                    self._running -= 1

        threading.Thread(target=runner, name=f"polaris-{kind}", daemon=True).start()
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return [self._jobs[key] for key in reversed(self._order) if key in self._jobs]

    def _evict(self) -> None:
        while len(self._order) > self._keep:
            oldest = self._order.pop(0)
            job = self._jobs.get(oldest)
            if job is not None and job.status == "running":
                self._order.append(oldest)  # выполняющиеся не вытесняем
                return
            self._jobs.pop(oldest, None)


def progress_reporter(job: Job) -> Callable[[int, int], None]:
    def report(done: int, total: int) -> None:
        job.done = done
        job.total = total
        job.progress = done / total if total else 0.0

    return report
