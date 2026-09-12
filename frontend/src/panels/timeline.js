/**
 * Нижняя панель: шкала времени и диаграмма доступности.
 *
 * Дорожки строятся из реальных состояний каждого отсчёта, поэтому по ним
 * видно не только «сколько процентов», но и где именно связь пропадала.
 * Клик по дорожке переводит время в выбранный момент.
 */

import { clock, decimal, percent } from "../format.js";
import { STATE_CLASS } from "../model/bundle.js";
import { $ } from "./shell.js";

let handlers = {};

export function initTimeline(callbacks) {
  handlers = callbacks;

  $("time-range").addEventListener("input", (event) =>
    handlers.setTime?.(Number(event.target.value))
  );
  $("play-button").addEventListener("click", () => handlers.togglePlay?.());
  $("speed-select").addEventListener("change", (event) =>
    handlers.setSpeed?.(Number(event.target.value))
  );
}

/** Перестроить дорожки. Вызывается при смене расчёта, не каждый кадр. */
export function renderTimeline(state) {
  const bundle = state.bundle;
  const host = $("availability-lanes");
  if (!bundle) {
    host.innerHTML = `<div class="empty-state">Нет данных расчёта</div>`;
    return;
  }

  const horizon = bundle.horizonSeconds;
  const range = $("time-range");
  range.min = "0";
  range.max = String(horizon - bundle.stepSeconds);
  range.step = String(bundle.stepSeconds);
  $("step-info").textContent = `Шаг расчёта: ${bundle.stepSeconds} с · ${bundle.stepCount} отсчётов`;

  $("time-axis").innerHTML = Array.from({ length: 5 }, (_, index) => {
    const seconds = (horizon / 4) * index;
    return `<span>${clock(seconds === horizon ? horizon - 1 : seconds)}</span>`;
  }).join("");

  host.innerHTML = bundle.clients
    .map((client) => {
      const track = bundle.track(client.id);
      const metrics = track.metrics;
      const segments = track
        .segments()
        .map((segment) => {
          const left = (segment.start / bundle.stepCount) * 100;
          const width = ((segment.end - segment.start) / bundle.stepCount) * 100;
          return `<i class="lane-segment ${STATE_CLASS[segment.state]}" style="left:${left}%;width:${width}%"></i>`;
        })
        .join("");
      return `
        <div class="availability-lane ${client.id === state.clientId ? "active" : ""} ${
          metrics.target_met ? "" : "below"
        }" data-client="${client.id}">
          <span title="${client.name}">${client.id}</span>
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
      const step = Math.min(bundle.stepCount - 1, Math.floor(ratio * bundle.stepCount));
      handlers.selectClient?.(track.dataset.lane);
      handlers.setTime?.(step * bundle.stepSeconds);
    });
  });

  updateTimeUI(state);
}

/** Лёгкое обновление, безопасное для вызова каждый кадр. */
export function updateTimeUI(state) {
  const bundle = state.bundle;
  const seconds = state.timeSeconds;
  $("scene-time").textContent = clock(seconds);
  $("timeline-time").textContent = clock(seconds, true);
  $("play-button").textContent = state.playing ? "Ⅱ" : "▶";

  if (!bundle) return;
  const range = $("time-range");
  const aligned = Math.floor(seconds / bundle.stepSeconds) * bundle.stepSeconds;
  if (document.activeElement !== range) range.value = String(aligned);

  const ratio = (seconds / bundle.horizonSeconds) * 100;
  document.querySelectorAll(".lane-cursor").forEach((cursor) => {
    cursor.style.left = `${ratio}%`;
  });
}

/** Сводка над сценой: активные аппараты и число связей на отсчёте. */
export function updateSceneSummary(state) {
  const bundle = state.bundle;
  if (!bundle) return;
  const step = bundle.stepAt(state.timeSeconds);
  const track = bundle.track(state.clientId);
  const routed = track?.isRouted(step);
  $("scene-summary").innerHTML = `
    <span><strong>${bundle.activeCounts[step]}</strong> активны</span><i></i>
    <span><strong>${bundle.linkCounts[step]}</strong> связей</span><i></i>
    <span><strong>${routed ? track.hops[step] : "—"}</strong> переходов</span><i></i>
    <span><strong>${routed ? decimal(track.latencyMs[step], 1) : "—"}</strong> мс</span>`;
}
