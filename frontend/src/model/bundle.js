/**
 * Разбор пакета расчёта.
 *
 * Сервер присылает весь горизонт сразу (~35 КБ после сжатия), поэтому
 * перемотка времени, смена наземного пункта и переключение стратегии
 * обходятся без обращений к сети. Плотные массивы закодированы base64:
 * битовые маски — через `packbits` по строкам, числовые — типизированными
 * массивами в порядке little-endian.
 */

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const typed = (Constructor) => (text) => {
  const bytes = decodeBase64(text);
  return new Constructor(bytes.buffer, bytes.byteOffset, bytes.byteLength / Constructor.BYTES_PER_ELEMENT);
};

const asFloat32 = typed(Float32Array);
const asUint8 = (text) => decodeBase64(text);
const asInt8 = (text) => new Int8Array(decodeBase64(text).buffer);
const asUint16 = typed(Uint16Array);
const asUint32 = typed(Uint32Array);

/**
 * Битовая матрица `rows x columns`, упакованная по строкам.
 * Каждая строка выровнена на границу байта, старший бит идёт первым.
 */
export class BitMatrix {
  constructor(bytes, rows, columns) {
    this.bytes = bytes;
    this.rows = rows;
    this.columns = columns;
    this.stride = Math.ceil(columns / 8);
  }

  static decode(text, rows, columns) {
    return new BitMatrix(decodeBase64(text), rows, columns);
  }

  get(row, column) {
    const byte = this.bytes[row * this.stride + (column >> 3)];
    return (byte >> (7 - (column & 7))) & 1;
  }

  /** Индексы установленных битов в строке. */
  indices(row) {
    const result = [];
    const base = row * this.stride;
    for (let byteIndex = 0; byteIndex < this.stride; byteIndex += 1) {
      let byte = this.bytes[base + byteIndex];
      if (!byte) continue;
      for (let bit = 0; bit < 8; bit += 1) {
        if (byte & (0x80 >> bit)) {
          const column = byteIndex * 8 + bit;
          if (column < this.columns) result.push(column);
        }
      }
    }
    return result;
  }

  count(row) {
    let total = 0;
    const base = row * this.stride;
    for (let byteIndex = 0; byteIndex < this.stride; byteIndex += 1) {
      let byte = this.bytes[base + byteIndex];
      while (byte) {
        total += byte & 1;
        byte >>= 1;
      }
    }
    return total;
  }
}

/** Состояния наземного пункта — совпадают с кодами расчётного ядра. */
export const STATE = { NO_VISIBILITY: 0, VISIBLE_NO_PATH: 1, ROUTED: 2 };

/** Причины отсутствия маршрута — коды совпадают с расчётным ядром. */
export const CAUSE = {
  NONE: 0,
  NO_VISIBLE_SATELLITE: 1,
  GATEWAY_UNAVAILABLE: 2,
  NO_GATEWAY_CONTACT: 3,
  ISL_NETWORK_SPLIT: 4,
};

export const CAUSE_LABEL = {
  [CAUSE.NONE]: "маршрут есть",
  [CAUSE.NO_VISIBLE_SATELLITE]: "нет видимого спутника",
  [CAUSE.GATEWAY_UNAVAILABLE]: "шлюз недоступен",
  [CAUSE.NO_GATEWAY_CONTACT]: "нет контакта со шлюзом",
  [CAUSE.ISL_NETWORK_SPLIT]: "разрыв межспутниковой сети",
};

export const CAUSE_LABEL_BY_NAME = {
  none: CAUSE_LABEL[CAUSE.NONE],
  no_visible_satellite: CAUSE_LABEL[CAUSE.NO_VISIBLE_SATELLITE],
  gateway_unavailable: CAUSE_LABEL[CAUSE.GATEWAY_UNAVAILABLE],
  no_gateway_contact: CAUSE_LABEL[CAUSE.NO_GATEWAY_CONTACT],
  isl_network_split: CAUSE_LABEL[CAUSE.ISL_NETWORK_SPLIT],
};

export const STATE_CLASS = {
  [STATE.NO_VISIBILITY]: "outage",
  [STATE.VISIBLE_NO_PATH]: "degraded",
  [STATE.ROUTED]: "available",
};

class ClientTrack {
  constructor(raw, stepCount) {
    this.state = asUint8(raw.state).subarray(0, stepCount);
    this.cause = asUint8(raw.cause).subarray(0, stepCount);
    this.gateway = asInt8(raw.gateway).subarray(0, stepCount);
    this.hops = asFloat32(raw.hops);
    this.latencyMs = asFloat32(raw.latency_ms);
    this.margin = asFloat32(raw.margin);
    this.diversity = asUint8(raw.diversity).subarray(0, stepCount);
    this.requiredRangeKm = asFloat32(raw.required_range_km);
    this.changed = BitMatrix.decode(raw.changed, 1, stepCount);
    this.pathOffsets = asUint32(raw.path_offsets);
    this.pathNodes = asUint16(raw.path_nodes);
    this.metrics = raw.metrics;
  }

