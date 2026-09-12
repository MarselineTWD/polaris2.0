/**
 * Правая панель: подробности выбранного объекта.
 *
 * Все числа берутся из расчётного пакета. Когда маршрута нет, панель
 * показывает не «ошибку», а причину, которую определило расчётное ядро.
 */

import { clock, coordinates, decimal, duration, escapeHtml, percent } from "../format.js";
import { CAUSE_LABEL, CAUSE_LABEL_BY_NAME, STATE } from "../model/bundle.js";
import { $, plural } from "./shell.js";

let handlers = {};

export function initInspector(callbacks) {
  handlers = callbacks;
}

export function renderInspector(state) {
  const host = $("selection-content");
  const bundle = state.bundle;
  if (!bundle) {
    host.innerHTML = `<div class="empty-state">Загрузите сценарий и выполните расчёт</div>`;
    return;
  }
  const selection = state.selection ?? { type: "client", id: state.clientId };
  const step = bundle.stepAt(state.timeSeconds);

  if (selection.type === "satellite") host.innerHTML = satelliteMarkup(bundle, selection.id, step, state);
  else if (selection.type === "plane") host.innerHTML = planeMarkup(bundle, selection.id);
  else if (selection.type === "gateway") host.innerHTML = gatewayMarkup(bundle, selection.id, step);
  else host.innerHTML = clientMarkup(bundle, state.clientId, step);

  bindActions(host, state);
}

function bindActions(host, state) {
  host.querySelectorAll("[data-client]").forEach((button) =>
    button.addEventListener("click", () => handlers.selectClient?.(button.dataset.client))
  );
  host.querySelectorAll("[data-node]").forEach((button) =>
    button.addEventListener("click", () => handlers.selectNode?.(button.dataset.node))
  );
  host.querySelector("[data-action=fail]")?.addEventListener("click", (event) =>
    handlers.toggleFailure?.(event.currentTarget.dataset.satellite)
  );
  host.querySelector("[data-action=focus]")?.addEventListener("click", (event) =>
    handlers.focus?.(event.currentTarget.dataset.ownerType, event.currentTarget.dataset.ownerId)
  );
  host.querySelector("[data-action=track]")?.addEventListener("click", (event) =>
    handlers.trackSatellite?.(event.currentTarget.dataset.satellite)
  );
  host.querySelector("[data-action=edit-plane]")?.addEventListener("click", () =>
    handlers.editProject?.()
  );
  host.querySelectorAll("[data-gap-time]").forEach((button) =>
    button.addEventListener("click", () => handlers.setTime?.(Number(button.dataset.gapTime)))
  );
}

