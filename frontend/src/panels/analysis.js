/**
 * Окно анализа: выводы, уязвимости, стратегии и автоподбор.
 *
 * Все четыре блока опираются на выполненный расчёт. Автоподбор и свип точек
 * отказа — длительные операции, они выполняются на сервере фоново и
 * показывают прогресс.
 */

import { decimal, duration, escapeHtml, percent, points } from "../format.js";
import { $, setModal } from "./shell.js";

let handlers = {};

export function initAnalysis(callbacks) {
  handlers = callbacks;
  $("analysis-button").addEventListener("click", () => handlers.open?.());
}

export function openAnalysis() {
  setModal("analysis-modal", true);
}

export function renderAnalysis(state) {
  const host = $("analysis-content");
  const bundle = state.bundle;
  if (!bundle) {
    host.innerHTML = `<div class="empty-state">Сначала выполните расчёт</div>`;
    return;
  }
  const summary = bundle.summary;
  const analysis = state.analysis;

  host.innerHTML = `
    ${adviceSection(summary)}
    ${criticalitySection(summary)}
    ${strategySection(analysis.strategies)}
    ${spofSection(analysis.spof)}
    ${optimizeSection(analysis.optimize, summary)}`;

  bind(state);
}

function adviceSection(summary) {
  const items = summary.recommendations || [];
  return `
    <div class="section-block">
      <h3>Выводы по расчёту</h3>
      <p class="lead">Каждый вывод получен из посчитанных величин: рядом приведены числа, на которых он основан.</p>
      ${
        items.length
          ? `<div class="advice-list">${items
              .map(
                (item) => `
            <div class="advice ${escapeHtml(item.severity)}">
              <strong>${escapeHtml(item.title)}</strong>
              <p>${escapeHtml(item.detail)}</p>
            </div>`
              )
              .join("")}</div>`
          : `<div class="empty-state">Замечаний нет</div>`
      }
    </div>`;
}

function criticalitySection(summary) {
  const rows = summary.criticality || [];
  return `
    <div class="section-block">
      <h3>Наиболее уязвимые аппараты</h3>
      <p class="lead">Доля отсчётов с маршрутом, в которых аппарат оказывается единственной точкой прохода:
      его отказ в этот момент немедленно разорвал бы связь.</p>
      ${
        rows.length
          ? `<div class="table-scroll"><table class="data-table">
              <thead><tr><th>Аппарат</th><th>Критичен</th><th>Отсчётов</th><th>Используется</th><th>Затронутые пункты</th></tr></thead>
              <tbody>${rows
                .map(
                  (row) => `
                <tr>
                  <td><strong>${escapeHtml(row.satellite_id)}</strong></td>
                  <td class="${row.critical_share_pct > 5 ? "bad" : ""}">${percent(row.critical_share_pct)}</td>
                  <td class="muted">${row.critical_steps}</td>
                  <td class="muted">${row.used_steps}</td>
                  <td class="muted">${escapeHtml(row.affected_clients.join(", "))}</td>
                </tr>`
                )
                .join("")}</tbody></table></div>`
          : `<div class="empty-state">Единственных точек прохода не найдено — резерв есть всегда</div>`
      }
    </div>`;
}

function strategySection(data) {
  return `
    <div class="section-block">
      <h3>Сравнение стратегий маршрутизации</h3>
      <p class="lead">Один и тот же граф сети, три правила выбора пути. Доступность от стратегии не зависит —
      путь либо существует, либо нет; различаются число переходов, задержка и запас линий.</p>
      <div class="section-actions">
        <button class="button button-subtle" id="run-strategies" type="button">Посчитать все три стратегии</button>
      </div>
      ${
        data
          ? `<div class="table-scroll"><table class="data-table">
              <thead><tr><th>Стратегия</th><th>Мин. доступность</th><th>Переходы</th><th>Задержка</th><th>Запас линии</th><th>Перестроений</th></tr></thead>
              <tbody>${data.strategies
                .map(
                  (row) => `
                <tr>
                  <td><strong>${escapeHtml(row.label)}</strong></td>
                  <td>${percent(row.min_availability_pct)}</td>
                  <td>${decimal(row.mean_hops)}</td>
                  <td>${decimal(row.mean_latency_ms)} мс</td>
                  <td>${decimal(row.mean_margin, 3)}</td>
                  <td class="muted">${row.route_changes}</td>
                </tr>`
                )
                .join("")}</tbody></table></div>`
          : `<div class="empty-state">Нажмите кнопку, чтобы посчитать</div>`
      }
    </div>`;
}

