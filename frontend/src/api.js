/**
 * Клиент расчётного API.
 *
 * Сервер отдаёт ошибки единым видом `{error_code, message, details}`;
 * для проблем сценария details содержит путь до конкретного поля, и именно
 * он показывается пользователю.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "unknown", details = [] } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Проблемы валидации сценария в виде «путь — сообщение». */
  get fieldProblems() {
    return this.details
      .filter((item) => item && item.path)
      .map((item) => ({ path: item.path, message: item.message, value: item.value }));
  }
}

async function request(path, { method = "GET", body, signal, timeout = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new ApiError("Расчёт занял слишком много времени и был прерван", {
        code: "timeout",
      });
    }
    throw new ApiError("Нет связи с расчётным сервисом", { code: "offline" });
  }
  clearTimeout(timer);

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      (typeof payload?.detail === "string" ? payload.detail : null) ||
      `Сервис вернул ошибку ${response.status}`;
    throw new ApiError(message, {
      status: response.status,
      code: payload?.error_code || "http_error",
      details: payload?.details || [],
    });
  }
  return payload;
}

export const api = {
  health: () => request("/health"),
  legend: () => request("/legend"),
  presets: () => request("/presets"),
  preset: (id) => request(`/presets/${encodeURIComponent(id)}`),
  validate: (scenario) => request("/scenarios/validate", { method: "POST", body: { scenario } }),
  run: (scenario, options) => request("/runs", { method: "POST", body: { scenario, options } }),
  snapshotUrl: (runId, t) => `${BASE}/runs/${runId}/snapshot?t_s=${t}`,
  exportUrl: (runId) => `${BASE}/runs/${runId}/export`,

  variants: () => request("/variants"),
  saveVariant: (payload) => request("/variants", { method: "POST", body: payload }),
  deleteVariant: (id) => request(`/variants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  compare: (payload) => request("/compare", { method: "POST", body: payload }),

  strategies: (scenario) => request("/analysis/strategies", { method: "POST", body: { scenario } }),
  spof: (scenario) => request("/analysis/spof", { method: "POST", body: { scenario } }),
  optimize: (scenario, maxEvaluations) =>
    request("/analysis/optimize", {
      method: "POST",
      body: { scenario, max_evaluations: maxEvaluations },
    }),
  job: (id) => request(`/jobs/${encodeURIComponent(id)}`),
};

/** Дождаться завершения фоновой задачи, сообщая прогресс. */
export async function awaitJob(jobId, onProgress, { interval = 400, limit = 600 } = {}) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const job = await api.job(jobId);
    if (onProgress) onProgress(job);
    if (job.status === "done") return job.result;
    if (job.status === "failed") {
      throw new ApiError(job.error || "Фоновый расчёт завершился ошибкой", { code: "job_failed" });
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new ApiError("Фоновый расчёт не завершился за отведённое время", { code: "job_timeout" });
}
