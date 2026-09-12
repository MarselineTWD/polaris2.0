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
import { initAnalysis, openAnalysis, openEngineeringAnalysis, renderAnalysis } from "./panels/analysis.js";
import { initCoverage, renderCoverage, setCoverageMode, updateCoverageTime } from "./panels/coverage.js";

state.presets = [];
let viewer = null;
let comparison = null;
let lastFrame = performance.now();
let visibilityCache = { bundle: null, siteId: null, step: -1, indices: new Set() };
const initialUrlState = readUrlState();
let urlSyncTimer = null;
let sceneAssetsReady = false;
let initialScenarioReady = false;
let activeJobId = null;

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
    if (state.viewMode === "2d") renderCoverage(state);
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
    research: { ...state.research, result: null, hazardsVisible: false },
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
  if (state.viewMode === "2d") updateCoverageTime(state);
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

    if (state.viewMode === "3d") {
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
    } else if (state.playing) {
      // Положения на плоской карте тоже интерполируются каждый кадр.
      // Состояние связей меняется по расчётным шагам, а геометрия движется плавно.
      updateCoverageTime(state);
    }
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
  if (state.viewMode === "2d") updateCoverageTime(state);
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
  if (state.viewMode === "2d") updateCoverageTime(state);
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

function downloadJson(payload, filename) {
  const safeName = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 140);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Поддержать все JSON-файлы, которые умеет выгружать интерфейс:
 * исходный сценарий, полный результат быстрого расчёта и инженерный паспорт.
 */
function scenarioFromImportedJson(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.schema_version === "cosmo-A-1.0") return payload;
  if (payload.effective_scenario?.schema_version === "cosmo-A-1.0") {
    return payload.effective_scenario;
  }
  if (payload.scenario?.schema_version === "cosmo-A-1.0") return payload.scenario;
  return null;
}

