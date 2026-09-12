/**
 * Точка входа интерфейса.
 *
 * Сценарий работы: сервис считает весь горизонт один раз и присылает пакет;
 * дальше перемотка времени, выбор пункта и переключение объектов идут по
 * локальным данным без единого запроса. К серверу обращаемся только когда
 * меняется конфигурация или запускается длительный анализ.
 */

import { ApiError, api, awaitJob } from "./api.js";
import { clone, currentStep, notify, setState, state, subscribe } from "./state.js";
import { Bundle } from "./model/bundle.js";
import { Viewer } from "./scene/viewer.js";
import { decimal, escapeHtml, percent } from "./format.js";
import { $, bindOverlayDismiss, reportError, setBusy, setDrawer, setModal, toast } from "./panels/shell.js";
import { initInspector, renderInspector } from "./panels/inspector.js";
import { initTimeline, renderTimeline, updateSceneSummary, updateTimeUI } from "./panels/timeline.js";
import { initProject, renderProject, setProblems, toggleSatelliteFailure } from "./panels/project.js";
import { initCompare, openCompare, primeSelection, renderCompare } from "./panels/compare.js";
import { initAnalysis, openAnalysis, renderAnalysis } from "./panels/analysis.js";

state.presets = [];
let viewer = null;
let comparison = null;
let lastFrame = performance.now();

// --------------------------------------------------------------------------- //
// Расчёт
// --------------------------------------------------------------------------- //

/** Отправить черновик конфигурации на расчёт и принять новый пакет. */
async function recompute({ silent = false, reframe = false } = {}) {
  if (!state.draft) return false;
  if (!silent) setBusy(true, "Считаем горизонт", "Положения аппаратов, связи и маршруты");
  setState({ status: "running" });
  try {
    const payload = await api.run(state.draft, { strategy: state.strategy });
    const bundle = new Bundle(payload);
    setProblems([]);

    const clientId =
      bundle.clients.some((item) => item.id === state.clientId)
        ? state.clientId
        : bundle.clients[0]?.id ?? null;

    setState({
      bundle,
      applied: clone(state.draft),
      clientId,
      dirty: false,
      status: "ready",
      online: true,
      projectTitle: bundle.meta.title || bundle.meta.id || "Вариант проекта",
      timeSeconds: Math.min(state.timeSeconds, bundle.horizonSeconds - bundle.stepSeconds),
    });

    viewer.load(bundle);
    if (reframe) {
      viewer.frameGroundSegment(bundle.clients.map((site) => site.id));
    }
    if (!state.selection) setState({ selection: { type: "client", id: clientId } });
    renderAll();
    if (!silent) {
      toast(`Расчёт выполнен за ${decimal(bundle.summary.elapsed_ms, 0)} мс`, "ok");
    }
    return true;
  } catch (error) {
    setState({ status: "error", online: !(error instanceof ApiError && error.code === "offline") });
    const problems = reportError(error);
    if (problems.length) {
      setProblems(problems);
      renderProject(state);
      setDrawer(true);
    }
    return false;
  } finally {
    setBusy(false);
  }
}

async function loadScenario(payload, { presetId = null, title = null } = {}) {
  setState({
    draft: clone(payload),
    presetId: presetId ?? state.presetId,
    selection: null,
    clientId: null,
    analysis: { strategies: null, spof: null, optimize: null },
  });
  comparison = null;
  if (title) setState({ projectTitle: title });
  await recompute({ reframe: true });
  renderProject(state);
}

// --------------------------------------------------------------------------- //
// Отрисовка
// --------------------------------------------------------------------------- //

function renderAll() {
  renderHeader();
  renderTimeline(state);
  renderInspector(state);
  updateSceneSummary(state);
}