function clientMarkup(bundle, clientId, step) {
  const site = bundle.clients.find((item) => item.id === clientId);
  if (!site) return `<div class="empty-state">Клиентский пункт не выбран</div>`;

  const track = bundle.track(clientId);
  const metrics = track.metrics;
  const routed = track.isRouted(step);
  const route = bundle.routeIds(clientId, step);
  const causeLabel = causeText(bundle, track.cause[step]);
  const required = track.requiredRangeKm[step];

  const switcher = bundle.clients
    .map(
      (item) =>
        `<button type="button" data-client="${item.id}" class="${
          item.id === clientId ? "active" : ""
        }">${escapeHtml(item.id)}</button>`
    )
    .join("");

  return `
    <div class="selection-eyebrow">
      <span>Наземный терминал</span>
      <span class="selection-status ${routed ? "" : "danger"}">${routed ? "Маршрут есть" : "Нет маршрута"}</span>
    </div>
    <h1 class="inspector-title">${escapeHtml(site.name || site.id)}</h1>
    <p class="inspector-subtitle">${escapeHtml(site.id)} · ${coordinates(site.lat_deg, site.lon_deg)}</p>
    <div class="client-switch">${switcher}</div>

    <div class="client-summary">
      <div class="client-score">
        <strong>${percent(metrics.availability_pct)}</strong>
        <span>${metrics.target_met ? `Цель ≥ ${percent(metrics.target_pct, 0)}` : `Ниже цели ${percent(metrics.target_pct, 0)}`}</span>
      </div>
      <div class="progress-track"><span style="width:${Math.min(100, metrics.availability_pct)}%"></span><i style="left:${metrics.target_pct}%"></i></div>
    </div>

    <section class="compact-section">
      <h3>Маршрут в ${clock(step * bundle.stepSeconds, true)}</h3>
      ${
        routed
          ? routeMarkup(bundle, route)
          : `<div class="gap-reason"><span>!</span><div><strong>${escapeHtml(causeLabel)}</strong>
              ${gapDetail(bundle, track, step, required)}</div></div>`
      }
    </section>

    ${gapListMarkup(metrics)}

    <section class="compact-section">
      <h3>Показатели за период</h3>
      <div class="detail-list">
        <div class="detail-row"><span>Радиовидимость</span><strong>${percent(metrics.visibility_pct)}</strong></div>
        <div class="detail-row"><span>Максимальный перерыв</span><strong>${duration(metrics.max_gap_s)}</strong></div>
        <div class="detail-row"><span>Перерывов всего</span><strong>${metrics.gap_count}</strong></div>
        <div class="detail-row"><span>Среднее число переходов</span><strong>${decimal(metrics.mean_hops)}</strong></div>
        <div class="detail-row"><span>Средняя задержка</span><strong>${decimal(metrics.mean_latency_ms)} мс</strong></div>
        <div class="detail-row"><span>Независимых маршрутов</span><strong>${decimal(metrics.mean_diversity)}</strong></div>
        <div class="detail-row"><span>Перестроений маршрута</span><strong>${metrics.route_changes}</strong></div>
      </div>
    </section>

    ${causeSummary(bundle, metrics)}
    <p class="hint-note">Нажмите на аппарат маршрута, чтобы посмотреть его параметры или задать период недоступности.</p>`;
}

function gapListMarkup(metrics) {
  const gaps = metrics.gaps || [];
  if (!gaps.length) {
    return `<section class="compact-section"><h3>Перерывы связи</h3>
      <div class="no-gaps">За расчётный период перерывов нет</div></section>`;
  }
  return `<section class="compact-section gap-section">
    <h3>${gaps.length} ${plural(gaps.length, "перерыв", "перерыва", "перерывов")} связи</h3>
    <div class="gap-list">${gaps
      .map(
        (gap, index) => `<article class="gap-item cause-${gap.cause}">
          <div><strong>${index + 1}. ${clock(gap.start_s, true)}–${clock(gap.end_s, true)}</strong>
            <span>${escapeHtml(gap.cause_label)} · ${duration(gap.duration_s)}</span></div>
          <button class="mini-action" type="button" data-gap-time="${gap.start_s}"
                  title="Перейти к началу перерыва">Показать</button>
        </article>`
      )
      .join("")}</div>
  </section>`;
}

function gapDetail(bundle, track, step, required) {
  const parts = [];
  if (track.state[step] === STATE.VISIBLE_NO_PATH) {
    parts.push("Аппараты над пунктом есть, но довести данные до шлюза сейчас нечем.");
  } else {
    parts.push("Над пунктом нет ни одного активного аппарата.");
  }
  if (required > 0) {
    parts.push(
      `Ближайшая недостающая межспутниковая линия — ${decimal(required, 0)} км ` +
        `при текущем пределе ${decimal(bundle.environment.isl_range_km, 0)} км.`
    );
  }
  return parts.join(" ");
}

function causeSummary(bundle, metrics) {
  const entries = Object.entries(metrics.cause_totals || {}).filter(([name]) => name !== "none");
  if (!entries.length) return "";
  entries.sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const rows = entries
    .map(
      ([name, count]) =>
        `<div class="detail-row"><span>${escapeHtml(causeTextByName(bundle, name))}</span><strong>${percent(
          (count / total) * 100,
          0
        )}</strong></div>`
    )
    .join("");
  return `<section class="compact-section"><h3>Из-за чего пропадала связь</h3><div class="detail-list">${rows}</div></section>`;
}

