/** 2D-карта доли времени, когда из точки существует путь до шлюза. */

import { decimal, escapeHtml, percent } from "../format.js";
import { $, setModal } from "./shell.js";

let handlers = {};

export function initCoverage(callbacks) {
  handlers = callbacks;
  $("coverage-button").addEventListener("click", () => handlers.open?.());
}

export function openCoverage() {
  setModal("coverage-modal", true);
}

export function renderCoverage(state) {
  const host = $("coverage-content");
  const entry = state.coverage;
  if (!entry || entry.runId !== state.bundle?.runId) {
    host.innerHTML = `<div class="empty-state">Карта ещё не рассчитана</div>`;
    return;
  }
  const data = entry.data;
  host.innerHTML = `
    <div class="coverage-summary">
      <div><span>Минимум</span><strong>${percent(data.minimum_pct)}</strong></div>
      <div><span>Среднее</span><strong>${percent(data.mean_pct)}</strong></div>
      <div><span>Максимум</span><strong>${percent(data.maximum_pct)}</strong></div>
      <p>Каждая ячейка показывает долю расчётного периода, когда из неё существует
      сквозной маршрут через группировку до любого доступного шлюза.</p>
    </div>
    <div class="coverage-map" id="coverage-map">
      <canvas id="coverage-canvas" width="720" height="360" aria-label="Тепловая карта доступности"></canvas>
      <div class="coverage-tooltip" id="coverage-tooltip" hidden></div>
    </div>
    <div class="coverage-scale"><span>0%</span><i></i><span>50%</span><i></i><span>90%</span><i></i><span>100%</span></div>
    <p class="coverage-note">Сетка ${data.cell_deg}° × ${data.cell_deg}°. Карта показывает доступность маршрута,
    а не только геометрическую видимость спутника; стратегия маршрутизации на факт наличия пути не влияет.</p>`;
  drawMap(state, data);
}

function drawMap(state, data) {
  const canvas = $("coverage-canvas");
  const context = canvas.getContext("2d");
  const columns = data.longitudes.length;
  const rows = data.latitudes.length;
  const cellWidth = canvas.width / columns;
  const cellHeight = canvas.height / rows;

  context.clearRect(0, 0, canvas.width, canvas.height);
  for (let latIndex = 0; latIndex < rows; latIndex += 1) {
    for (let lonIndex = 0; lonIndex < columns; lonIndex += 1) {
      const value = data.availability_pct[latIndex * columns + lonIndex];
      context.fillStyle = coverageColor(value);
      context.fillRect(
        lonIndex * cellWidth,
        (rows - latIndex - 1) * cellHeight,
        cellWidth + 0.5,
        cellHeight + 0.5
      );
    }
  }

  context.font = "bold 10px Inter, sans-serif";
  for (const site of state.bundle.groundSites) {
    const x = ((site.lon_deg + 180) / 360) * canvas.width;
    const y = ((90 - site.lat_deg) / 180) * canvas.height;
    context.beginPath();
    context.arc(x, y, site.role === "gateway" ? 5 : 4, 0, Math.PI * 2);
    context.fillStyle = site.role === "gateway" ? "#ffc75c" : "#ffffff";
    context.fill();
    context.strokeStyle = "#07101e";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = "#ffffff";
    context.fillText(site.id, x + 7, y - 6);
  }

  const tooltip = $("coverage-tooltip");
  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const lonIndex = Math.max(0, Math.min(columns - 1, Math.floor(((event.clientX - rect.left) / rect.width) * columns)));
    const visualRow = Math.max(0, Math.min(rows - 1, Math.floor(((event.clientY - rect.top) / rect.height) * rows)));
    const latIndex = rows - visualRow - 1;
    const value = data.availability_pct[latIndex * columns + lonIndex];
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${percent(value)}</strong><span>${decimal(data.latitudes[latIndex], 0)}° · ${decimal(data.longitudes[lonIndex], 0)}°</span>`;
    tooltip.style.left = `${Math.min(event.clientX - rect.left + 12, rect.width - 108)}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 46)}px`;
  });
  canvas.addEventListener("mouseleave", () => { tooltip.hidden = true; });
}

function coverageColor(value) {
  const hue = Math.max(0, Math.min(165, value * 1.65));
  const alpha = value < 1 ? 0.72 : 0.56;
  return `hsla(${hue}, 82%, 52%, ${alpha})`;
}
