/**
 * Орбитальная модель в браузере.
 *
 * Формулы те же, что в расчётном ядре, — это принципиально: положение
 * аппарата на сцене обязано совпадать с тем, по которому посчитаны связи.
 * Собственная модель нужна только для плавности: связи считаются на сетке
 * с шагом 120 с, а картинка обновляется каждый кадр.
 */

export const EARTH_RADIUS_KM = 6371.0;
export const MU_KM3_S2 = 398600.435507;
export const EARTH_ROTATION_PERIOD_S = 86164.09054;
export const EARTH_ANGULAR_RATE = (2 * Math.PI) / EARTH_ROTATION_PERIOD_S;

/** Масштаб сцены: радиус Земли равен единице. */
export const SCENE_SCALE = 1 / EARTH_RADIUS_KM;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

export class OrbitModel {
  constructor(bundle) {
    this.update(bundle);
  }

  update(bundle) {
    const environment = bundle.environment;
    const planes = new Map(bundle.planes.map((plane) => [plane.id, plane]));

    this.radiusKm = EARTH_RADIUS_KM + environment.altitude_km;
    this.meanMotion = Math.sqrt(MU_KM3_S2 / this.radiusKm ** 3);
    this.inclination = toRadians(environment.inclination_deg);
    this.earthAngle0 = toRadians(environment.earth_angle0_deg);

    this.count = bundle.satellites.length;
    this.u0 = new Float64Array(this.count);
    this.raan = new Float64Array(this.count);
    for (let index = 0; index < this.count; index += 1) {
      const satellite = bundle.satellites[index];
      const plane = planes.get(satellite.plane_id);
      this.u0[index] = toRadians(satellite.slot_deg + plane.phase_deg);
      this.raan[index] = toRadians(plane.raan_deg);
    }
    // Двойная точность: буфер крошечный, а совпадение с расчётным ядром
    // должно быть точным, иначе картинка и связи разойдутся.
    this.positions = new Float64Array(this.count * 3);
  }

  /** Угол поворота Земли относительно инерциальных осей. */
  earthAngle(seconds) {
    return this.earthAngle0 + EARTH_ANGULAR_RATE * seconds;
  }

  /**
   * Пересчитать инерциальные координаты всех аппаратов, км.
   * Результат хранится в общем буфере, чтобы не мусорить в каждом кадре.
   */
  propagate(seconds) {
    const cosI = Math.cos(this.inclination);
    const sinI = Math.sin(this.inclination);
    const radius = this.radiusKm;
    for (let index = 0; index < this.count; index += 1) {
      const u = this.u0[index] + this.meanMotion * seconds;
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);
      const cosO = Math.cos(this.raan[index]);
      const sinO = Math.sin(this.raan[index]);
      const offset = index * 3;
      this.positions[offset] = radius * (cosO * cosU - sinO * sinU * cosI);
      this.positions[offset + 1] = radius * (sinO * cosU + cosO * sinU * cosI);
      this.positions[offset + 2] = radius * (sinU * sinI);
    }
    return this.positions;
  }

  /** Точка орбиты плоскости по аргументу широты — для отрисовки колец. */
  orbitPoint(planeRaanDeg, argument, target) {
    const raan = toRadians(planeRaanDeg);
    const cosI = Math.cos(this.inclination);
    const sinI = Math.sin(this.inclination);
    const cosU = Math.cos(argument);
    const sinU = Math.sin(argument);
    const cosO = Math.cos(raan);
    const sinO = Math.sin(raan);
    return target.set(
      ...toScene(
        this.radiusKm * (cosO * cosU - sinO * sinU * cosI),
        this.radiusKm * (sinO * cosU + cosO * sinU * cosI),
        this.radiusKm * (sinU * sinI)
      )
    );
  }
}

/**
 * Перевод модельных координат в координаты сцены.
 *
 * Модель считает Z полярной осью, three.js рисует «вверх» по Y. Отображение
 * `(x, y, z) → (x, z, −y)` — поворот на −90° вокруг X, он сохраняет
 * правую тройку, поэтому поворот Земли вокруг модельного Z становится
 * обычным поворотом вокруг Y сцены на тот же угол.
 */
export function toScene(x, y, z) {
  return [x * SCENE_SCALE, z * SCENE_SCALE, -y * SCENE_SCALE];
}

/** Положение наземного пункта в связанной с Землёй системе, в координатах сцены. */
export function groundToScene(latDeg, lonDeg, altitude = 0) {
  const lat = toRadians(latDeg);
  const lon = toRadians(lonDeg);
  const radius = EARTH_RADIUS_KM + altitude;
  return toScene(
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.cos(lat) * Math.sin(lon),
    radius * Math.sin(lat)
  );
}