async function exportSavedVariant(variantId) {
  const variant = state.variants.find((item) => item.id === variantId);
  if (!variant) {
    toast("Сохранённый вариант больше не найден", "warn");
    return;
  }
  try {
    const scenario = await api.exportVariant(variantId);
    downloadJson(scenario, `${variant.label}-variant.json`);
    toast(`Вариант «${variant.label}» экспортирован`, "ok");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      toast("Вариант больше не найден. Обновите список сравнения.", "warn");
    } else reportError(error);
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

async function runComparison(variantIds) {
  setBusy(
    true,
    "Сравниваем варианты",
    `${variantIds.length} ${plural(variantIds.length, "конфигурация считается", "конфигурации считаются", "конфигураций считаются")} на одинаковой сетке времени`
  );
  try {
    comparison = await api.compareMany({
      variant_ids: variantIds,
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

async function runBackgroundJob(kind, starter, title, { cancellable = false } = {}) {
  if (!state.applied) return;
  setBusy(true, title, "Запускаем…");
  try {
    const job = await starter();
    if (cancellable) {
      activeJobId = job.id;
      $("cancel-job").hidden = false;
      $("cancel-job").disabled = false;
      $("cancel-job").textContent = "Отменить расчёт";
    }
    const result = await awaitJob(job.id, (progress) => {
      if (progress.status === "cancelling") {
        $("blocking-title").textContent = "Останавливаем подбор";
        $("blocking-detail").textContent = "Завершаем текущую порцию расчётов";
        return;
      }
      const percentDone = Math.round((progress.progress || 0) * 100);
      $("blocking-detail").innerHTML =
        `<div class="progress-bar"><i style="width:${percentDone}%"></i></div>` +
        `<div style="margin-top:7px">${progress.done} из ${progress.total || "—"}</div>`;
    });
    setState({ analysis: { ...state.analysis, [kind]: result } });
    renderAnalysis(state);
    toast("Анализ завершён", "ok");
  } catch (error) {
    if (error instanceof ApiError && error.code === "job_cancelled") toast("Расчёт отменён", "ok");
    else reportError(error);
  } finally {
    activeJobId = null;
    $("cancel-job").hidden = true;
    setBusy(false);
  }
}

async function loadResearchPanel() {
  if (state.research.externalStatus && state.research.profiles) return;
  try {
    const [externalStatus, profiles] = await Promise.all([
      state.research.externalStatus ? Promise.resolve(state.research.externalStatus) : api.externalDataStatus(),
      state.research.profiles ? Promise.resolve(state.research.profiles) : api.researchProfiles(),
    ]);
    setState({ research: { ...state.research, externalStatus, profiles } });
    renderAnalysis(state);
  } catch (error) {
    reportError(error);
  }
}

async function runResearchJob(starter, title, onDone) {
  setBusy(true, title, "Запускаем фоновую задачу…");
  try {
    const job = await starter();
    activeJobId = job.id;
    $("cancel-job").hidden = false;
    $("cancel-job").disabled = false;
    $("cancel-job").textContent = "Отменить расчёт";
    const result = await awaitJob(job.id, (current) => {
      const percentDone = Math.round((current.progress || 0) * 100);
      $("blocking-title").textContent =
        current.status === "cancelling" ? "Останавливаем задачу" : title;
      $("blocking-detail").innerHTML =
        current.status === "cancelling"
          ? "Завершаем текущий безопасный этап"
          : `<div class="progress-bar"><i style="width:${percentDone}%"></i></div>` +
            `<div style="margin-top:7px">${percentDone}% · ${current.done} из ${current.total || "—"}</div>`;
    }, { interval: 500, limit: 1200 });
    await onDone(result);
  } catch (error) {
    if (error instanceof ApiError && error.code === "job_cancelled") toast("Расчёт отменён", "ok");
    else reportError(error);
  } finally {
    activeJobId = null;
    $("cancel-job").hidden = true;
    setBusy(false);
  }
}

async function refreshResearchData() {
  if (!state.applied || state.research.loadingSources) return;
  setState({ research: { ...state.research, loadingSources: true } });
  renderAnalysis(state);
  await runResearchJob(
    () => api.refreshExternalData(state.applied),
    "Обновляем инженерные данные",
    async (result) => {
      setState({ research: { ...state.research, externalStatus: result, loadingSources: false } });
      renderAnalysis(state);
      const failed = (result.updated || []).filter((item) => !item.ok).length;
      toast(failed ? `Данные обновлены частично: ${failed} источников недоступны` : "Все снимки обновлены", failed ? "warn" : "ok");
    }
  );
  if (state.research.loadingSources) {
    setState({ research: { ...state.research, loadingSources: false } });
    renderAnalysis(state);
  }
}

async function startResearchVerification() {
  if (!state.applied) return;
  await runResearchJob(
    () => api.runResearch(state.applied, {
      link_mode: state.research.linkMode,
      strategy: "max_margin",
      step_s: 60,
      profile_ids: ["conservative", "nominal", "enhanced"],
    }),
    "Инженерная верификация",
    async (result) => {
      setState({
        research: {
          ...state.research,
          result,
          selectedProfile: result.profiles.some((item) => item.id === "nominal") ? "nominal" : result.profiles[0]?.id,
          externalStatus: { ...state.research.externalStatus, sources: result.sources },
        },
      });
      renderAnalysis(state);
      toast(`Инженерный расчёт завершён за ${decimal(result.elapsed_ms / 1000, 1)} с`, "ok");
    }
  );
}

async function exportResearchResult() {
  const result = state.research.result;
  if (!result) return;
  try {
    const payload = await api.exportResearch(result.id);
    downloadJson(payload, `${state.projectTitle}-engineering-verification.json`);
    toast("Паспорт инженерной верификации экспортирован", "ok");
  } catch (error) {
    reportError(error);
  }
}

async function createHazardScenario(eventId) {
  const result = state.research.result;
  if (!result) return;
  try {
    const payload = await api.createHazardScenario(result.id, eventId);
    setState({ draft: clone(payload.scenario), dirty: true });
    renderProject(state);
    renderHeader();
    setModal("analysis-modal", false);
    toast("Сценарий окна манёвра добавлен в черновик. Нажмите «Пересчитать».", "ok");
  } catch (error) {
    reportError(error);
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

function showViewMode(mode) {
  if (!state.bundle || !["3d", "2d"].includes(mode)) return;
  setState({ viewMode: mode });
  setCoverageMode(state, mode);
  if (mode === "2d") renderCoverage(state);
}

function initInspectorResize() {
  const handle = $("inspector-resizer");
  const root = document.documentElement;
  const stored = Number(localStorage.getItem("polaris-inspector-width"));
  if (Number.isFinite(stored) && stored >= 300) root.style.setProperty("--inspector-width", `${stored}px`);

  const applyWidth = (clientX) => {
    const maximum = Math.max(300, Math.min(650, window.innerWidth - 480));
    const width = Math.round(Math.max(300, Math.min(maximum, window.innerWidth - clientX)));
    root.style.setProperty("--inspector-width", `${width}px`);
    localStorage.setItem("polaris-inspector-width", String(width));
  };
  handle.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 840) return;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-inspector");
    applyWidth(event.clientX);
  });
  handle.addEventListener("pointermove", (event) => {
    if (handle.hasPointerCapture(event.pointerId)) applyWidth(event.clientX);
  });
  const finish = (event) => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing-inspector");
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const current = parseFloat(getComputedStyle(root).getPropertyValue("--inspector-width")) || 372;
    applyWidth(window.innerWidth - current + (event.key === "ArrowLeft" ? -24 : 24));
  });
}

// --------------------------------------------------------------------------- //
// Привязка обработчиков
// --------------------------------------------------------------------------- //

function bindControls() {
  bindOverlayDismiss();
  initInspectorResize();

  $("cancel-job").addEventListener("click", async (event) => {
    if (!activeJobId) return;
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = "Отменяем…";
    try {
      await api.cancelJob(activeJobId);
      $("blocking-title").textContent = "Останавливаем задачу";
      $("blocking-detail").textContent = "Завершаем текущий безопасный этап";
    } catch (error) {
      reportError(error);
    }
  });

  $("calculate-button").addEventListener("click", async () => {
    const button = $("calculate-button");
    button.disabled = true;
    await recompute();
    button.disabled = false;
  });

  $("export-button").addEventListener("click", async (event) => {
    if (!state.bundle || state.status !== "ready" || state.dirty) {
      toast("Сначала выполните расчёт текущей конфигурации", "warn");
      return;
    }
    event.currentTarget.disabled = true;
    try {
      const payload = await api.exportRun(state.bundle.runId);
      downloadJson(payload, `${state.projectTitle}-result.json`);
      toast("Результат экспортирован в формате cosmo-A-result-1.0", "ok");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast("Расчёт больше не доступен. Нажмите «Пересчитать» и повторите экспорт.", "warn");
      } else reportError(error);
    } finally {
      event.currentTarget.disabled = false;
    }
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
        const scenario = scenarioFromImportedJson(payload);
        if (!scenario) {
          toast("JSON не содержит сценарий схемы cosmo-A-1.0", "error");
          return;
        }
        const check = await api.validate(scenario);
        if (!check.valid) {
          setProblems(check.errors);
          renderProject(state);
          toast(`В файле ${check.errors.length} проблем — см. список в шторке`, "error");
          return;
        }
        await loadScenario(scenario, { title: scenario.meta?.title || file.name });
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
    exportVariant: exportSavedVariant,
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
      runBackgroundJob(
        "spof",
        () => api.spof(state.applied),
        "Проверяем каждый аппарат",
        { cancellable: true }
      ),
    runOptimize: () =>
      runBackgroundJob(
        "optimize",
        () => api.optimize(state.applied, 160),
        "Подбираем конфигурацию",
        { cancellable: true }
      ),
    applyOptimized,
    loadResearch: loadResearchPanel,
    refreshExternal: refreshResearchData,
    runResearch: startResearchVerification,
    exportResearch: exportResearchResult,
    setResearchMode: (linkMode) => {
      setState({ research: { ...state.research, linkMode, result: null } });
      renderAnalysis(state);
    },
    selectResearchProfile: (selectedProfile) => {
      setState({ research: { ...state.research, selectedProfile } });
      renderAnalysis(state);
    },
    toggleResearchHazards: (hazardsVisible) => {
      setState({ research: { ...state.research, hazardsVisible } });
      renderAnalysis(state);
    },
    createHazardScenario,
  });

  initCoverage({
    changeMode: showViewMode,
    selectSatellite: (id) => {
      selectNode(id);
      updateCoverageTime(state);
    },
  });
  setCoverageMode(state, state.viewMode);
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
    if (location.hash === "#engineering") openEngineeringAnalysis(state);
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
