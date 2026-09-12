/** Представление инженерной верификации внутри окна «Анализ». */

import { decimal, duration, escapeHtml, percent } from "../format.js";
import { $ } from "./shell.js";

const SOURCE_TONE = {
  ready: ["ok", "готов"],
  stale: ["warn", "устарел"],
  fallback: ["bad", "замена"],
  not_applicable: ["muted", "не применяется"],
};

const SOURCE_HELP = {
  weather: {
    purpose: "Дождь, снег, облачность, давление, температура, влажность и видимость у наземных пунктов.",
    effect: "текущие атмосферные потери RF и доступность оптической линии",
    access: "Публичный API · без ключа",
    cadence: "актуален 1 час",
  },
  elevation: {
    purpose: "Высота рельефа по координатам терминалов из цифровой модели местности.",
    effect: "точная высота наземного пункта и граница радиовидимости",
    access: "Публичный API · без ключа",
    cadence: "загружается один раз",
  },
  space_weather: {
    purpose: "Индексы F10.7, Kp и Ap, описывающие солнечную и геомагнитную активность.",
    effect: "оценка плотности атмосферы, сопротивления и чувствительности орбиты",
    access: "Публичные данные · без ключа",
    cadence: "актуален 15 минут",
  },
  celestrak: {
    purpose: "Орбитальный каталог действующих аппаратов, ступеней ракет и отслеживаемого мусора в GP/OMM.",
    effect: "поиск сближений с проектной группировкой; не вероятность столкновения",
    access: "Публичный каталог · без ключа",
    cadence: "актуален 6 часов",
  },
  satnogs: {
    purpose: "Частоты, режимы и состояние передатчиков реальных спутников, связанных с NORAD ID.",
    effect: "автозаполнение радиопрофиля только для реальных аппаратов с NORAD ID",
    access: "Публичный API · без ключа",
    cadence: "актуален 24 часа",
  },
  itur: {
    purpose: "Климатические модели ITU: дождь, газы, водяной пар, облака и сцинтилляция.",
    effect: "долгосрочная климатическая составляющая потерь радиолинии",
    access: "Локальная библиотека · интернет не нужен",
    cadence: "версия зафиксирована в Docker",
  },
  satkit: {
    purpose: "EOP, шкалы времени, модель гравитации, эфемериды Солнца и Луны.",
    effect: "численное движение, системы координат, затмения и орбитальные возмущения",
    access: "Локальный комплект · интернет не нужен",
    cadence: "версия зафиксирована в Docker",
  },
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

      ${verificationGuide()}
      ${sourceSection(model.externalStatus, model.loadingSources)}
      ${controlsSection(model, result)}
      ${profileCards(model.profiles, model.selectedProfile, result)}
      ${result ? resultSection(result, selected, model) : emptyResult()}
    </div>`;
}

function verificationGuide() {
  return `
    <section class="verification-guide">
      <div class="verification-guide-head">
        <div><span>КАК ЧИТАТЬ РЕЖИМ</span><h3>От исходных данных — к физической причине потери связи</h3></div>
        <p>Быстрый режим проверяет геометрию и маршрутизацию по ТЗ. Инженерная верификация добавляет физику орбиты,
        энергетику линий, атмосферу и внешние события, после чего повторно строит маршрут.</p>
      </div>
      <ol class="verification-flow">
        <li><b>1</b><div><strong>Фиксируем данные</strong><span>Снимки погоды, рельефа, космической погоды и каталога получают время и хеш.</span></div></li>
        <li><b>2</b><div><strong>Уточняем движение</strong><span>SatKit рассчитывает положение и скорость аппаратов; по ним определяется Doppler.</span></div></li>
        <li><b>3</b><div><strong>Проверяем каждую линию</strong><span>Uplink и downlink проходят отдельно; нужны видимость и положительный запас в обоих направлениях.</span></div></li>
        <li><b>4</b><div><strong>Объясняем результат</strong><span>Показываем диапазон трёх профилей и причину каждого разрыва: геометрия, погода, запас, Doppler или сеть.</span></div></li>
      </ol>
      <div class="verification-boundaries">
        <span><i class="fact"></i><b>Фактические данные</b> — снимки внешних источников</span>
        <span><i class="model"></i><b>Модельные данные</b> — параметры антенн и передатчиков</span>
        <span><i class="result"></i><b>Результат</b> — исследовательская оценка, не эксплуатационный паспорт</span>
      </div>
    </section>`;
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
        <div><h3>Данные и модели расчёта</h3>
        <p>Карточка показывает назначение источника и его фактическое состояние. Сам расчёт не выходит в интернет:
        кнопка обновляет только публичные снимки, затем они читаются локально.</p></div>
        <button class="button button-subtle" id="refresh-research-data" type="button" ${loading ? "disabled" : ""}>
          ${loading ? "Обновляем…" : "↻ Обновить данные"}
        </button>
      </div>
      <div class="source-grid">
        ${sources.length ? sources.map(sourceCard).join("") : sourceSkeletons()}
      </div>
      ${statusLegend()}
      <div class="source-access-note"><strong>Почему доступ требуется не везде?</strong>
        Open-Meteo, NOAA, CelesTrak и SatNOGS дают публичное чтение без ключа. ITU-Rpy и SatKit находятся локально.
        Поэтому показанные здесь источники не требуют пользовательских учётных записей.</div>
    </section>`;
}

