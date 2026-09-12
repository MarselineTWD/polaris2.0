/** Представление инженерной верификации внутри окна «Анализ». */

import { decimal, duration, escapeHtml, percent } from "../format.js";
import { $ } from "./shell.js";

const SOURCE_TONE = {
  ready: ["ok", "готов"],
  stale: ["warn", "устарел"],
  fallback: ["bad", "fallback"],
  not_applicable: ["muted", "не применяется"],
  requires_auth: ["muted", "нужен доступ"],
};

export function researchSection(state) {
  const model = state.research || {};
  const result = model.result;
  const selected = result?.profiles?.find((item) => item.id === model.selectedProfile)
    || result?.profiles?.find((item) => item.id === "nominal")
    || result?.profiles?.[0];
  return `
    <div class="research-workbench">
      <div class="research-notice">
        <span>ИССЛЕДОВАТЕЛЬСКИЙ РЕЖИМ</span>
        <div><strong>Результат — диапазон, а не паспорт системы</strong>
        <p>Орбита, атмосфера и энергетика линий считаются отдельно от быстрого режима ТЗ.
        Параметры оборудования помечены как модельные предположения.</p></div>
      </div>

      ${sourceSection(model.externalStatus, model.loadingSources)}
      ${controlsSection(model, result)}
      ${profileCards(model.profiles, model.selectedProfile, result)}
      ${result ? resultSection(result, selected, model) : emptyResult()}
    </div>`;
}

export function bindResearch(state, handlers) {
  $("refresh-research-data")?.addEventListener("click", () => handlers.refreshExternal?.());
  $("run-research")?.addEventListener("click", () => handlers.runResearch?.());
  $("export-research")?.addEventListener("click", () => handlers.exportResearch?.());
  document.querySelectorAll("[data-research-mode]").forEach((button) =>
    button.addEventListener("click", () => handlers.setResearchMode?.(button.dataset.researchMode))
  );
  document.querySelectorAll("[data-research-profile]").forEach((button) =>
    button.addEventListener("click", () => handlers.selectResearchProfile?.(button.dataset.researchProfile))
  );
  $("toggle-hazards")?.addEventListener("change", (event) =>
    handlers.toggleResearchHazards?.(event.currentTarget.checked)
  );
  document.querySelectorAll("[data-hazard-scenario]").forEach((button) =>
    button.addEventListener("click", () => handlers.createHazardScenario?.(button.dataset.hazardScenario))
  );
}

function sourceSection(status, loading) {
  const sources = status?.sources || [];
  return `
    <section class="research-section source-section">
      <div class="research-section-head">
        <div><h3>Зафиксированные данные</h3>
        <p>Расчёт читает только локальные снимки. Обращение в интернет происходит по кнопке.</p></div>
        <button class="button button-subtle" id="refresh-research-data" type="button" ${loading ? "disabled" : ""}>
          ${loading ? "Обновляем…" : "↻ Обновить данные"}
        </button>
      </div>
      <div class="source-grid">
        ${sources.length ? sources.map(sourceCard).join("") : sourceSkeletons()}
      </div>
    </section>`;
}

function sourceCard(source) {
  const [tone, label] = SOURCE_TONE[source.status] || ["muted", source.status || "—"];
  const date = source.retrieved_at ? new Date(source.retrieved_at).toLocaleString("ru-RU") : "локальная модель";
  return `<article class="source-card ${tone}">
    <div><strong>${escapeHtml(source.label)}</strong><span class="badge ${tone}">${escapeHtml(label)}</span></div>
    <p>${escapeHtml(source.detail || "")}</p>
    <small>${escapeHtml(date)}${source.records != null ? ` · ${source.records} записей` : ""}</small>
  </article>`;
}

function sourceSkeletons() {
  return Array.from({ length: 4 }, () => `<div class="source-card skeleton"><i></i><i></i></div>`).join("");
}

function controlsSection(model, result) {
  const mode = model.linkMode || "hybrid";
  return `
    <section class="research-section research-controls">
      <div>
        <h3>Тип межспутниковых терминалов</h3>
        <div class="engineering-segmented" role="group" aria-label="Тип межспутниковых линий">
          ${[["rf", "RF · 26 GHz"], ["optical", "Optical · 1550 нм"], ["hybrid", "Гибрид"]]
            .map(([value, label]) => `<button data-research-mode="${value}" class="${mode === value ? "active" : ""}" type="button">${label}</button>`)
            .join("")}
        </div>
      </div>
      <div class="research-run-actions">
        ${result ? `<button class="button button-subtle" id="export-research" type="button">↓ Экспорт паспорта</button>` : ""}
        <button class="button button-primary" id="run-research" type="button">▶ Запустить верификацию</button>
      </div>
    </section>`;
}