function renderHeader() {
  const bundle = state.bundle;
  $("project-name").textContent = state.projectTitle;
  const indicator = $("calc-state");
  const label = indicator.querySelector("b");

  if (!state.online) {
    indicator.className = "calculation-state error";
    label.textContent = "Нет связи с сервисом";
  } else if (state.status === "error") {
    indicator.className = "calculation-state error";
    label.textContent = "Расчёт не выполнен";
  } else if (state.dirty) {
    indicator.className = "calculation-state stale";
    label.textContent = "Есть неприменённые изменения";
  } else {
    indicator.className = "calculation-state";
    label.textContent = "Расчёт актуален";
  }

  if (!bundle) {
    $("project-meta").textContent = "";
    return;
  }
  const summary = bundle.summary;
  $("project-meta").innerHTML =
    `<span>${summary.active_satellites} из ${summary.total_satellites} аппаратов</span><i></i>` +
    `<span>${summary.plane_count} плоскости</span><i></i>` +
    `<span>этап ${summary.launch_stage}</span><i></i>` +
    `<span>ISL ${decimal(summary.isl_range_km, 0)} км</span><i></i>` +
    `<span>мин. доступность ${percent(summary.min_availability_pct)}</span>` +
    (state.researchMode ? `<i></i><span style="color:var(--warning)">изменённые условия</span>` : "");

  document.querySelectorAll("[data-stage]").forEach((button) =>
    button.classList.toggle("active", Number(button.dataset.stage) === bundle.design.launch_stage)
  );
}

/** Кадр анимации: положения считаются моделью, состояние связей — из пакета. */
function animate(now) {
  const delta = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  if (state.bundle) {
    if (state.playing) {
      const next = state.timeSeconds + delta * state.speed;
      setState({ timeSeconds: next >= state.bundle.horizonSeconds ? 0 : next });
    }

    const bundle = state.bundle;
    const step = currentStep();
    const track = bundle.track(state.clientId);
    const routed = track?.isRouted(step) ?? false;
    const routeIndices = routed ? track.path(step) : [];
    const routeSites = routed
      ? [state.clientId, bundle.gatewayIdAt(state.clientId, step)].filter(Boolean)
      : [];
    const selectedIndex =
      state.selection?.type === "satellite"
        ? bundle.satelliteIndex.get(state.selection.id) ?? -1
        : -1;

    viewer.render({
      seconds: state.timeSeconds,
      step,
      routeIndices: new Set(routeIndices),
      routeSites,
      selectedIndex,
      showLinks: state.showLinks,
      showOrbits: state.showOrbits,
      showRoute: state.showRoute,
    });
  }
  requestAnimationFrame(animate);
}

// Лёгкие элементы обновляем по таймеру, а не в каждом кадре: текст времени
// и курсор дорожек не нуждаются в 60 обновлениях в секунду.
setInterval(() => {
  if (!state.bundle) return;
  updateTimeUI(state);
  updateSceneSummary(state);
  if (state.playing && state.selection?.type === "client") renderInspector(state);
}, 120);

// --------------------------------------------------------------------------- //
// Действия пользователя
// --------------------------------------------------------------------------- //

function markDirty() {
  setState({ dirty: true });
  renderProject(state);
  renderHeader();
}

function selectClient(clientId) {
  setState({ clientId, selection: { type: "client", id: clientId } });
  renderInspector(state);
  renderTimeline(state);
  updateSceneSummary(state);
}

function selectNode(id) {
  const bundle = state.bundle;
  if (!bundle) return;
  if (bundle.satelliteIndex.has(id)) setState({ selection: { type: "satellite", id } });
  else if (bundle.clients.some((item) => item.id === id)) {
    selectClient(id);
    return;
  } else if (bundle.gateways.some((item) => item.id === id)) {
    setState({ selection: { type: "gateway", id } });
  } else return;
  renderInspector(state);
}

async function saveCurrentVariant() {
  if (!state.bundle) return;
  const suggested = `${state.projectTitle} · этап ${state.bundle.design.launch_stage}`;
  const label = window.prompt("Название варианта", suggested);
  if (!label) return;
  try {
    await api.saveVariant({
      label,
      scenario: state.applied,
      note: state.researchMode ? "Посчитан в изменённых условиях расчёта" : "",
      options: { strategy: state.strategy },
    });
    await refreshVariants();
    toast("Вариант сохранён", "ok");
  } catch (error) {
    reportError(error);
  }
}

async function refreshVariants() {
  try {
    const { variants } = await api.variants();
    setState({ variants });
    primeSelection(variants);
    renderCompare(state, comparison);
  } catch (error) {
    reportError(error);
  }
}

