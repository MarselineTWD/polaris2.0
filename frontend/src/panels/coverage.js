/** Плоская карта мира с текущими положениями аппаратов и линиями связи. */

import { decimal, escapeHtml } from "../format.js";
import { OrbitModel } from "../model/orbit.js";
import { $ } from "./shell.js";

let handlers = {};
let model = null;
let modelBundle = null;
let hitTargets = [];
let resizeObserver = null;

export function initCoverage(callbacks) {
  handlers = callbacks;
  document.querySelectorAll("[data-view-mode]").forEach((button) => {
    button.addEventListener("click", () => handlers.changeMode?.(button.dataset.viewMode));
  });
}

export function setCoverageMode(state, mode) {
  const is2d = mode === "2d";
  $("space-view").classList.toggle("mode-2d", is2d);
  $("coverage-view").hidden = !is2d;
  document.querySelectorAll("[data-view-mode]").forEach((button) => {
    const active = button.dataset.viewMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (is2d) updateCoverageTime(state);
}

export function renderCoverage(state) {
  const host = $("coverage-content");
  if (!state.bundle) {
    host.innerHTML = `<div class="empty-state">Нет данных расчёта</div>`;
    return;
  }

  host.innerHTML = `
    <div class="coverage-map" id="coverage-map">
      <canvas id="coverage-canvas" aria-label="Карта мира, положения спутников и линии связи"></canvas>
      <div class="coverage-tooltip" id="coverage-tooltip" hidden></div>
    </div>
    <div class="coverage-caption">
      <div class="coverage-scale" aria-label="Условные обозначения">
        <span><i class="network-key"></i>межспутниковая связь</span>
        <span><i class="route-key"></i>выбранный маршрут</span>
        <span><i class="ground-key"></i>наземный участок</span>
        <span><i class="satellite-key"></i>спутник</span>
        <span><i class="satellite-key failed-key"></i>недоступен</span>
      </div>
      <p class="coverage-note">Карта показывает состояние сети в выбранный момент. Спутники и связи движутся синхронно с 3D-глобусом.</p>
    </div>`;

  const canvas = $("coverage-canvas");
  canvas.addEventListener("mousemove", showTooltip);
  canvas.addEventListener("mouseleave", () => { $("coverage-tooltip").hidden = true; });
  canvas.addEventListener("click", (event) => {
    const target = nearestSatellite(canvas, event);
    if (target) handlers.selectSatellite?.(target.id);
  });
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => updateCoverageTime(state));
  resizeObserver.observe($("coverage-map"));
  updateCoverageTime(state);
}

export function updateCoverageTime(state) {
  const canvas = $("coverage-canvas");
  if (state.viewMode !== "2d" || !canvas || !state.bundle) return;
  if (modelBundle !== state.bundle) {
    modelBundle = state.bundle;
    model = new OrbitModel(state.bundle);
  }
  drawMap(state, canvas);
}

function drawMap(state, canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);

  drawGrid(context, width, height, ratio);

  const bundle = state.bundle;
  const step = bundle.stepAt(state.timeSeconds);
  const positions = model.propagate(state.timeSeconds);
  const earthAngle = model.earthAngle(state.timeSeconds);
  const cos = Math.cos(earthAngle);
  const sin = Math.sin(earthAngle);
  const satellitePoints = bundle.satellites.map((satellite, index) => {
    const offset = index * 3;
    const fixedX = cos * positions[offset] + sin * positions[offset + 1];
    const fixedY = -sin * positions[offset] + cos * positions[offset + 1];
    const fixedZ = positions[offset + 2];
    const radius = Math.hypot(fixedX, fixedY, fixedZ);
    const latitude = Math.asin(fixedZ / radius) * 180 / Math.PI;
    const longitude = Math.atan2(fixedY, fixedX) * 180 / Math.PI;
    return {
      ...project(longitude, latitude, width, height),
      id: satellite.id,
      index,
      active: bundle.isActive(step, index),
      latitude,
      longitude,
    };
  });

  const track = bundle.track(state.clientId);
  const routeIndices = track?.path(step) || [];
  const routeSet = new Set(routeIndices);

  // Вся действующая межспутниковая сеть остаётся тонкой и полупрозрачной.
  for (const pairIndex of bundle.islPairs(step)) {
    const first = satellitePoints[bundle.pairI[pairIndex]];
    const second = satellitePoints[bundle.pairJ[pairIndex]];
    if (first && second) drawWrappedLine(context, first, second, width, "rgba(104, 169, 224, .27)", 0.75 * ratio);
  }

  // Текущий сквозной маршрут выделен поверх сети.
  for (let index = 1; index < routeIndices.length; index += 1) {
    drawWrappedLine(
      context,
      satellitePoints[routeIndices[index - 1]],
      satellitePoints[routeIndices[index]],
      width,
      "rgba(49, 255, 196, .32)",
      6 * ratio
    );
    drawWrappedLine(
      context,
      satellitePoints[routeIndices[index - 1]],
      satellitePoints[routeIndices[index]],
      width,
      "rgba(113, 255, 220, 1)",
      2.6 * ratio
    );
  }

  const sitePoints = new Map(bundle.groundSites.map((site) => [site.id, { ...project(site.lon_deg, site.lat_deg, width, height), site }]));
  if (routeIndices.length) {
    const clientPoint = sitePoints.get(state.clientId);
    const gatewayPoint = sitePoints.get(bundle.gatewayIdAt(state.clientId, step));
    if (clientPoint) drawWrappedLine(context, clientPoint, satellitePoints[routeIndices[0]], width, "rgba(255, 199, 92, .98)", 2 * ratio, [4 * ratio, 3 * ratio]);
    if (gatewayPoint) drawWrappedLine(context, satellitePoints[routeIndices.at(-1)], gatewayPoint, width, "rgba(255, 199, 92, .98)", 2 * ratio, [4 * ratio, 3 * ratio]);
  }

  drawGroundSites(context, sitePoints, ratio);

  hitTargets = [];
  for (const point of satellitePoints) {
    const selected = state.selection?.type === "satellite" && state.selection.id === point.id;
    const routed = routeSet.has(point.index);
    const size = (selected ? 6 : routed ? 5 : 3.2) * ratio;
    context.beginPath();
    context.arc(point.x, point.y, size, 0, Math.PI * 2);
    context.fillStyle = !point.active ? "#ff5d7d" : routed ? "#54efc7" : "#6fd6ff";
    context.shadowColor = context.fillStyle;
    context.shadowBlur = selected || routed ? 12 * ratio : 5 * ratio;
    context.fill();
    context.shadowBlur = 0;
    if (selected) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 1.5 * ratio;
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = `600 ${10 * ratio}px Inter, sans-serif`;
      context.fillText(point.id, point.x + 8 * ratio, point.y - 7 * ratio);
    }
    hitTargets.push({ ...point, x: point.x / ratio, y: point.y / ratio });
  }
}