function routeMarkup(bundle, nodes) {
  const satellites = new Set(bundle.satellites.map((item) => item.id));
  return `<div class="route-mini">${nodes
    .map(
      (id, index) =>
        `<button type="button" data-node="${escapeHtml(id)}" class="${
          satellites.has(id) ? "" : "ground"
        }" title="Выбрать ${escapeHtml(id)}">${escapeHtml(id)}</button>${
          index < nodes.length - 1 ? "<i></i>" : ""
        }`
    )
    .join("")}</div>`;
}

function satelliteMarkup(bundle, satelliteId, step, state) {
  const index = bundle.satelliteIndex.get(satelliteId);
  const satellite = bundle.satellites[index];
  const plane = bundle.planes.find((item) => item.id === satellite.plane_id);
  const deployed = satellite.launch_batch <= bundle.design.launch_stage;
  const active = bundle.isActive(step, index);
  const status = !deployed ? "Ещё не выведен" : active ? "Активен" : "Недоступен";
  const isTracked = state.trackedSatelliteId === satelliteId;

  const track = bundle.track(state.clientId);
  const inRoute = track?.isRouted(step) && track.path(step).includes(index);
  const criticality = bundle.summary.criticality?.find((row) => row.satellite_id === satelliteId);
  const declaredOutage = bundle.failures.filter((item) => item.satellite_id === satelliteId);

  const visibleFrom = bundle.groundSites
    .filter((site) => bundle.isVisible(site.id, step, index))
    .map((site) => site.id);

  return `
    <div class="selection-eyebrow">
      <span>Аппарат · плоскость ${escapeHtml(satellite.plane_id)}</span>
      <span class="selection-status ${active ? "" : "danger"}">${status}</span>
    </div>
    <h1 class="inspector-title">${escapeHtml(satellite.id)}</h1>
    <p class="inspector-subtitle">Очередь запуска ${satellite.launch_batch} · слот ${decimal(satellite.slot_deg, 1)}°</p>

    <div class="selection-actions">
      <button class="button ${declaredOutage.length ? "button-subtle" : "button-primary"}"
              data-action="fail" data-satellite="${escapeHtml(satellite.id)}" type="button">
        ${declaredOutage.length ? "Убрать отказ" : "Задать отказ"}
      </button>
      <button class="button button-subtle ${isTracked ? "active" : ""}"
              data-action="track" data-satellite="${escapeHtml(satellite.id)}" type="button"
              aria-pressed="${isTracked}">${isTracked ? "Остановить слежение" : "Отслеживать"}</button>
    </div>

    <section class="compact-section"><h3>Параметры</h3><div class="detail-list">
      <div class="detail-row"><span>RAAN плоскости</span><strong>${decimal(plane.raan_deg, 1)}°</strong></div>
      <div class="detail-row"><span>Фазирование</span><strong>${decimal(plane.phase_deg, 1)}°</strong></div>
      <div class="detail-row"><span>Высота орбиты</span><strong>${decimal(bundle.environment.altitude_km, 0)} км</strong></div>
      <div class="detail-row"><span>Наклонение</span><strong>${decimal(bundle.environment.inclination_deg, 1)}°</strong></div>
    </div></section>

    <section class="compact-section"><h3>Состояние в ${clock(step * bundle.stepSeconds, true)}</h3><div class="detail-list">
      <div class="detail-row"><span>Участвует в маршруте</span><strong>${inRoute ? "да" : "нет"}</strong></div>
      <div class="detail-row"><span>Виден из пунктов</span><strong>${visibleFrom.length ? escapeHtml(visibleFrom.join(", ")) : "нет"}</strong></div>
      <div class="detail-row"><span>Связей с аппаратами</span><strong>${countIslFor(bundle, step, index)}</strong></div>
    </div></section>

    ${
      criticality
        ? `<section class="compact-section"><h3>Устойчивость</h3><div class="detail-list">
            <div class="detail-row"><span>Сеть держится только на нём</span><strong>${percent(criticality.critical_share_pct)}</strong></div>
            <div class="detail-row"><span>Затронутые пункты</span><strong>${escapeHtml(criticality.affected_clients.join(", "))}</strong></div>
          </div></section>`
        : ""
    }

    ${
      declaredOutage.length
        ? `<section class="compact-section"><h3>Заданные периоды недоступности</h3><div class="detail-list">${declaredOutage
            .map(
              (item) =>
                `<div class="detail-row"><span>${clock(item.start_s)} — ${clock(item.end_s)}</span><strong>${duration(
                  item.end_s - item.start_s
                )}</strong></div>`
            )
            .join("")}</div></section>`
        : ""
    }
    <p class="hint-note">Отказ добавляется в конфигурацию проекта. После нажатия «Пересчитать» маршруты и показатели будут построены заново.</p>`;
}

