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
import { $, bindOverlayDismiss, plural, reportError, setBusy, setDrawer, setModal, toast } from "./panels/shell.js";
import { initInspector, renderInspector } from "./panels/inspector.js";
import { initTimeline, renderTimeline, updateSceneSummary, updateTimeUI } from "./panels/timeline.js";
import { initProject, renderProject, setProblems, toggleSatelliteFailure } from "./panels/project.js";
import { initCompare, openCompare, primeSelection, renderCompare } from "./panels/compare.js";
import { initAnalysis, openAnalysis, renderAnalysis } from "./panels/analysis.js";
import { initCoverage, openCoverage, renderCoverage } from "./panels/coverage.js";

state.presets = [];
let viewer = null;
let comparison = null;
let lastFrame = performance.now();
let visibilityCache = { bundle: null, siteId: null, step: -1, indices: new Set() };
const initialUrlState = readUrlState();
let urlSyncTimer = null;
let sceneAssetsReady = false;
let initialScenarioReady = false;

function updateSceneLoading() {
  if (sceneAssetsReady && initialScenarioReady) $("scene-loading").hidden = true;
}

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
      coverage: null,
      projectTitle: bundle.meta.title || bundle.meta.id || "Вариант проекта",
      timeSeconds: Math.min(state.timeSeconds, bundle.horizonSeconds - bundle.stepSeconds),
    });

    viewer.load(bundle);
    initialScenarioReady = true;
    updateSceneLoading();
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