function profileCards(profiles, selectedId, result) {
  const list = profiles?.profiles || [];
  if (!list.length) return "";
  return `<div class="engineering-profile-grid">
    ${list.map((profile) => {
      const outcome = result?.profiles?.find((item) => item.id === profile.id);
      const client = profile.client;
      const isl = profile.rf_isl;
      return `<button class="engineering-profile ${selectedId === profile.id ? "selected" : ""}" data-research-profile="${profile.id}" type="button">
        <span class="assumption-chip">МОДЕЛЬ</span>
        <strong>${escapeHtml(profile.label)}</strong>
        <p>${escapeHtml(profile.description)}</p>
        <dl><div><dt>Ku downlink EIRP</dt><dd>${decimal(client.downlink.eirp_dbw, 0)} dBW</dd></div>
        <div><dt>RF ISL EIRP</dt><dd>${decimal(isl.eirp_dbw, 0)} dBW</dd></div>
        <div><dt>Терминалов ISL</dt><dd>${isl.terminals}</dd></div></dl>
        ${outcome ? `<em>${percent(outcome.availability.min_pct)} минимум</em>` : ""}
      </button>`;
    }).join("")}
  </div>`;
}

function emptyResult() {
  return `<div class="engineering-empty">
    <div class="engineering-orbit-icon">◎</div>
    <strong>Инженерная верификация ещё не запускалась</strong>
    <p>Без обновления источников расчёт тоже запустится: будет использована сухая атмосфера,
    встроенные профили и доступная локальная орбитальная модель. Все подмены попадут в отчёт.</p>
  </div>`;
}

function resultSection(result, selected, model) {
  const range = result.availability_range;
  const fast = result.fast_baseline;
  return `
    <section class="engineering-result">
      <div class="range-hero">
        <div><span>ДИАПАЗОН МИНИМАЛЬНОЙ ДОСТУПНОСТИ</span>
        <strong>${decimal(range.min_pct)}–${percent(range.max_pct)}</strong>
        <p>Номинальный профиль: ${range.nominal_pct == null ? "—" : percent(range.nominal_pct)}</p></div>
        <div class="model-compare-mini">
          <span>Быстрый режим <b>${percent(fast.min_availability_pct)}</b></span>
          <i>→</i>
          <span>Инженерный <b>${range.nominal_pct == null ? "—" : percent(range.nominal_pct)}</b></span>
        </div>
      </div>
      <div class="engineering-warning">${escapeHtml(result.classification)}. Не эксплуатационный и не сертификационный результат.</div>
      ${selected ? selectedProfileSection(selected) : ""}
      ${eventSection(result.events || [])}
      ${hazardSection(result.hazards, model.hazardsVisible)}
      ${assumptionSection(result)}
    </section>`;
}

function selectedProfileSection(profile) {
  const clients = profile.clients || [];
  const passport = profile.line_passport;
  const causes = Object.entries(profile.cause_totals_s || {}).sort((a, b) => b[1] - a[1]);
  return `
    <div class="research-two-column">
      <section class="research-section">
        <h3>${escapeHtml(profile.label)} профиль · пункты</h3>
        <div class="table-scroll"><table class="data-table"><thead><tr>
          <th>Пункт</th><th>Доступность</th><th>Макс. перерыв</th><th>Запас</th><th>Задержка</th>
        </tr></thead><tbody>${clients.map((client) => `<tr>
          <td><strong>${escapeHtml(client.id)}</strong><small>${escapeHtml(client.name)}</small></td>
          <td class="${client.availability_pct >= 90 ? "good" : "bad"}">${percent(client.availability_pct)}</td>
          <td>${duration(client.max_gap_s)}</td>
          <td>${client.mean_margin_db == null ? "—" : `${decimal(client.mean_margin_db)} dB`}</td>
          <td>${client.mean_latency_ms == null ? "—" : `${decimal(client.mean_latency_ms)} мс`}</td>
        </tr>`).join("")}</tbody></table></div>
        <div class="engineering-cause-list">${causes.length ? causes.map(([cause, seconds]) =>
          `<span><i class="cause-${escapeHtml(cause)}"></i>${escapeHtml(causeLabel(cause))}<b>${duration(seconds)}</b></span>`
        ).join("") : `<span>Перерывов нет</span>`}</div>
      </section>
      ${passportSection(passport)}
    </div>`;
}

