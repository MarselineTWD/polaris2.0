# Один образ: расчётное ядро, API и интерфейс.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/backend \
    POLARIS_STATE_DIR=/app/state

WORKDIR /app

# Зависимости ставим отдельным слоем, чтобы правки кода не перезапускали установку.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Раскладка внутри образа повторяет репозиторий: тогда пути по умолчанию
# («Данные», «frontend») работают без переопределения, а тесты паритета
# с эталонным модулем запускаются прямо в контейнере.
# Форма COPY списком обязательна — в именах каталогов есть пробел.
COPY backend/ backend/
COPY frontend/ frontend/
COPY ["Данные/", "/app/Данные/"]
COPY ["Расчетный модуль/", "/app/Расчетный модуль/"]

RUN mkdir -p /app/state

EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=4s --start-period=8s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status == 200 else 1)"

CMD ["python", "-m", "uvicorn", "polaris.main:app", "--host", "0.0.0.0", "--port", "8000"]