function sourceCard(source) {
  const [tone, label] = SOURCE_TONE[source.status] || ["muted", source.status || "—"];
  const help = SOURCE_HELP[source.id] || {
    purpose: "Дополнительный источник инженерных данных.",
    effect: "уточнение инженерного расчёта",
    access: "условия доступа не указаны",
    cadence: "—",
  };
  const date = source.retrieved_at ? new Date(source.retrieved_at).toLocaleString("ru-RU") : "локальная модель";
  return `<article class="source-card ${tone}">
    <div><strong>${escapeHtml(source.label)}</strong><span class="badge ${tone}">${escapeHtml(label)}</span></div>
    <p class="source-purpose">${escapeHtml(help.purpose)}</p>
    <dl class="source-facts">
      <div><dt>Влияет на</dt><dd>${escapeHtml(help.effect)}</dd></div>
      <div><dt>Доступ</dt><dd>${escapeHtml(help.access)}</dd></div>
    </dl>
    <div class="source-status-note ${tone}"><strong>${escapeHtml(sourceStatusMeaning(source))}</strong></div>
    <details class="source-technical"><summary>Технические сведения</summary>
      <p>${escapeHtml(source.detail || "Нет дополнительного сообщения")}</p>
      <small>${escapeHtml(help.cadence)} · ${escapeHtml(date)}${source.records != null ? ` · ${source.records} записей` : ""}</small>
    </details>
  </article>`;
}

function sourceStatusMeaning(source) {
  return ({
    ready: source.origin === "snapshot"
      ? "Снимок актуален и будет использован в следующем расчёте."
      : "Локальная модель готова и будет использована.",
    stale: "Снимок будет использован, но срок его актуальности уже истёк.",
    fallback: "Источник недоступен: вместо него будет использована встроенная замена.",
    not_applicable: "Для текущих аппаратов источник не нужен и в расчёт не входит.",
  })[source.status] || "Состояние источника не определено.";
}

function statusLegend() {
  return `<div class="source-status-legend" aria-label="Обозначения статусов источников">
    <span><i class="ok"></i><b>готов</b> — применяется</span>
    <span><i class="warn"></i><b>устарел</b> — применяется с предупреждением</span>
    <span><i class="bad"></i><b>замена</b> — используется встроенное приближение</span>
    <span><i class="muted"></i><b>не применяется</b> — не нужен этому сценарию</span>
  </div>`;
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
        <p class="research-mode-help"><b>RF</b> устойчивее к облакам, но зависит от запаса и Doppler. <b>Optical</b> даёт иной профиль потерь и требует точного наведения.
        <b>Гибрид</b> выбирает доступный тип на каждом межспутниковом участке. Пользовательские и шлюзовые линии остаются Ku/Ka.</p>
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
  return `<section class="profile-assumptions">
    <div class="research-section-head"><div><h3>Модельные профили оборудования</h3>
      <p>Паспортов реальных антенн и передатчиков нет, поэтому система считает три уровня энергетики.
      Диапазон между ними честнее одного неподтверждённого значения. Нажмите профиль, чтобы открыть его результат и паспорт линии.</p></div>
      <span class="assumption-chip">НЕ ФАКТИЧЕСКИЕ ПАСПОРТА</span>
    </div>
    <div class="engineering-profile-grid">
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
    </div>
  </section>`;
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
