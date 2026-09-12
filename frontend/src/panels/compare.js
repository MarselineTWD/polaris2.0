/** Сравнение до пяти равноправных сохранённых вариантов проекта. */

import { decimal, duration, escapeHtml, percent } from "../format.js";
import { $, setModal, toast } from "./shell.js";

let handlers = {};
const selection = new Set();

export function initCompare(callbacks) {
  handlers = callbacks;
  $("compare-button").addEventListener("click", () => handlers.open?.());
}

export function renderCompare(state, comparison) {
  const host = $("compare-content");
  const validIds = new Set(state.variants.map((variant) => variant.id));
  for (const id of selection) if (!validIds.has(id)) selection.delete(id);

  host.innerHTML = `
    <div class="section-block">
      <div class="compare-picker-head">
        <div><h3>Варианты для сравнения</h3><p class="lead">Выберите от 2 до 5 решений. Все варианты равноправны и пересчитываются одной стратегией маршрутизации.</p></div>
        <span class="selection-counter">Выбрано ${selection.size} / 5</span>
      </div>
      <div class="section-actions">
        <button class="button button-subtle" id="save-current-variant" type="button">Сохранить текущий</button>
        <button class="button button-primary" id="run-compare" type="button" ${selection.size < 2 ? "disabled" : ""}>Сравнить выбранные</button>
      </div>
      ${variantListMarkup(state.variants)}
    </div>
    ${comparison ? comparisonMarkup(comparison) : ""}`;
  bind();
}

function variantListMarkup(variants) {
  if (!variants.length) return `<div class="empty-state">Сохранённых вариантов пока нет</div>`;
  return `<div class="variant-list">${variants.map((variant) => {
    const summary = variant.summary || {};
    const chosen = selection.has(variant.id);
    return `
      <div class="variant-row ${chosen ? "selected" : ""}" data-variant="${variant.id}">
        <button class="variant-check" data-toggle-variant="${variant.id}" type="button" aria-pressed="${chosen}"><span>${chosen ? "✓" : ""}</span></button>
        <div>
          <strong>${escapeHtml(variant.label)}</strong>
          <span>${escapeHtml(variant.created_at)} · этап ${summary.launch_stage ?? "—"} · ISL ${decimal(summary.isl_range_km, 0)} км · мин. доступность ${percent(summary.min_availability_pct)}</span>
        </div>
        <span class="badge ${summary.target_met ? "ok" : "bad"}">${summary.target_met ? "цель достигнута" : "ниже цели"}</span>
        <div class="variant-actions">
          <button class="mini-action" data-export-variant="${variant.id}" type="button" title="Скачать конфигурацию JSON">↓ JSON</button>
          <button class="mini-action" data-delete="${variant.id}" type="button" aria-label="Удалить вариант" title="Удалить вариант">×</button>
        </div>
      </div>`;
  }).join("")}</div>`;
}