function spofSection(data) {
  return `
    <div class="section-block">
      <h3>Последствия потери одного аппарата</h3>
      <p class="lead">Горизонт пересчитывается заново с постоянным отказом каждого аппарата по очереди.
      Это точный ответ, а не оценка: показано, до какого уровня опустится минимальная доступность.</p>
      <div class="section-actions">
        <button class="button button-subtle" id="run-spof" type="button">Проверить все аппараты</button>
      </div>
      ${
        data
          ? `<p class="lead">Исходная минимальная доступность — ${percent(
              data.baseline.min_availability_pct
            )}. Проверено аппаратов: ${data.evaluated}.</p>
            <div class="table-scroll"><table class="data-table">
              <thead><tr><th>Аппарат</th><th>Мин. доступность</th><th>Изменение</th><th>Худший пункт</th><th>Макс. перерыв</th></tr></thead>
              <tbody>${data.worst
                .map(
                  (row) => `
                <tr>
                  <td><strong>${escapeHtml(row.satellite_id)}</strong></td>
                  <td class="${row.delta_min_pp < 0 ? "bad" : ""}">${percent(row.min_availability_pct)}</td>
                  <td class="${row.delta_min_pp < 0 ? "bad" : "muted"}">${points(row.delta_min_pp)}</td>
                  <td class="muted">${escapeHtml(row.worst_client)}</td>
                  <td class="muted">${duration(row.max_gap_s)}</td>
                </tr>`
                )
                .join("")}</tbody></table></div>`
          : `<div class="empty-state">Нажмите кнопку, чтобы выполнить свип</div>`
      }
    </div>`;
}

function optimizeSection(data, summary) {
  return `
    <div class="section-block">
      <h3>Автоподбор ориентации и фазирования плоскостей</h3>
      <p class="lead">Ищется расстановка плоскостей, при которой минимальная по пунктам доступность максимальна.
      Сначала перебирается регулярное семейство (равномерный разнос RAAN и межплоскостной сдвиг),
      затем решение уточняется покоординатно. Состав аппаратов и очереди запуска не меняются.</p>
      <div class="section-actions">
        <button class="button button-subtle" id="run-optimize" type="button">Подобрать конфигурацию</button>
        ${data ? `<button class="button button-primary" id="apply-optimized" type="button">Применить найденную</button>` : ""}
      </div>
      ${
        data
          ? `<div class="table-scroll"><table class="data-table">
              <thead><tr><th></th><th>RAAN плоскостей, °</th><th>Фазирование, °</th><th>Мин. доступность</th><th>Средняя</th></tr></thead>
              <tbody>
                <tr><td class="muted">Исходная</td>
                    <td class="muted">${data.baseline.raan_deg.map((v) => decimal(v, 1)).join(" · ")}</td>
                    <td class="muted">${data.baseline.phase_deg.map((v) => decimal(v, 1)).join(" · ")}</td>
                    <td class="muted">${percent(data.baseline.min_availability_pct)}</td>
                    <td class="muted">${percent(data.baseline.mean_availability_pct)}</td></tr>
                <tr><td><strong>Найденная</strong></td>
                    <td>${data.best.raan_deg.map((v) => decimal(v, 1)).join(" · ")}</td>
                    <td>${data.best.phase_deg.map((v) => decimal(v, 1)).join(" · ")}</td>
                    <td class="good">${percent(data.best.min_availability_pct)}</td>
                    <td class="good">${percent(data.best.mean_availability_pct)}</td></tr>
              </tbody></table></div>
            <div class="advice ${data.improvement_pp > 0 ? "info" : "warning"}">
              <strong>Прирост минимальной доступности: ${points(data.improvement_pp)}</strong>
              <p>Оценено конфигураций: ${data.evaluations}. Каждая посчитана полным расчётом горизонта, без приближений.
              ${
                data.target_met
                  ? `Найденная конфигурация выводит все пункты на целевой уровень ${percent(summary.target_pct, 0)}.`
                  : `Целевой уровень ${percent(summary.target_pct, 0)} не достигается даже при лучшей расстановке — ограничение не в ориентации плоскостей.`
              }</p>
            </div>`
          : `<div class="empty-state">Нажмите кнопку, чтобы запустить подбор</div>`
      }
    </div>`;
}

function bind(state) {
  $("run-strategies")?.addEventListener("click", () => handlers.runStrategies?.());
  $("run-spof")?.addEventListener("click", () => handlers.runSpof?.());
  $("run-optimize")?.addEventListener("click", () => handlers.runOptimize?.());
  $("apply-optimized")?.addEventListener("click", () => handlers.applyOptimized?.());
}
