/** Форматирование величин для интерфейса. Везде русская запятая как разделитель. */

export const decimal = (value, digits = 2) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : String(Number(value).toFixed(digits)).replace(".", ",");

export const percent = (value, digits = 2) =>
  value === null || value === undefined ? "—" : `${decimal(value, digits)}%`;

/** Пункты процента — разница двух долей, всегда со знаком. */
export const points = (value, digits = 2) => {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${decimal(Math.abs(value), digits)} п.п.`;
};

/** Длительность в человеческом виде: 8 мин, 2 ч 15 мин, 13 ч 16 мин. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.round(seconds);
  if (total === 0) return "нет";
  if (total < 60) return `${total} с`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/** Время от начала расчёта в виде ЧЧ:ММ либо ЧЧ:ММ:СС. */
export function clock(seconds, withSeconds = false) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  const parts = [hours, minutes, ...(withSeconds ? [rest] : [])];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

export const coordinates = (lat, lon) =>
  `${decimal(Math.abs(lat), 2)}° ${lat >= 0 ? "с" : "ю"}. ш. · ` +
  `${decimal(Math.abs(lon), 2)}° ${lon >= 0 ? "в" : "з"}. д.`;

/** Экранирование значений, приходящих из загруженного пользователем файла. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
}