function passportSection(item) {
  if (!item) return `<section class="research-section"><h3>Паспорт линии</h3><div class="empty-state">Доступной линии для паспорта нет</div></section>`;
  return `<section class="research-section link-passport">
    <div class="research-section-head"><div><h3>Паспорт худшего звена</h3><p>${escapeHtml(item.endpoints.join(" → "))} · ${escapeHtml(item.frequency)}</p></div><span class="margin-chip">${decimal(item.margin_db)} dB</span></div>
    <div class="loss-stack">
      ${lossRow("FSPL", item.fspl_db, Math.min(100, item.fspl_db / 2.8))}
      ${lossRow("Атмосфера", item.atmosphere_db, Math.min(100, item.atmosphere_db * 8))}
      ${lossRow("Наведение", item.pointing_db, Math.min(100, item.pointing_db * 12))}
    </div>
    <dl class="passport-grid">
      <div><dt>Дальность</dt><dd>${decimal(item.distance_km)} км</dd></div>
      <div><dt>Doppler</dt><dd>${decimal(Math.abs(item.doppler_hz) / 1000, 0)} кГц</dd></div>
      <div><dt>Uplink margin</dt><dd>${decimal(item.uplink_margin_db)} dB</dd></div>
      <div><dt>Downlink margin</dt><dd>${decimal(item.downlink_margin_db)} dB</dd></div>
      <div><dt>C/N0 up · down</dt><dd>${optionalDb(item.uplink_cn0_dbhz)} · ${optionalDb(item.downlink_cn0_dbhz)} dBHz</dd></div>
      <div><dt>Eb/N0 up · down</dt><dd>${optionalDb(item.uplink_ebn0_db)} · ${optionalDb(item.downlink_ebn0_db)} dB</dd></div>
      <div><dt>Момент</dt><dd>${formatClock(item.t_s)}</dd></div>
      <div><dt>Тип</dt><dd>${escapeHtml(item.type)}</dd></div>
    </dl>
  </section>`;
}

function lossRow(label, value, width) {
  return `<div><span>${escapeHtml(label)} <b>${decimal(value)} dB</b></span><i><em style="width:${width}%"></em></i></div>`;
}

function eventSection(events) {
  if (!events.length) return "";
  return `<section class="research-section"><h3>Погодные и космические события</h3>
    <div class="event-strip">${events.map((event) => `<article class="event-card ${escapeHtml(event.severity)}">
      <time>${formatClock(event.t_s)}</time><strong>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.detail)}</p>
    </article>`).join("")}</div></section>`;
}

function hazardSection(hazards, visible) {
  const events = hazards?.events || [];
  return `<section class="research-section hazard-section">
    <div class="research-section-head"><div><h3>Каталожные сближения</h3>
      <p>${escapeHtml(hazards?.detail || "Снимок CelesTrak ещё не загружен")}</p></div>
      <label class="hazard-toggle"><input id="toggle-hazards" type="checkbox" ${visible ? "checked" : ""} /> Показать слой</label>
    </div>
    ${visible ? (events.length ? `<div class="hazard-list">${events.map((event) => `<article>
      <span class="hazard-severity ${escapeHtml(event.severity)}"></span>
      <div><strong>${escapeHtml(event.satellite_id)} ↔ ${escapeHtml(event.object_name)}</strong>
      <p>${decimal(event.miss_distance_km)} км · ${decimal(event.relative_velocity_km_s, 3)} км/с · ${formatClock(event.t_s)}</p></div>
      <button class="mini-action" data-hazard-scenario="${escapeHtml(event.id)}" type="button">Создать сценарий</button>
    </article>`).join("")}</div>` : `<div class="empty-state">Опасных сближений в выбранной оболочке не найдено</div>`) :
      `<div class="hazard-collapsed">Слой выключен, чтобы не перегружать интерфейс · проверено объектов: ${hazards?.screened_objects || 0}</div>`}
  </section>`;
}

function assumptionSection(result) {
  return `<details class="research-methodology"><summary>Модели, допущения и воспроизводимость</summary>
    <div class="method-grid"><div><strong>Орбита</strong><p>${escapeHtml(result.orbit_model.engine)} ${escapeHtml(result.orbit_model.version || "")} · ${escapeHtml(result.orbit_model.gravity)}</p></div>
    <div><strong>Эпоха</strong><p>${escapeHtml(result.epoch)} · шаг ${result.options.step_s} с · границы до ${result.options.boundary_resolution_s} с</p></div>
    <div><strong>Источники</strong><p>${result.sources.map((item) => `${escapeHtml(item.label)}: ${escapeHtml(item.status)}`).join(" · ")}</p></div>
    <div><strong>Предупреждения</strong><p>${result.warnings.map(escapeHtml).join(" · ")}</p></div></div>
  </details>`;
}

function causeLabel(value) {
  return ({
    geometry: "геометрия",
    weather: "погода",
    insufficient_margin: "мало запаса",
    doppler: "Doppler",
    pointing: "наведение",
    terminal_busy: "заняты терминалы",
    network_split: "разрыв сети",
    gateway_unavailable: "шлюз недоступен",
  })[value] || value;
}

function formatClock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function optionalDb(value) {
  return value == null ? "—" : decimal(value);
}
