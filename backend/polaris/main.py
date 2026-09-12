"""Точка входа сервиса: API и раздача интерфейса одним процессом."""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api.routes import router
from .config import settings
from .domain.scenario import ScenarioValidationError
from .domain.visibility import TaskTooLargeError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
logger = logging.getLogger("polaris")

app = FastAPI(
    title="POLARIS — проектирование устойчивой спутниковой группировки",
    version=__version__,
    description=(
        "Расчёт покрытия, маршрутизация «наземный пункт → спутники → шлюз», "
        "анализ устойчивости и сравнение вариантов группировки."
    ),
)

@app.middleware("http")
async def guard_request(request: Request, call_next: Any) -> Any:
    """Ограничение размера тела и журнал длительности обработки."""
    length = request.headers.get("content-length")
    if length is not None and length.isdigit() and int(length) > settings.max_upload_bytes:
        return JSONResponse(
            status_code=413,
            content={
                "error_code": "payload_too_large",
                "message": (
                    f"Файл больше допустимых {settings.max_upload_bytes // 1024 // 1024} МБ"
                ),
                "details": [],
            },
        )
    started = time.perf_counter()
    response = await call_next(request)
    elapsed = (time.perf_counter() - started) * 1000
    if request.url.path.startswith("/api"):
        logger.info("%s %s -> %s за %.0f мс", request.method, request.url.path, response.status_code, elapsed)
    response.headers["X-Elapsed-Ms"] = f"{elapsed:.1f}"
    return response


@app.exception_handler(ScenarioValidationError)
async def handle_validation(_: Request, error: ScenarioValidationError) -> JSONResponse:
    """Проблемы сценария возвращаются списком с путями до полей."""
    return JSONResponse(status_code=422, content=error.as_dict())


@app.exception_handler(TaskTooLargeError)
async def handle_too_large(_: Request, error: TaskTooLargeError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error_code": "task_too_large",
            "message": str(error),
            "details": [{"steps": error.steps, "pairs": error.pairs}],
        },
    )


@app.exception_handler(Exception)
async def handle_unexpected(request: Request, error: Exception) -> JSONResponse:
    """Наружу уходит код и текст, трассировка остаётся в журнале."""
    logger.exception("Необработанная ошибка на %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error_code": "internal_error",
            "message": "Внутренняя ошибка сервиса. Подробности записаны в журнал.",
            "details": [{"type": error.__class__.__name__}],
        },
    )


class RevalidatingStaticFiles(StaticFiles):
    """Статика с обязательной ревалидацией по ETag.

    Без этого браузер может держать старую разметку или стили из кэша —
    неприятно во время демонстрации и при обновлении интерфейса.
    Ответ по-прежнему отдаётся как 304, когда файл не менялся.
    """

    def file_response(self, *args: Any, **kwargs: Any) -> Any:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app.include_router(router)

if settings.frontend_dir.exists():
    app.mount("/", RevalidatingStaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
    logger.info("Интерфейс раздаётся из %s", settings.frontend_dir)
else:  # pragma: no cover - подсказка при неполной установке
    logger.warning("Каталог интерфейса не найден: %s", settings.frontend_dir)


def run() -> None:  # pragma: no cover - удобный запуск из консоли
    import uvicorn

    uvicorn.run("polaris.main:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":  # pragma: no cover
    run()
