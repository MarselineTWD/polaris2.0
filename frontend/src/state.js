/**
 * Состояние приложения и подписка на его изменения.
 *
 * Хранилище намеренно маленькое: расчётные данные живут в пакете (Bundle),
 * а здесь только то, что выбрал пользователь, — время, пункт, выделение,
 * режимы отображения и черновик конфигурации.
 */

const listeners = new Set();

export const state = {
  /** Сценарий, который уйдёт на расчёт при нажатии «Пересчитать». */
  draft: null,
  /** Сценарий, по которому посчитан текущий пакет. */
  applied: null,
  bundle: null,
  legend: null,

  presetId: "01_full_constellation",
  projectTitle: "Полная группировка",

  clientId: null,
  timeSeconds: 21600,
  playing: false,
  speed: 300,

  selection: null,
  /** Аппарат, который камера удерживает в центре кадра. */
  trackedSatelliteId: null,
  strategy: "min_hops",

  showLinks: true,
  showOrbits: true,
  showRoute: true,
  earthRotation: true,
  /** Разрешено ли менять условия расчёта (environment). По умолчанию нет. */
  researchMode: false,

  status: "idle",
  dirty: false,
  online: true,
  variants: [],
  analysis: { strategies: null, spof: null, optimize: null },
  coverage: null,
  job: null,
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let queued = false;
const changedKeys = new Set();

/** Изменить состояние; подписчики получают набор затронутых ключей. */
export function setState(patch) {
  let touched = false;
  for (const [key, value] of Object.entries(patch)) {
    if (state[key] === value) continue;
    state[key] = value;
    changedKeys.add(key);
    touched = true;
  }
  if (!touched) return;
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const keys = new Set(changedKeys);
    changedKeys.clear();
    for (const listener of listeners) listener(state, keys);
  });
}

/** Принудительно оповестить подписчиков (после мутации вложенных объектов). */
export function notify(...keys) {
  for (const key of keys) changedKeys.add(key);
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const touched = new Set(changedKeys);
    changedKeys.clear();
    for (const listener of listeners) listener(state, touched);
  });
}

export const clone = (value) => JSON.parse(JSON.stringify(value));

/** Текущий отсчёт расчётной сетки. */
export function currentStep() {
  return state.bundle ? state.bundle.stepAt(state.timeSeconds) : 0;
}
