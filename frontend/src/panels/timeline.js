/** Нижняя панель: масштабируемая шкала времени и диаграмма доступности. */

import { clock, decimal, escapeHtml, percent } from "../format.js";
import { CAUSE_LABEL, STATE_CLASS } from "../model/bundle.js";
import { $ } from "./shell.js";

const ZOOM_FACTORS = [1, 2, 4, 8, 12, 24];

let handlers = {};
let latestState = null;
let zoomIndex = 0;
let windowStart = 0;

export function initTimeline(callbacks) {
  handlers = callbacks;

  $("time-range").addEventListener("input", (event) =>
    handlers.setTime?.(Number(event.target.value))
  );
  $("play-button").addEventListener("click", () => handlers.togglePlay?.());
  $("speed-select").addEventListener("change", (event) =>
    handlers.setSpeed?.(Number(event.target.value))
  );
  $("timeline-zoom-in").addEventListener("click", () => changeZoom(1));
  $("timeline-zoom-out").addEventListener("click", () => changeZoom(-1));
  $("timeline-zoom-range").addEventListener("input", (event) =>
    setZoom(Number(event.target.value))
  );
  $("timeline-zoom-reset").addEventListener("click", resetZoom);
  $("timeline-pan-prev").addEventListener("click", () => panWindow(-1));
  $("timeline-pan-next").addEventListener("click", () => panWindow(1));
}

/** Перестроить дорожки при смене расчёта или видимого окна. */
export function renderTimeline(state) {
  latestState = state;
  const bundle = state.bundle;
  const host = $("availability-lanes");
  if (!bundle) {
    host.innerHTML = `<div class="empty-state">Нет данных расчёта</div>`;
    return;
  }

  keepTimeVisible(bundle, state.timeSeconds);
  const view = visibleWindow(bundle);
  const range = $("time-range");
  range.min = String(view.start);
  range.max = String(Math.max(view.start, view.end - bundle.stepSeconds));
  range.step = String(bundle.stepSeconds);
  $("step-info").textContent = `Шаг расчёта: ${bundle.stepSeconds} с · ${bundle.stepCount} отсчётов`;
  updateZoomControls(bundle, view);

  $("time-axis").innerHTML = Array.from({ length: 5 }, (_, index) => {
    const seconds = view.start + (view.span / 4) * index;
    return `<span>${clock(Math.min(bundle.horizonSeconds - 1, seconds))}</span>`;
  }).join("");

  host.innerHTML = bundle.clients
    .map((client) => {
      const track = bundle.track(client.id);
      const metrics = track.metrics;
      const segments = track
        .segments()
        .map((segment) => renderSegment(segment, bundle, view))
        .filter(Boolean)
        .join("");
      return `
        <div class="availability-lane ${client.id === state.clientId ? "active" : ""} ${
          metrics.target_met ? "" : "below"
        }" data-client="${client.id}">
          <span title="${escapeHtml(client.name)}">${client.id}</span>
          <div class="lane-track" data-lane="${client.id}" title="Максимальный перерыв ${decimal(
            metrics.max_gap_s / 60,
            0
          )} мин">${segments}<i class="lane-cursor"></i></div>
          <strong>${percent(metrics.availability_pct)}</strong>
        </div>`;
    })
    .join("");

  host.querySelectorAll("[data-client]").forEach((lane) => {
    lane.querySelector("span").addEventListener("click", () =>
      handlers.selectClient?.(lane.dataset.client)
    );
  });
  host.querySelectorAll("[data-lane]").forEach((track) => {
    track.addEventListener("click", (event) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const seconds = view.start + ratio * view.span;
      const step = Math.min(bundle.stepCount - 1, Math.floor(seconds / bundle.stepSeconds));
      handlers.selectClient?.(track.dataset.lane);
      handlers.setTime?.(step * bundle.stepSeconds);
    });
  });

  updateTimeUI(state);
}

function renderSegment(segment, bundle, view) {
  const segmentStart = segment.start * bundle.stepSeconds;
  const segmentEnd = segment.end * bundle.stepSeconds;
  const visibleStart = Math.max(segmentStart, view.start);
  const visibleEnd = Math.min(segmentEnd, view.end);
  if (visibleEnd <= visibleStart) return "";
  const left = ((visibleStart - view.start) / view.span) * 100;
  const width = ((visibleEnd - visibleStart) / view.span) * 100;
  return `<i class="lane-segment ${STATE_CLASS[segment.state]} cause-${segment.cause}"
            title="${escapeHtml(CAUSE_LABEL[segment.cause])}: ${clock(segmentStart)}–${clock(segmentEnd)}"
            style="left:${left}%;width:${width}%"></i>`;
}

/** Лёгкое обновление курсора, безопасное для вызова каждый кадр. */
export function updateTimeUI(state) {
  latestState = state;
  const bundle = state.bundle;
  const seconds = state.timeSeconds;
  $("scene-time").textContent = clock(seconds);
  $("timeline-time").textContent = clock(seconds, true);
  $("play-button").textContent = state.playing ? "Ⅱ" : "▶";

  if (!bundle) return;
  const before = windowStart;
  keepTimeVisible(bundle, seconds);
  if (before !== windowStart && zoomIndex > 0) {
    renderTimeline(state);
    return;
  }

  const view = visibleWindow(bundle);
  const range = $("time-range");
  const aligned = Math.floor(seconds / bundle.stepSeconds) * bundle.stepSeconds;
  if (document.activeElement !== range) range.value = String(aligned);

  const ratio = ((seconds - view.start) / view.span) * 100;
  document.querySelectorAll(".lane-cursor").forEach((cursor) => {
    cursor.hidden = ratio < 0 || ratio > 100;
    cursor.style.left = `${Math.max(0, Math.min(100, ratio))}%`;
  });
}

