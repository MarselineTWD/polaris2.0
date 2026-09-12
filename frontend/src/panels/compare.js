/**
 * Сравнение сохранённых вариантов проекта.
 *
 * Оба варианта считаются на одинаковой сетке времени, поэтому показатели
 * сопоставимы напрямую. Показывается и то, чем варианты отличаются по входу,
 * и то, к чему это привело по каждому наземному пункту.
 */

import { decimal, duration, escapeHtml, percent, points } from "../format.js";
import { $, setModal, toast } from "./shell.js";

let handlers = {};
let selection = { base: null, other: null };

export function initCompare(callbacks) {
  handlers = callbacks;
  $("compare-button").addEventListener("click", () => handlers.open?.());
}

export function renderCompare(state, comparison) {
  const host = $("compare-content");
  const variants = state.variants;
  const ids = new Set(variants.map((variant) => variant.id));
  if (!ids.has(selection.base)) selection.base = null;
  if (!ids.has(selection.other)) selection.other = null;

  if (variants.length < 2) {
    host.innerHTML = `
      <div class="section-block">
        <h3>Нужно минимум два сохранённых варианта</h3>
        <p class="lead">Настройте конфигурацию, выполните расчёт и сохраните её как вариант.
        Затем измените параметры — этап развёртывания, ориентацию плоскостей или состав отказов —
        и сохраните второй вариант. После этого их можно сопоставить.</p>
        <div class="section-actions">
          <button class="button button-primary" id="save-current-variant" type="button">Сохранить текущий вариант</button>
        </div>
        ${variantListMarkup(variants, selection)}
      </div>`;
    bind(state);
    return;
  }

  host.innerHTML = `
    <div class="section-block">
      <h3>Выберите два варианта</h3>
      <p class="lead">Отметьте базовый вариант и тот, с которым его сравниваем.</p>
      <div class="section-actions">
        <button class="button button-subtle" id="save-current-variant" type="button">Сохранить текущий</button>
        <button class="button button-primary" id="run-compare" type="button">Сравнить выбранные</button>
      </div>
      ${variantListMarkup(variants, selection)}
    </div>
    ${comparison ? comparisonMarkup(comparison) : ""}`;
  bind(state);
}

function variantListMarkup(variants, chosen) {
  if (!variants.length) {
    return `<div class="empty-state">Сохранённых вариантов пока нет</div>`;
  }
  return `<div class="variant-list">${variants
    .map((variant) => {
      const summary = variant.summary || {};
      const role =
        chosen.base === variant.id ? "базовый" : chosen.other === variant.id ? "сравниваемый" : "";
      return `
        <div class="variant-row ${role ? "selected" : ""}" data-variant="${variant.id}">
          <div>
            <strong>${escapeHtml(variant.label)}</strong>
            <span>${escapeHtml(variant.created_at)} · этап ${summary.launch_stage ?? "—"} ·
            ISL ${decimal(summary.isl_range_km, 0)} км · мин. доступность ${percent(summary.min_availability_pct)}</span>
          </div>
          <span class="badge ${summary.target_met ? "ok" : "bad"}">${summary.target_met ? "цель достигнута" : "ниже цели"}</span>
          <div>
            <button class="mini-action" data-pick="base" data-id="${variant.id}">${
              chosen.base === variant.id ? "★ базовый" : "базовый"
            }</button>
            <button class="mini-action" data-pick="other" data-id="${variant.id}">${
              chosen.other === variant.id ? "★ сравнить" : "сравнить"
            }</button>
            <button class="mini-action" data-delete="${variant.id}">×</button>
          </div>
        </div>`;
    })
    .join("")}</div>`;
}

