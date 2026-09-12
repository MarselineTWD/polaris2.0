#!/usr/bin/env python3
"""Запуск сервиса POLARIS одной командой: python run_server.py

Поднимает FastAPI-приложение, которое отдаёт и расчётное API, и интерфейс.
Параметры берутся из переменных окружения POLARIS_HOST / POLARIS_PORT.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))


def main() -> None:
    import uvicorn

    host = os.getenv("POLARIS_HOST", "127.0.0.1")
    port = int(os.getenv("POLARIS_PORT", "8000"))
    reload_enabled = os.getenv("POLARIS_RELOAD", "").lower() in {"1", "true", "yes"}

    print(f"POLARIS → http://{host}:{port}  (документация API: /docs)")
    uvicorn.run(
        "polaris.main:app",
        host=host,
        port=port,
        reload=reload_enabled,
        reload_dirs=[str(ROOT / "backend")] if reload_enabled else None,
    )


if __name__ == "__main__":
    main()