async function runComparison(baseId, otherId) {
  setBusy(true, "Сравниваем варианты", "Оба считаются на одинаковой сетке времени");
  try {
    comparison = await api.compare({
      base_variant_id: baseId,
      other_variant_id: otherId,
      options: { strategy: state.strategy },
    });
    renderCompare(state, comparison);
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function runBackgroundJob(kind, starter, title) {
  if (!state.applied) return;
  setBusy(true, title, "Запускаем…");
  try {
    const job = await starter();
    const result = await awaitJob(job.id, (progress) => {
      const percentDone = Math.round((progress.progress || 0) * 100);
      $("blocking-detail").innerHTML =
        `<div class="progress-bar"><i style="width:${percentDone}%"></i></div>` +
        `<div style="margin-top:7px">${progress.done} из ${progress.total || "—"}</div>`;
    });
    setState({ analysis: { ...state.analysis, [kind]: result } });
    renderAnalysis(state);
    toast("Анализ завершён", "ok");
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

function applyOptimized() {
  const result = state.analysis.optimize;
  if (!result) return;
  setState({ draft: clone(result.scenario), dirty: true });
  renderProject(state);
  setModal("analysis-modal", false);
  toast("Найденная конфигурация подставлена. Нажмите «Пересчитать».", "ok");
  renderHeader();
}

// --------------------------------------------------------------------------- //
// Привязка обработчиков
// --------------------------------------------------------------------------- //

function bindControls() {
  bindOverlayDismiss();

  $("calculate-button").addEventListener("click", async () => {
    const button = $("calculate-button");
    button.disabled = true;
    await recompute();
    button.disabled = false;
  });

  $("export-button").addEventListener("click", () => {
    if (!state.bundle) {
      toast("Сначала выполните расчёт", "warn");
      return;
    }
    // Переход по ссылке: браузер сам сохранит файл, присланный сервисом.
    window.location.href = api.exportUrl(state.bundle.runId);
    toast("Результат выгружается в формате cosmo-A-result-1.0", "ok");
  });

  document.querySelectorAll("[data-stage]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!state.draft) return;
      state.draft.design.launch_stage = Number(button.dataset.stage);
      setState({ dirty: true });
      await recompute();
    })
  );

  $("strategy-select").addEventListener("change", async (event) => {
    setState({ strategy: event.target.value });
    await recompute();
  });

  $("home-camera").addEventListener("click", () => viewer.resetCamera());
  for (const [id, key] of [
    ["toggle-links", "showLinks"],
    ["toggle-orbits", "showOrbits"],
    ["toggle-route", "showRoute"],
  ]) {
    $(id).addEventListener("click", (event) => {
      setState({ [key]: !state[key] });
      event.currentTarget.classList.toggle("active", state[key]);
    });
  }

  initTimeline({
    setTime: (seconds) => {
      setState({ timeSeconds: seconds });
      updateTimeUI(state);
      updateSceneSummary(state);
      renderInspector(state);
    },
    togglePlay: () => {
      setState({ playing: !state.playing });
      updateTimeUI(state);
    },
    setSpeed: (speed) => setState({ speed }),
    selectClient,
  });

  initInspector({
    selectClient,
    selectNode,
    focus: (type, id) => viewer.focus(type, id),
    editProject: () => {
      renderProject(state);
      setDrawer(true);
    },
    toggleFailure: (satelliteId) => {
      const added = toggleSatelliteFailure(state.draft, satelliteId);
      markDirty();
      renderInspector(state);
      toast(
        added
          ? `${satelliteId}: задан отказ на весь период. Нажмите «Пересчитать».`
          : `${satelliteId}: отказ снят. Нажмите «Пересчитать».`,
        "ok"
      );
    },
  });

  initProject({
    open: () => {
      renderProject(state);
      setDrawer(true);
    },
    changed: markDirty,
    apply: async () => {
      setDrawer(false);
      await recompute();
    },
    reset: async () => {
      setState({ draft: clone(state.applied), dirty: false });
      setProblems([]);
      renderProject(state);
      renderHeader();
      toast("Изменения сброшены", "ok");
    },
    setResearchMode: (enabled) => {
      setState({ researchMode: enabled });
      renderProject(state);
      renderHeader();
    },
    loadPreset: async (presetId) => {
      setBusy(true, "Загружаем сценарий");
      try {
        const payload = await api.preset(presetId);
        const preset = state.presets.find((item) => item.id === presetId);
        await loadScenario(payload, { presetId, title: preset?.title });
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(false);
      }
    },
    loadFile: async (file) => {
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const check = await api.validate(payload);
        if (!check.valid) {
          setProblems(check.errors);
          renderProject(state);
          toast(`В файле ${check.errors.length} проблем — см. список в шторке`, "error");
          return;
        }
        await loadScenario(payload, { title: payload?.meta?.title || file.name });
        toast(`Сценарий «${file.name}» загружен и рассчитан`, "ok");
      } catch (error) {
        if (error instanceof SyntaxError) {
          toast("Файл не является корректным JSON", "error");
          return;
        }
        reportError(error);
      }
    },
  });

  initCompare({
    open: async () => {
      await refreshVariants();
      renderCompare(state, comparison);
      openCompare();
    },
    refresh: () => renderCompare(state, comparison),
    saveCurrent: saveCurrentVariant,
    compare: runComparison,
    remove: async (id) => {
      await api.deleteVariant(id);
      await refreshVariants();
    },
  });

  initAnalysis({
    open: () => {
      renderAnalysis(state);
      openAnalysis();
    },
    runStrategies: async () => {
      setBusy(true, "Считаем три стратегии", "Геометрия общая, меняется только правило выбора пути");
      try {
        const result = await api.strategies(state.applied);
        setState({ analysis: { ...state.analysis, strategies: result } });
        renderAnalysis(state);
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(false);
      }
    },
    runSpof: () =>
      runBackgroundJob("spof", () => api.spof(state.applied), "Проверяем каждый аппарат"),
    runOptimize: () =>
      runBackgroundJob(
        "optimize",
        () => api.optimize(state.applied, 160),
        "Подбираем конфигурацию"
      ),
    applyOptimized,
  });
}

// --------------------------------------------------------------------------- //
// Запуск
// --------------------------------------------------------------------------- //

async function bootstrap() {
  const canvas = $("space-canvas");
  try {
    viewer = new Viewer(canvas, {
      onPick: (owner) => {
        if (!owner) return;
        if (owner.type === "client") selectClient(owner.id);
        else {
          setState({ selection: owner });
          renderInspector(state);
        }
      },
      onHover: (owner, event) => {
        const tooltip = $("object-tooltip");
        if (!owner) {
          tooltip.hidden = true;
          return;
        }
        tooltip.hidden = false;
        tooltip.style.left = `${event.offsetX}px`;
        tooltip.style.top = `${event.offsetY}px`;
        tooltip.innerHTML = tooltipFor(owner);
      },
    });
  } catch (error) {
    $("webgl-error").hidden = false;
    $("webgl-error").textContent =
      "3D-сцена недоступна: браузер не поддерживает WebGL. Расчёт и панели продолжают работать.";
    console.error(error);
  }

  bindControls();

  try {
    const [{ presets }, legend] = await Promise.all([api.presets(), api.legend()]);
    state.presets = presets;
    setState({ legend });
    $("strategy-select").innerHTML = legend.strategy
      .map(
        (item) =>
          `<option value="${item.value}" ${item.value === state.strategy ? "selected" : ""}>${escapeHtml(
            item.label
          )}</option>`
      )
      .join("");

    const first = presets[0];
    const payload = await api.preset(first.id);
    await loadScenario(payload, { presetId: first.id, title: first.title });
  } catch (error) {
    setState({ online: false });
    renderHeader();
    reportError(error);
  }

  requestAnimationFrame(animate);
}

function tooltipFor(owner) {
  const bundle = state.bundle;
  if (!bundle) return escapeHtml(owner.id);
  const step = currentStep();
  if (owner.type === "satellite") {
    const index = bundle.satelliteIndex.get(owner.id);
    const satellite = bundle.satellites[index];
    const active = bundle.isActive(step, index);
    return `<strong>${escapeHtml(owner.id)}</strong><br>Плоскость ${escapeHtml(
      satellite.plane_id
    )} · очередь ${satellite.launch_batch}<br>${active ? "активен" : "недоступен"}`;
  }
  if (owner.type === "plane") {
    const plane = bundle.planes.find((item) => item.id === owner.id);
    return `<strong>Плоскость ${escapeHtml(owner.id)}</strong><br>RAAN ${decimal(
      plane.raan_deg,
      1
    )}° · фаза ${decimal(plane.phase_deg, 1)}°`;
  }
  const site = bundle.groundSites.find((item) => item.id === owner.id);
  const metrics = owner.type === "client" ? bundle.metricsFor(owner.id) : null;
  return `<strong>${escapeHtml(site?.name || owner.id)}</strong><br>${
    owner.type === "gateway" ? "Шлюз" : `Доступность ${percent(metrics?.availability_pct)}`
  }`;
}

subscribe((_, keys) => {
  if (keys.has("dirty") || keys.has("status") || keys.has("online")) renderHeader();
});

bootstrap();