function drawGrid(context, width, height, ratio) {
  context.save();
  context.strokeStyle = "rgba(180, 210, 240, .14)";
  context.lineWidth = ratio;
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = ((lon + 180) / 360) * width;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * height;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  context.restore();
}

function drawGroundSites(context, sitePoints, ratio) {
  context.font = `${10 * ratio}px Inter, sans-serif`;
  for (const { x, y, site } of sitePoints.values()) {
    context.beginPath();
    context.arc(x, y, (site.role === "gateway" ? 5 : 4) * ratio, 0, Math.PI * 2);
    context.fillStyle = site.role === "gateway" ? "#ffc75c" : "#ffffff";
    context.fill();
    context.strokeStyle = "#07101e";
    context.lineWidth = 2 * ratio;
    context.stroke();
    context.fillStyle = "#ffffff";
    context.fillText(site.id, x + 7 * ratio, y - 6 * ratio);
  }
}

function project(longitude, latitude, width, height) {
  return {
    x: ((longitude + 180) / 360) * width,
    y: ((90 - latitude) / 180) * height,
  };
}

function drawWrappedLine(context, first, second, mapWidth, color, lineWidth, dash = []) {
  if (!first || !second) return;
  let firstX = first.x;
  let secondX = second.x;
  if (Math.abs(secondX - firstX) > mapWidth / 2) {
    if (firstX < secondX) firstX += mapWidth;
    else secondX += mapWidth;
  }
  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.setLineDash(dash);
  for (const shift of [-mapWidth, 0, mapWidth]) {
    context.beginPath();
    context.moveTo(firstX + shift, first.y);
    context.lineTo(secondX + shift, second.y);
    context.stroke();
  }
  context.restore();
}

function nearestSatellite(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let best = null;
  // Маркер намеренно компактный, а зона взаимодействия крупнее: так аппарат
  // можно уверенно выбрать мышью и пальцем, не превращая карту в россыпь точек.
  let distance = 18;
  for (const target of hitTargets) {
    const candidate = Math.hypot(target.x - x, target.y - y);
    if (candidate < distance) { best = target; distance = candidate; }
  }
  return best;
}

function showTooltip(event) {
  const canvas = $("coverage-canvas");
  const tooltip = $("coverage-tooltip");
  const rect = canvas.getBoundingClientRect();
  const satellite = nearestSatellite(canvas, event);
  if (satellite) {
    tooltip.innerHTML = `<strong>${escapeHtml(satellite.id)}</strong><span>${satellite.active ? "активен" : "недоступен"} · ${decimal(satellite.latitude, 1)}°, ${decimal(satellite.longitude, 1)}°</span>`;
    canvas.style.cursor = "pointer";
  } else {
    const longitude = ((event.clientX - rect.left) / rect.width) * 360 - 180;
    const latitude = 90 - ((event.clientY - rect.top) / rect.height) * 180;
    tooltip.innerHTML = `<strong>Карта мира</strong><span>${decimal(latitude, 1)}°, ${decimal(longitude, 1)}°</span>`;
    canvas.style.cursor = "crosshair";
  }
  tooltip.hidden = false;
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  tooltip.style.left = `${Math.max(8, Math.min(localX + 12, rect.width - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(localY + 12, rect.height - tooltip.offsetHeight - 8))}px`;
}