async function loadScenario(payload, { presetId = null, title = null, restore = null } = {}) {
  const patch = {
    draft: clone(payload),
    presetId: presetId ?? state.presetId,
    selection: null,
    trackedSatelliteId: null,
    clientId: restore?.clientId ?? null,
    analysis: { strategies: null, spof: null, optimize: null },
  };
  if (typeof restore?.timeSeconds === "number" && Number.isFinite(restore.timeSeconds)) {
    patch.timeSeconds = Math.max(0, restore.timeSeconds);
  }
  setState(patch);
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
    `<span>${summary.active_satellites} ${plural(summary.active_satellites, "аппарат", "аппарата", "аппаратов")} из ${summary.total_satellites}</span><i></i>` +
    `<span>${summary.plane_count} ${plural(summary.plane_count, "плоскость", "плоскости", "плоскостей")}</span><i></i>` +
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
    const trackedIndex = state.trackedSatelliteId
      ? bundle.satelliteIndex.get(state.trackedSatelliteId) ?? -1
      : -1;
    const visibilitySiteId = ["client", "gateway"].includes(state.selection?.type)
      ? state.selection.id
      : null;
    if (
      visibilityCache.bundle !== bundle ||
      visibilityCache.siteId !== visibilitySiteId ||
      visibilityCache.step !== step
    ) {
      visibilityCache = {
        bundle,
        siteId: visibilitySiteId,
        step,
        indices: new Set(visibilitySiteId ? bundle.visibleSatellites(visibilitySiteId, step) : []),
      };
    }
    const visibleIndices = visibilityCache.indices;

    viewer.render({
      seconds: state.timeSeconds,
      step,
      routeIndices: new Set(routeIndices),
      routeSites,
      selectedIndex,
      trackedIndex,
      visibilitySiteId,
      visibleIndices,
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
  if (document.visibilityState !== "visible") return;
  if (!state.bundle) return;
  updateTimeUI(state);
  updateSceneSummary(state);
  if (state.playing && state.selection?.type === "client") renderInspector(state);
}, 120);

function setTime(seconds) {
  if (!state.bundle) return;
  const maximum = state.bundle.horizonSeconds - state.bundle.stepSeconds;
  setState({ timeSeconds: Math.max(0, Math.min(maximum, seconds)) });
  updateTimeUI(state);
  updateSceneSummary(state);
  renderInspector(state);
}

function nextGap() {
  const gaps = state.bundle?.track(state.clientId)?.metrics?.gaps || [];
  if (!gaps.length) {
    toast("У выбранного пункта нет перерывов связи", "ok");
    return;
  }
  const gap = gaps.find((item) => item.start_s > state.timeSeconds + 0.5) || gaps[0];
  if (state.selection?.type !== "client" || state.selection.id !== state.clientId) {
    setState({ selection: { type: "client", id: state.clientId }, trackedSatelliteId: null });
  }
  setTime(gap.start_s);
  toast(`Перерыв: ${gap.cause_label}`, "warn");
}

// --------------------------------------------------------------------------- //
// Действия пользователя
// --------------------------------------------------------------------------- //

function markDirty() {
  setState({ dirty: true });
  renderProject(state);
  renderHeader();
}

function selectClient(clientId) {
  setState({ clientId, selection: { type: "client", id: clientId }, trackedSatelliteId: null });
  renderInspector(state);
  renderTimeline(state);
  updateSceneSummary(state);
}

function selectNode(id) {
  const bundle = state.bundle;
  if (!bundle) return;
  if (bundle.satelliteIndex.has(id)) {
    setState({
      selection: { type: "satellite", id },
      trackedSatelliteId: state.trackedSatelliteId === id ? id : null,
    });
  }
  else if (bundle.clients.some((item) => item.id === id)) {
    selectClient(id);
    return;
  } else if (bundle.gateways.some((item) => item.id === id)) {
    setState({ selection: { type: "gateway", id }, trackedSatelliteId: null });
  } else return;
  renderInspector(state);
}

async function saveCurrentVariant() {
  if (!state.bundle) return;
  const suggested = `${state.projectTitle} · этап ${state.bundle.design.launch_stage}`;
  const label = await requestVariantName(suggested);
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

function requestVariantName(suggested) {
  const dialog = $("save-variant-dialog");
  const input = $("variant-name-input");
  input.value = suggested;
  dialog.returnValue = "";
  $("cancel-variant-name").onclick = () => dialog.close("cancel");
  dialog.showModal();
  requestAnimationFrame(() => input.select());
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "save" ? input.value.trim() : null),
      { once: true }
    );
  });
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
    comparison = null;
    renderCompare(state, comparison);
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

  $("home-camera").addEventListener("click", () => {
    setState({ trackedSatelliteId: null });
    viewer.resetCamera();
    renderInspector(state);
  });
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
    setTime,
    togglePlay: () => {
      setState({ playing: !state.playing });
      updateTimeUI(state);
    },
    setSpeed: (speed) => setState({ speed }),
    selectClient,
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable;
    if (editing || document.querySelector("dialog[open], .modal-backdrop.open, .drawer.open")) return;

    if (event.code === "Space") {
      event.preventDefault();
      setState({ playing: !state.playing });
      updateTimeUI(state);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      setTime(state.timeSeconds + direction * (state.bundle?.stepSeconds || 0));
    } else if (["1", "2", "3"].includes(event.key) && !event.repeat) {
      document.querySelector(`[data-stage="${event.key}"]`)?.click();
    } else if (event.key.toLowerCase() === "n" && !event.repeat) {
      nextGap();
    }
  });

  initInspector({
    selectClient,
    selectNode,
    setTime,
    focus: (type, id) => viewer.focus(type, id),
    trackSatellite: (satelliteId) => {
      const trackedSatelliteId = state.trackedSatelliteId === satelliteId ? null : satelliteId;
      setState({ trackedSatelliteId });
      if (trackedSatelliteId) viewer.focus("satellite", trackedSatelliteId);
      renderInspector(state);
    },
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
      comparison = null;
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

  initCoverage({
    open: async () => {
      if (!state.bundle) return;
      openCoverage();
      renderCoverage(state);
      if (state.coverage?.runId === state.bundle.runId) return;
      setBusy(true, "Строим карту покрытия", "Проверяем маршрут по сетке широта/долгота");
      try {
        const runId = state.bundle.runId;
        const data = await api.coverage(runId);
        if (state.bundle?.runId !== runId) return;
        setState({ coverage: { runId, data } });
        renderCoverage(state);
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(false);
      }
    },
  });
}

// --------------------------------------------------------------------------- //
// Запуск
// --------------------------------------------------------------------------- //

async function bootstrap() {
  const canvas = $("space-canvas");
  try {
    viewer = new Viewer(canvas, {
      onAssetsReady: () => {
        sceneAssetsReady = true;
        updateSceneLoading();
      },
      onAssetError: () => {
        $("scene-loading").querySelector("small").textContent =
          "Часть текстур недоступна — используется базовая модель";
      },
      onCameraControl: () => {
        if (!state.trackedSatelliteId) return;
        setState({ trackedSatelliteId: null });
        renderInspector(state);
      },
      onPick: (owner) => {
        if (!owner) return;
        if (owner.type === "client") selectClient(owner.id);
        else {
          setState({
            selection: owner,
            trackedSatelliteId:
              owner.type === "satellite" && owner.id === state.trackedSatelliteId
                ? state.trackedSatelliteId
                : null,
          });
          renderInspector(state);
        }
      },
      onHover: (owner, event) => {
        const tooltip = $("object-tooltip");
        canvas.style.cursor = owner ? "pointer" : "grab";
        if (!owner) {
          tooltip.hidden = true;
          return;
        }
        tooltip.hidden = false;
        tooltip.innerHTML = tooltipFor(owner);
        const viewRect = $("space-view").getBoundingClientRect();
        const margin = 10;
        const x = event.clientX - viewRect.left + 12;
        const y = event.clientY - viewRect.top + 12;
        tooltip.style.left = `${Math.max(margin, Math.min(x, viewRect.width - tooltip.offsetWidth - margin))}px`;
        tooltip.style.top = `${Math.max(margin, Math.min(y, viewRect.height - tooltip.offsetHeight - margin))}px`;
      },
    });
  } catch (error) {
    $("scene-loading").hidden = true;
    $("webgl-error").hidden = false;
    $("webgl-error").textContent =
      "3D-сцена недоступна: браузер не поддерживает WebGL. Расчёт и панели продолжают работать.";
    console.error(error);
  }

  bindControls();

  try {
    const requestedPresetId = initialUrlState.presetId || state.presetId;
    const initialPreset = api.preset(requestedPresetId).then((payload) => ({
      id: requestedPresetId,
      payload,
    })).catch(async (error) => {
      if (requestedPresetId === state.presetId) throw error;
      return { id: state.presetId, payload: await api.preset(state.presetId) };
    });
    const [{ presets }, legend, loadedPreset] = await Promise.all([
      api.presets(),
      api.legend(),
      initialPreset,
    ]);
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

    const chosen = presets.find((item) => item.id === loadedPreset.id) || presets[0];
    await loadScenario(loadedPreset.payload, {
      presetId: chosen.id,
      title: chosen.title,
      restore: initialUrlState,
    });
  } catch (error) {
    $("scene-loading").hidden = true;
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
    const visibilitySiteId = ["client", "gateway"].includes(state.selection?.type)
      ? state.selection.id
      : null;
    const visibility = visibilitySiteId
      ? `<br>${bundle.isVisible(visibilitySiteId, step, index) ? "Виден" : "Не виден"} из ${escapeHtml(
          visibilitySiteId
        )}`
      : "";
    return `<strong>Спутник ${escapeHtml(owner.id)}</strong><br>Плоскость ${escapeHtml(
      satellite.plane_id
    )} · очередь ${satellite.launch_batch}<br>${active ? "активен" : "недоступен"}${visibility}`;
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
  return `<strong>${owner.type === "gateway" ? "Шлюз" : "Клиентский пункт"} ${escapeHtml(
    site?.name || owner.id
  )}</strong><br>${
    owner.type === "gateway" ? `ID ${escapeHtml(owner.id)}` : `Доступность ${percent(metrics?.availability_pct)}`
  }`;
}

subscribe((_, keys) => {
  if (keys.has("dirty") || keys.has("status") || keys.has("online")) renderHeader();
  if (keys.has("presetId") || keys.has("clientId") || keys.has("timeSeconds")) scheduleUrlSync();
});

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const rawTime = params.get("t");
  const time = rawTime === null ? Number.NaN : Number(rawTime);
  return {
    presetId: params.get("preset") || null,
    clientId: params.get("client") || null,
    timeSeconds: Number.isFinite(time) && time >= 0 ? time : null,
  };
}

function scheduleUrlSync() {
  if (urlSyncTimer) return;
  urlSyncTimer = window.setTimeout(() => {
    urlSyncTimer = null;
    if (!state.bundle) return;
    const url = new URL(window.location.href);
    url.searchParams.set("preset", state.presetId);
    if (state.clientId) url.searchParams.set("client", state.clientId);
    url.searchParams.set("t", String(Math.round(state.timeSeconds)));
    history.replaceState(null, "", url);
  }, 250);
}

bootstrap();