function comparisonMarkup(comparison) {
  const variants = comparison.variants || [];
  const parameterRows = comparison.parameter_rows || [];
  const metricRows = [
    ["Минимальная доступность", (item) => percent(item.min_availability_pct)],
    ["Средняя доступность", (item) => percent(item.mean_availability_pct)],
    ["Максимальный перерыв", (item) => duration(item.max_gap_s)],
    ["Активных аппаратов", (item) => String(item.active_satellites)],
    ["Этап развёртывания", (item) => String(item.launch_stage)],
    ["Дальность ISL", (item) => `${decimal(item.isl_range_km, 0)} км`],
    ["Среднее число связей", (item) => decimal(item.mean_links, 1)],
  ];
  const clientIds = [...new Set(variants.flatMap((variant) => variant.clients.map((client) => client.client_id)))];

  return `
    <div class="advice info compare-result-summary"><strong>Лучший по минимальной доступности: ${escapeHtml(comparison.recommended_label)}</strong><p>При равенстве учитываются средняя доступность и меньший максимальный перерыв.</p></div>
    <div class="section-block">
      <h3>Ключевые показатели</h3>
      <div class="table-scroll"><table class="data-table multi-compare-table">
        <thead><tr><th>Показатель</th>${variants.map((item) => `<th class="${item.id === comparison.recommended_id ? "winner" : ""}">${escapeHtml(item.label)}</th>`).join("")}</tr></thead>
        <tbody>${metricRows.map(([label, format]) => `<tr><td>${label}</td>${variants.map((item) => `<td class="${item.id === comparison.recommended_id ? "winner" : ""}">${format(item)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
    </div>
    <div class="section-block">
      <h3>Что изменено в вариантах</h3>
      <p class="lead">Показаны только различающиеся входные параметры. Так результат можно связать с конкретным проектным решением.</p>
      ${parameterRows.length ? `<div class="table-scroll"><table class="data-table multi-compare-table parameter-compare-table">
        <thead><tr><th>Параметр</th>${variants.map((item) => `<th>${escapeHtml(item.label)}</th>`).join("")}</tr></thead>
        <tbody>${parameterRows.map((row) => `<tr><td>${escapeHtml(row.label)}</td>${variants.map((item) => `<td>${parameterValue(row.values?.[item.id])}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty-state">Входные параметры выбранных вариантов совпадают</div>`}
    </div>
    <div class="section-block">
      <h3>Доступность по наземным пунктам</h3>
      <p class="lead">В ячейке показаны доступность и максимальный непрерывный перерыв.</p>
      <div class="table-scroll"><table class="data-table multi-compare-table">
        <thead><tr><th>Пункт</th>${variants.map((item) => `<th>${escapeHtml(item.label)}</th>`).join("")}</tr></thead>
        <tbody>${clientIds.map((clientId) => `<tr><td><strong>${escapeHtml(clientId)}</strong></td>${variants.map((variant) => {
          const client = variant.clients.find((item) => item.client_id === clientId);
          return client ? `<td class="${client.target_met ? "good" : "bad"}">${percent(client.availability_pct)}<small>${duration(client.max_gap_s)}</small></td>` : `<td class="muted">—</td>`;
        }).join("")}</tr>`).join("")}</tbody>
      </table></div>
    </div>`;
}

function parameterValue(value) {
  if (Array.isArray(value)) {
    if (!value.length) return `<span class="muted">нет</span>`;
    const details = value.map((item) => {
      const target = item.satellite_id || item.gateway_id || "объект";
      return `${target}: ${item.start_s}–${item.end_s} с`;
    });
    return `<details class="parameter-details"><summary>${value.length} ${value.length === 1 ? "интервал" : "интервалов"}</summary><span>${details.map(escapeHtml).join("<br>")}</span></details>`;
  }
  if (value == null) return `<span class="muted">нет</span>`;
  return escapeHtml(String(value));
}

function bind() {
  $("save-current-variant")?.addEventListener("click", () => handlers.saveCurrent?.());
  $("run-compare")?.addEventListener("click", () => {
    if (selection.size < 2) {
      toast("Выберите минимум два варианта", "warn");
      return;
    }
    handlers.compare?.([...selection]);
  });
  document.querySelectorAll("[data-toggle-variant]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.toggleVariant;
      if (selection.has(id)) selection.delete(id);
      else if (selection.size < 5) selection.add(id);
      else {
        toast("Одновременно можно сравнить не больше пяти вариантов", "warn");
        return;
      }
      handlers.refresh?.();
    });
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      selection.delete(button.dataset.delete);
      handlers.remove?.(button.dataset.delete);
    });
  });
  document.querySelectorAll("[data-export-variant]").forEach((button) => {
    button.addEventListener("click", () => handlers.exportVariant?.(button.dataset.exportVariant));
  });
}

export function primeSelection(variants) {
  const ids = new Set(variants.map((variant) => variant.id));
  for (const id of selection) if (!ids.has(id)) selection.delete(id);
  for (const variant of variants) {
    if (selection.size >= Math.min(2, variants.length)) break;
    selection.add(variant.id);
  }
}

export function openCompare() {
  setModal("compare-modal", true);
}