  /** Индексы аппаратов маршрута на отсчёте. */
  path(step) {
    const from = this.pathOffsets[step];
    const to = this.pathOffsets[step + 1];
    const result = [];
    for (let index = from; index < to; index += 1) result.push(this.pathNodes[index]);
    return result;
  }

  isRouted(step) {
    return this.state[step] === STATE.ROUTED;
  }

  /** Непрерывные отрезки одинакового состояния и причины — для диаграммы. */
  segments() {
    const result = [];
    let start = 0;
    for (let step = 1; step <= this.state.length; step += 1) {
      if (
        step === this.state.length ||
        this.state[step] !== this.state[start] ||
        this.cause[step] !== this.cause[start]
      ) {
        result.push({
          start,
          end: step,
          state: this.state[start],
          cause: this.cause[start],
        });
        start = step;
      }
    }
    return result;
  }
}

export class Bundle {
  constructor(raw) {
    this.raw = raw;
    this.runId = raw.run_id;
    this.scenarioHash = raw.scenario_hash;
    this.meta = raw.meta || {};
    this.options = raw.options;
    this.environment = raw.environment;
    this.design = raw.design;
    this.groundSites = raw.ground_sites;
    this.failures = raw.failures || [];
    this.gatewayOutages = raw.gateway_outages || [];
    this.summary = raw.summary;
    this.stepCount = raw.step_count;
    this.satelliteCount = raw.satellite_count;
    this.pairCount = raw.pair_count;

    this.satellites = raw.design.satellites;
    this.planes = raw.design.planes;
    this.satelliteIndex = new Map(this.satellites.map((item, index) => [item.id, index]));
    this.planeIndex = new Map(this.planes.map((item, index) => [item.id, index]));

    this.clients = this.groundSites.filter((site) => site.role === "client");
    this.gateways = this.groundSites.filter((site) => site.role === "gateway");

    this.pairI = asUint16(raw.pairs.i);
    this.pairJ = asUint16(raw.pairs.j);
    this.isl = BitMatrix.decode(raw.isl, this.stepCount, this.pairCount);
    this.active = BitMatrix.decode(raw.active, this.stepCount, this.satelliteCount);
    this.linkCounts = asUint16(raw.link_counts);
    this.activeCounts = asUint16(raw.active_counts);

    this.groundVisible = new Map(
      Object.entries(raw.ground_visible).map(([id, text]) => [
        id,
        BitMatrix.decode(text, this.stepCount, this.satelliteCount),
      ])
    );
    this.gatewayOnline = new Map(
      Object.entries(raw.gateway_online || {}).map(([id, text]) => [
        id,
        BitMatrix.decode(text, 1, this.stepCount),
      ])
    );

    this.tracks = new Map(
      Object.entries(raw.clients).map(([id, value]) => [id, new ClientTrack(value, this.stepCount)])
    );
  }

  get stepSeconds() {
    return this.environment.step_s;
  }

  get horizonSeconds() {
    return this.environment.horizon_s;
  }

  /** Номер отсчёта, покрывающего момент времени. */
  stepAt(seconds) {
    const index = Math.floor(seconds / this.stepSeconds);
    return Math.min(this.stepCount - 1, Math.max(0, index));
  }

  timeAt(step) {
    return step * this.stepSeconds;
  }

  track(clientId) {
    return this.tracks.get(clientId);
  }

  isActive(step, satelliteIndex) {
    return this.active.get(step, satelliteIndex) === 1;
  }

  /** Пары аппаратов со связью на отсчёте — как плоский список индексов. */
  islPairs(step) {
    return this.isl.indices(step);
  }

  isVisible(siteId, step, satelliteIndex) {
    const matrix = this.groundVisible.get(siteId);
    return matrix ? matrix.get(step, satelliteIndex) === 1 : false;
  }

  visibleSatellites(siteId, step) {
    const matrix = this.groundVisible.get(siteId);
    return matrix ? matrix.indices(step) : [];
  }

  metricsFor(clientId) {
    return this.track(clientId)?.metrics ?? null;
  }

  gatewayIdAt(clientId, step) {
    const track = this.track(clientId);
    if (!track || !track.isRouted(step)) return null;
    const index = track.gateway[step];
    return index >= 0 ? this.gateways[index]?.id ?? null : null;
  }

  /** Полный маршрут в виде идентификаторов: клиент → аппараты → шлюз. */
  routeIds(clientId, step) {
    const track = this.track(clientId);
    if (!track || !track.isRouted(step)) return [];
    const gateway = this.gatewayIdAt(clientId, step);
    return [clientId, ...track.path(step).map((index) => this.satellites[index].id), gateway];
  }
}
