/** Минимальный RFC 4180 parser для результатов, выгруженных POLARIS. */
export function parseCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }

    if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }

  if (quoted) return [];
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

/** Извлечь полный сценарий из CSV-выгрузки результата. */
export function scenarioFromResultCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const header = rows[0];
  const schemaIndex = header.indexOf("schema_version");
  const scenarioIndex = header.indexOf("effective_scenario");
  if (schemaIndex < 0 || scenarioIndex < 0) return null;

  const metadataRow = rows.slice(1).find((row) => row[scenarioIndex]);
  if (!metadataRow || metadataRow[schemaIndex] !== "cosmo-A-result-1.0") return null;
  try {
    const scenario = JSON.parse(metadataRow[scenarioIndex]);
    return scenario?.schema_version === "cosmo-A-1.0" ? scenario : null;
  } catch {
    return null;
  }
}