function visibleWindow(bundle) {
  const horizon = bundle.horizonSeconds;
  const factor = ZOOM_FACTORS[zoomIndex];
  const desired = horizon / factor;
  const span = Math.min(
    horizon,
    Math.max(bundle.stepSeconds * 5, Math.ceil(desired / bundle.stepSeconds) * bundle.stepSeconds)
  );
  const maximumStart = Math.max(0, horizon - span);
  windowStart = Math.max(0, Math.min(maximumStart, align(windowStart, bundle.stepSeconds)));
  return { start: windowStart, end: windowStart + span, span, maximumStart };
}

function keepTimeVisible(bundle, seconds) {
  const view = visibleWindow(bundle);
  if (zoomIndex === 0) {
    windowStart = 0;
    return;
  }
  if (seconds < view.start || seconds >= view.end) {
    windowStart = Math.max(
      0,
      Math.min(view.maximumStart, align(seconds - view.span / 2, bundle.stepSeconds))
    );
  }
}

function changeZoom(direction) {
  if (!latestState?.bundle) return;
  setZoom(zoomIndex + direction);
}

function setZoom(value) {
  if (!latestState?.bundle) return;
  const next = Math.max(0, Math.min(ZOOM_FACTORS.length - 1, Math.round(value)));
  if (next === zoomIndex) return;
  const center = latestState.timeSeconds;
  zoomIndex = next;
  const view = visibleWindow(latestState.bundle);
  windowStart = Math.max(0, Math.min(view.maximumStart, align(center - view.span / 2, latestState.bundle.stepSeconds)));
  renderTimeline(latestState);
}

function resetZoom() {
  if (!latestState?.bundle) return;
  zoomIndex = 0;
  windowStart = 0;
  renderTimeline(latestState);
}

function panWindow(direction) {
  if (!latestState?.bundle || zoomIndex === 0) return;
  const bundle = latestState.bundle;
  const view = visibleWindow(bundle);
  const shift = align(view.span * 0.8, bundle.stepSeconds);
  windowStart = Math.max(0, Math.min(view.maximumStart, windowStart + direction * shift));
  const targetTime = Math.min(bundle.horizonSeconds - bundle.stepSeconds, windowStart + view.span / 2);
  handlers.setTime?.(align(targetTime, bundle.stepSeconds));
  renderTimeline(latestState);
}

function updateZoomControls(bundle, view) {
  $("timeline-zoom-out").disabled = zoomIndex === 0;
  $("timeline-zoom-in").disabled = zoomIndex === ZOOM_FACTORS.length - 1;
  $("timeline-zoom-reset").disabled = zoomIndex === 0;
  $("timeline-pan-prev").disabled = zoomIndex === 0 || view.start <= 0;
  $("timeline-pan-next").disabled = zoomIndex === 0 || view.start >= view.maximumStart;
  $("timeline-zoom-range").value = String(zoomIndex);
  $("timeline-zoom-label").textContent = formatSpan(view.span);
  $("timeline-zoom-label").title = `Видимый интервал: ${formatSpan(view.span)} из ${formatSpan(bundle.horizonSeconds)}`;
}

function formatSpan(seconds) {
  if (seconds >= 3600) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : decimal(hours, 1)} ч`;
  }
  return `${Math.round(seconds / 60)} мин`;
}

function align(seconds, stepSeconds) {
  return Math.round(seconds / stepSeconds) * stepSeconds;
}

/** Сводка над сценой: активные аппараты и число связей на отсчёте. */
export function updateSceneSummary(state) {
  const bundle = state.bundle;
  if (!bundle) return;
  const step = bundle.stepAt(state.timeSeconds);
  const track = bundle.track(state.clientId);
  const routed = track?.isRouted(step);
  const visibilitySiteId = ["client", "gateway"].includes(state.selection?.type)
    ? state.selection.id
    : null;
  const visibleCount = visibilitySiteId
    ? bundle.visibleSatellites(visibilitySiteId, step).length
    : 0;
  const visibilityLegend = $("visibility-legend");
  visibilityLegend.hidden = !visibilitySiteId;
  $("scene-summary").innerHTML = `
    <span><strong>${bundle.activeCounts[step]}</strong> активны</span><i></i>
    <span><strong>${bundle.linkCounts[step]}</strong> связей</span><i></i>
    ${visibilitySiteId ? `<span><strong>${visibleCount}</strong> видно из ${escapeHtml(visibilitySiteId)}</span><i></i>` : ""}
    <span><strong>${routed ? track.hops[step] : "—"}</strong> переходов</span><i></i>
    <span><strong>${routed ? decimal(track.latencyMs[step], 1) : "—"}</strong> мс</span>`;
}