function countIslFor(bundle, step, satelliteIndex) {
  let total = 0;
  for (const pair of bundle.islPairs(step)) {
    if (bundle.pairI[pair] === satelliteIndex || bundle.pairJ[pair] === satelliteIndex) total += 1;
  }
  return total;
}

function planeMarkup(bundle, planeId) {
  const plane = bundle.planes.find((item) => item.id === planeId);
  if (!plane) return `<div class="empty-state">Плоскость не найдена</div>`;
  const members = bundle.satellites.filter((item) => item.plane_id === planeId);
  return `
    <div class="selection-eyebrow"><span>Орбитальная плоскость</span><span class="selection-status">В расчёте</span></div>
    <h1 class="inspector-title">Плоскость ${escapeHtml(plane.id)}</h1>
    <p class="inspector-subtitle">${members.length} аппаратов</p>
    <section class="compact-section"><h3>Конфигурация</h3><div class="detail-list">
      <div class="detail-row"><span>RAAN</span><strong>${decimal(plane.raan_deg, 1)}°</strong></div>
      <div class="detail-row"><span>Фазирование</span><strong>${decimal(plane.phase_deg, 1)}°</strong></div>
      <div class="detail-row"><span>Наклонение</span><strong>${decimal(bundle.environment.inclination_deg, 1)}°</strong></div>
      <div class="detail-row"><span>Очереди запуска</span><strong>${[...new Set(members.map((item) => item.launch_batch))].join(", ")}</strong></div>
    </div></section>
    <div class="selection-actions"><button class="button button-primary" data-action="edit-plane" type="button">Изменить ориентацию</button></div>
    <p class="hint-note">RAAN поворачивает всю плоскость вокруг Земли, фазирование сдвигает аппараты вдоль орбиты. Оба параметра меняются в разделе «Проект».</p>`;
}

function gatewayMarkup(bundle, gatewayId, step) {
  const site = bundle.gateways.find((item) => item.id === gatewayId);
  if (!site) return `<div class="empty-state">Шлюз не найден</div>`;
  const online = bundle.gatewayOnline.get(gatewayId)?.get(0, step) !== 0;
  const visible = bundle.visibleSatellites(gatewayId, step);
  const serving = bundle.clients.filter((client) => bundle.gatewayIdAt(client.id, step) === gatewayId);

  return `
    <div class="selection-eyebrow"><span>Наземный шлюз</span>
      <span class="selection-status ${online ? "" : "danger"}">${online ? "Доступен" : "Недоступен"}</span></div>
    <h1 class="inspector-title">${escapeHtml(site.name || site.id)}</h1>
    <p class="inspector-subtitle">${escapeHtml(site.id)} · ${coordinates(site.lat_deg, site.lon_deg)}</p>
    <section class="compact-section"><h3>Роль в сети</h3><div class="detail-list">
      <div class="detail-row"><span>Тип узла</span><strong>Выход в наземную сеть</strong></div>
      <div class="detail-row"><span>Видит аппаратов</span><strong>${visible.length}</strong></div>
      <div class="detail-row"><span>Обслуживает пунктов</span><strong>${serving.length} из ${bundle.clients.length}</strong></div>
    </div></section>
    <p class="hint-note">Шлюз — сток маршрута: данные в нём заканчиваются, дальше по спутниковой сети они не передаются.</p>`;
}

function causeText(_bundle, code) {
  return CAUSE_LABEL[code] ?? "маршрут отсутствует";
}

function causeTextByName(_bundle, name) {
  return CAUSE_LABEL_BY_NAME[name] ?? name;
}
