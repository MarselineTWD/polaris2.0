/** Общие элементы оболочки: уведомления, индикатор занятости, шторки и окна. */

import { ApiError } from "../api.js";
import { escapeHtml } from "../format.js";

export const $ = (id) => document.getElementById(id);

let toastTimer = null;

export function toast(message, tone = "info") {
  const element = $("toast");
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 4200);
}

/** Показать ошибку API так, чтобы пользователь понял, что именно поправить. */
export function reportError(error) {
  if (error instanceof ApiError) {
    const problems = error.fieldProblems;
    if (problems.length) {
      toast(`${error.message}: ${problems[0].path} — ${problems[0].message}`, "error");
      return problems;
    }
    toast(error.message, "error");
    return [];
  }
  console.error(error);
  toast(error?.message || "Непредвиденная ошибка интерфейса", "error");
  return [];
}

/** Сколько проблем показываем списком, прежде чем свернуть остаток. */
const MAX_VISIBLE_PROBLEMS = 8;

/** Разметка списка проблем валидации для показа в шторке конфигурации. */
export function fieldErrorsMarkup(problems) {
  if (!problems?.length) return "";
  const shown = problems.slice(0, MAX_VISIBLE_PROBLEMS);
  const hidden = problems.length - shown.length;
  const rows = shown
    .map(
      (item) =>
        `<div class="field-error"><code>${escapeHtml(item.path)}</code>${escapeHtml(
          item.message
        )}${item.value === undefined || item.value === null ? "" : ` (получено: ${escapeHtml(item.value)})`}</div>`
    )
    .join("");
  const more = hidden
    ? `<div class="field-error">…и ещё ${hidden} ${plural(
        hidden,
        "проблема",
        "проблемы",
        "проблем"
      )} — исправьте показанные и загрузите файл снова</div>`
    : "";
  return `<div class="field-errors">${rows}${more}</div>`;
}

/** Русское склонение после числительного. */
function plural(count, one, few, many) {
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return many;
  const units = count % 10;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

export function setBusy(active, title = "Считаем…", detail = "") {
  const overlay = $("blocking-overlay");
  overlay.hidden = !active;
  if (active) {
    $("blocking-title").textContent = title;
    $("blocking-detail").innerHTML = detail;
  }
}

export function setDrawer(open) {
  $("configuration-drawer").classList.toggle("open", open);
  $("drawer-backdrop").classList.toggle("open", open);
  $("configuration-drawer").setAttribute("aria-hidden", String(!open));
}

export function setModal(id, open) {
  const element = $(id);
  element.classList.toggle("open", open);
  element.setAttribute("aria-hidden", String(!open));
}

/** Закрытие по клику на подложку и по Escape — ожидаемое поведение. */
export function bindOverlayDismiss() {
  $("drawer-backdrop").addEventListener("click", () => setDrawer(false));
  document
    .querySelectorAll("[data-close-drawer]")
    .forEach((button) => button.addEventListener("click", () => setDrawer(false)));
  document.querySelectorAll("[data-close-modal]").forEach((button) =>
    button.addEventListener("click", () => setModal(button.dataset.closeModal, false))
  );
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) =>
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) setModal(backdrop.id, false);
    })
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    setDrawer(false);
    document.querySelectorAll(".modal-backdrop.open").forEach((modal) => setModal(modal.id, false));
  });
}
