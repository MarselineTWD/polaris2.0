/**
 * Шторка «Проект»: конфигурация, которая уйдёт на расчёт.
 *
 * Условия расчёта (`environment`) по умолчанию только для чтения: они задаются
 * загруженным файлом и одинаковы для всех сопоставляемых вариантов. Менять их
 * можно, но только сознательно — включив исследовательский режим, который
 * помечает вариант как посчитанный в других условиях.
 *
 * Пользователь правит ровно то, что перечисляет ТЗ: очередь запуска,
 * ориентацию и фазирование плоскостей, периоды недоступности аппаратов
 * и шлюзов. Состав аппаратов и их `launch_batch` не редактируются.
 */

import { clock, decimal, escapeHtml } from "../format.js";
import { $, fieldErrorsMarkup, toast } from "./shell.js";

let handlers = {};
let problems = [];

export function initProject(callbacks) {
  handlers = callbacks;
  $("project-button").addEventListener("click", () => handlers.open?.());
  $("apply-config").addEventListener("click", () => handlers.apply?.());
  $("reset-config").addEventListener("click", () => handlers.reset?.());
}

export function setProblems(list) {
  problems = list || [];
}

export function renderProject(state) {
  const draft = state.draft;
  const host = $("drawer-content");
  if (!draft) {
    host.innerHTML = `<div class="empty-state">Сценарий не загружен</div>`;
    return;
  }

  const environment = draft.environment;
  const locked = !state.researchMode;
  const satellites = draft.design.satellites;
  const gateways = draft.ground_sites.filter((site) => site.role === "gateway");

  host.innerHTML = `
    ${fieldErrorsMarkup(problems)}

    <label class="upload-zone" for="scenario-file">
      <strong>Импортировать JSON</strong>
      <span>Сценарий или экспорт Polaris · конфигурация будет извлечена автоматически</span>
      <input id="scenario-file" type="file" accept=".json,application/json" />
    </label>

    <label class="field"><span>Встроенный сценарий</span>
      <select id="preset-select">${state.presets
        .map(
          (preset) =>
            `<option value="${preset.id}" ${preset.id === state.presetId ? "selected" : ""}>${escapeHtml(
              preset.title
            )}</option>`
        )
        .join("")}</select>
    </label>

    <div class="drawer-section-title"><span>Этап развёртывания</span><small>launch_stage</small></div>
    <div class="stage-control" style="pointer-events:auto">
      ${[1, 2, 3]
        .map(
          (stage) =>
            `<button type="button" data-draft-stage="${stage}" class="${
              draft.design.launch_stage === stage ? "active" : ""
            }">Этап ${stage} · ${satellites.filter((s) => s.launch_batch <= stage).length} КА</button>`
        )
        .join("")}
    </div>

    <div class="drawer-section-title"><span>Орбитальные плоскости</span><small>RAAN / фазирование, °</small></div>
    <div class="plane-editor">
      ${draft.design.planes
        .map(
          (plane, index) => `
        <div>
          <strong>${escapeHtml(plane.id)}</strong>
          <label>RAAN <input type="number" step="0.1" min="0" max="359.9" value="${plane.raan_deg}" data-plane="${index}" data-key="raan_deg" /></label>
          <label>Фаза <input type="number" step="0.1" min="0" max="359.9" value="${plane.phase_deg}" data-plane="${index}" data-key="phase_deg" /></label>
        </div>`
        )
        .join("")}
    </div>
    <p class="outage-hint">RAAN поворачивает плоскость вокруг Земли и меняет географию прохождения аппаратов. Фазирование сдвигает аппараты вдоль орбиты, не поворачивая саму плоскость. Диапазон обоих — от 0 до 360 исключительно.</p>

    <div class="drawer-section-title"><span>Недоступность аппаратов</span><button class="mini-action" id="add-failure" type="button">+ Добавить</button></div>
    <div class="outage-list" id="failure-list">
      ${
        draft.failures.length
          ? draft.failures
              .map((item, index) => outageRow(item, index, satellites, "satellite_id", environment.horizon_s))
              .join("")
          : `<div class="empty-state">Отказы не заданы</div>`
      }
    </div>

    <div class="drawer-section-title"><span>Недоступность шлюзов</span><button class="mini-action" id="add-gateway-outage" type="button">+ Добавить</button></div>
    <div class="outage-list" id="gateway-outage-list">
      ${
        draft.gateway_outages.length
          ? draft.gateway_outages
              .map((item, index) => outageRow(item, index, gateways, "gateway_id", environment.horizon_s, true))
              .join("")
          : `<div class="empty-state">Отказы шлюзов не заданы</div>`
      }
    </div>

    <div class="drawer-section-title"><span>Условия расчёта</span><small>environment</small></div>
    <div class="readonly-block">
      ${
        locked
          ? `<div class="readonly-grid">
              <div><span>Высота орбиты</span><strong>${decimal(environment.altitude_km, 0)} км</strong></div>
              <div><span>Наклонение</span><strong>${decimal(environment.inclination_deg, 1)}°</strong></div>
              <div><span>Дальность ISL</span><strong>${decimal(environment.isl_range_km, 0)} км</strong></div>
              <div><span>Мин. возвышение</span><strong>${decimal(environment.min_elevation_deg, 1)}°</strong></div>
              <div><span>Горизонт расчёта</span><strong>${decimal(environment.horizon_s / 3600, 0)} ч</strong></div>
              <div><span>Шаг расчёта</span><strong>${environment.step_s} с</strong></div>
              <div><span>Целевая доступность</span><strong>${decimal(environment.target_availability * 100, 0)}%</strong></div>
              <div><span>Угол Земли в t₀</span><strong>${decimal(environment.earth_angle0_deg, 1)}°</strong></div>
            </div>`
          : `<div class="form-grid">
              ${envField("altitude_km", "Высота орбиты", environment.altitude_km, "км", 1)}
              ${envField("inclination_deg", "Наклонение", environment.inclination_deg, "°", 0.1)}
              ${envField("isl_range_km", "Дальность ISL", environment.isl_range_km, "км", 50)}
              ${envField("min_elevation_deg", "Мин. возвышение", environment.min_elevation_deg, "°", 0.5)}
            </div>`
      }
      <label class="research-toggle">
        <input type="checkbox" id="research-mode" ${state.researchMode ? "checked" : ""} />
        <span><b>Исследовательский режим</b>
        Условия расчёта задаются загруженным файлом и держатся одинаковыми, чтобы варианты проекта
        можно было сопоставлять. Включите режим, если нужно исследовать другие условия — вариант
        будет помечен, и сравнивать его с остальными следует с оговоркой.</span>
      </label>
    </div>`;

  bind(state);
}

function envField(key, label, value, unit, step) {
  return `<label class="field"><span>${label}</span><div class="input-unit">
    <input type="number" step="${step}" value="${value}" data-env="${key}" /><small>${unit}</small>
  </div></label>`;
}

function outageRow(item, index, options, key, horizon, isGateway = false) {
  const list = isGateway ? "gateway_outages" : "failures";
  return `
    <div class="outage-row">
      <select data-outage="${list}" data-index="${index}" data-key="${key}">
        ${options
          .map(
            (option) =>
              `<option value="${option.id}" ${option.id === item[key] ? "selected" : ""}>${escapeHtml(
                option.id
              )}</option>`
          )
          .join("")}
      </select>
      <input type="number" min="0" max="${horizon}" step="60" value="${item.start_s}"
             data-outage="${list}" data-index="${index}" data-key="start_s" title="Начало, с (включительно)" />
      <input type="number" min="0" max="${horizon}" step="60" value="${item.end_s}"
             data-outage="${list}" data-index="${index}" data-key="end_s" title="Конец, с (исключительно)" />
      <button class="mini-action" data-remove-outage="${list}" data-index="${index}" type="button">Убрать</button>
    </div>`;
}

function bind(state) {
  const draft = state.draft;

  $("preset-select")?.addEventListener("change", (event) => handlers.loadPreset?.(event.target.value));
  $("scenario-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await handlers.loadFile?.(file);
  });

  document.querySelectorAll("[data-draft-stage]").forEach((button) =>
    button.addEventListener("click", () => {
      draft.design.launch_stage = Number(button.dataset.draftStage);
      handlers.changed?.();
    })
  );

  document.querySelectorAll("[data-plane]").forEach((input) =>
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      // Приводим угол к диапазону [0; 360): схема данных требует именно его.
      draft.design.planes[Number(input.dataset.plane)][input.dataset.key] = ((value % 360) + 360) % 360;
      handlers.changed?.();
    })
  );

  document.querySelectorAll("[data-env]").forEach((input) =>
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      draft.environment[input.dataset.env] = value;
      handlers.changed?.();
    })
  );

  document.querySelectorAll("[data-outage]").forEach((control) =>
    control.addEventListener("change", () => {
      const list = draft[control.dataset.outage];
      const entry = list[Number(control.dataset.index)];
      const key = control.dataset.key;
      entry[key] = key.endsWith("_s") ? Number(control.value) : control.value;
      handlers.changed?.();
    })
  );

  document.querySelectorAll("[data-remove-outage]").forEach((button) =>
    button.addEventListener("click", () => {
      draft[button.dataset.removeOutage].splice(Number(button.dataset.index), 1);
      handlers.changed?.();
    })
  );

  $("add-failure")?.addEventListener("click", () => {
    const candidate =
      draft.design.satellites.find(
        (satellite) =>
          satellite.launch_batch <= draft.design.launch_stage &&
          !draft.failures.some((item) => item.satellite_id === satellite.id)
      ) || draft.design.satellites[0];
    draft.failures.push({
      satellite_id: candidate.id,
      start_s: 0,
      end_s: draft.environment.horizon_s,
    });
    handlers.changed?.();
  });

  $("add-gateway-outage")?.addEventListener("click", () => {
    const gateway = draft.ground_sites.find((site) => site.role === "gateway");
    if (!gateway) return;
    draft.gateway_outages.push({
      gateway_id: gateway.id,
      start_s: 0,
      end_s: Math.min(3600, draft.environment.horizon_s),
    });
    handlers.changed?.();
  });

  $("research-mode")?.addEventListener("change", (event) => {
    handlers.setResearchMode?.(event.target.checked);
    if (event.target.checked) {
      toast("Исследовательский режим включён: условия расчёта можно менять", "warn");
    }
  });
}

/** Переключить период недоступности аппарата прямо из инспектора. */
export function toggleSatelliteFailure(draft, satelliteId) {
  const existing = draft.failures.findIndex((item) => item.satellite_id === satelliteId);
  if (existing >= 0) {
    draft.failures.splice(existing, 1);
    return false;
  }
  draft.failures.push({
    satellite_id: satelliteId,
    start_s: 0,
    end_s: draft.environment.horizon_s,
  });
  return true;
}