function comparisonMarkup(comparison) {
  const { base, other, parameter_diff: diff, client_diff: clients, verdict } = comparison;
  const better = verdict.delta_min_availability_pp > 0;

  return `
    <div class="section-block">
      <h3>Что изменилось во входных параметрах</h3>
      ${
        diff.length
          ? `<div class="table-scroll"><table class="data-table">
              <thead><tr><th>Параметр</th><th>${escapeHtml(base.label || base.title)}</th>
                <th>${escapeHtml(other.label || other.title)}</th></tr></thead>
              <tbody>${diff
                .map(
                  (row) =>
                    `<tr><td>${escapeHtml(row.label)}</td><td class="muted">${formatValue(
                      row.base
                    )}</td><td>${formatValue(row.other)}</td></tr>`
                )
                .join("")}</tbody></table></div>`
          : `<div class="empty-state">Входные параметры совпадают</div>`
      }
    </div>

    <div class="section-block">
      <h3>Доступность по наземным пунктам</h3>
      <p class="lead">Целевой уровень проверяется отдельно для каждого пункта.</p>
      <div class="table-scroll"><table class="data-table">
        <thead><tr>
          <th>Пункт</th><th>Базовый</th><th>Сравниваемый</th><th>Изменение</th>
          <th>Макс. перерыв, базовый</th><th>Макс. перерыв, новый</th><th>Переходы</th>
        </tr></thead>
        <tbody>${clients
          .map(
            (row) => `
          <tr>
            <td><strong>${escapeHtml(row.client_id)}</strong></td>
            <td class="${row.base_target_met ? "good" : "bad"}">${percent(row.base_availability_pct)}</td>
            <td class="${row.other_target_met ? "good" : "bad"}">${percent(row.other_availability_pct)}</td>
            <td class="${row.delta_pp >= 0 ? "good" : "bad"}">${points(row.delta_pp)}</td>
            <td class="muted">${duration(row.base_max_gap_s)}</td>
            <td class="${row.delta_max_gap_s > 0 ? "bad" : "muted"}">${duration(row.other_max_gap_s)}</td>
            <td class="muted">${decimal(row.base_mean_hops)} → ${decimal(row.other_mean_hops)}</td>
          </tr>`
          )
          .join("")}</tbody></table></div>
    </div>

    <div class="advice ${better ? "info" : "critical"}">
      <strong>${escapeHtml(verdict.headline)}</strong>
      <p>Минимальная по пунктам доступность: ${percent(base.min_availability_pct)} → ${percent(
        other.min_availability_pct
      )} (${points(verdict.delta_min_availability_pp)}).
      Средняя: ${percent(base.mean_availability_pct)} → ${percent(other.mean_availability_pct)}
      (${points(verdict.delta_mean_availability_pp)}).
      Рекомендуется вариант «${escapeHtml(
        verdict.recommended_label ||
          (verdict.recommended === "other" ? other.title : base.title)
      )}».</p>
    </div>`;
}

/** Числовые значения параметров показываем с русским разделителем. */
function formatValue(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : decimal(value, 3).replace(/,?0+$/, "");
  }
  return escapeHtml(value);
}

function bind(state) {
  $("save-current-variant")?.addEventListener("click", () => handlers.saveCurrent?.());
  $("run-compare")?.addEventListener("click", () => {
    if (!selection.base || !selection.other) {
      toast("Отметьте базовый и сравниваемый варианты", "warn");
      return;
    }
    if (selection.base === selection.other) {
      toast("Выберите два разных варианта", "warn");
      return;
    }
    handlers.compare?.(selection.base, selection.other);
  });

  document.querySelectorAll("[data-pick]").forEach((button) =>
    button.addEventListener("click", () => {
      selection = { ...selection, [button.dataset.pick]: button.dataset.id };
      handlers.refresh?.();
    })
  );
  document.querySelectorAll("[data-delete]").forEach((button) =>
    button.addEventListener("click", () => handlers.remove?.(button.dataset.delete))
  );
}

/** Предзаполнить выбор: базовым становится последний сохранённый вариант. */
export function primeSelection(variants) {
  if (!selection.base && variants[1]) selection.base = variants[1].id;
  if (!selection.other && variants[0]) selection.other = variants[0].id;
}

export function openCompare() {
  setModal("compare-modal", true);
}
