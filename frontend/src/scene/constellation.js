/* global THREE */
/**
 * Аппараты и орбитальные кольца.
 *
 * 48 одинаковых аппаратов рисуются через GPU-инстансинг: геометрия создаётся
 * один раз, в каждом кадре обновляются только матрицы. Цвет несёт состояние
 * аппарата — активен, участвует в маршруте, недоступен, ещё не выведен.
 */

import { SCENE_SCALE, toScene } from "../model/orbit.js";

const COLORS = {
  idle: new THREE.Color(0xc7d2df),
  route: new THREE.Color(0x54efc7),
  failed: new THREE.Color(0xff5d7d),
  undeployed: new THREE.Color(0x2b3545),
  selected: new THREE.Color(0xffffff),
};

const PLANE_COLORS = [0x4d8cc7, 0x8c6ad4, 0xd4776a, 0x5fb08c, 0xc9a24b];

export class Constellation {
  constructor(parent) {
    this.parent = parent;
    this.group = new THREE.Group();
    parent.add(this.group);
    this.orbits = new THREE.Group();
    parent.add(this.orbits);

    this.count = 0;
    this.bus = null;
    this.picker = null;
    this.matrix = new THREE.Matrix4();
    this.hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this.scratch = new THREE.Vector3();
  }

  /** Пересоздать инстансы под состав группировки из пакета. */
  build(bundle, model) {
    this.dispose();
    this.count = bundle.satellites.length;
    this.bundle = bundle;

    const body = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.03, 0.018, 0.018),
      new THREE.MeshPhongMaterial({ shininess: 40, specular: 0x223044 }),
      this.count
    );
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.frustumCulled = false;
    this.bus = body;
    this.group.add(body);

    const panels = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.055, 0.002, 0.022),
      new THREE.MeshPhongMaterial({ color: 0x2e4c7a, shininess: 90, specular: 0x6f9ad6 }),
      this.count * 2
    );
    panels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    panels.frustumCulled = false;
    this.panels = panels;
    this.group.add(panels);

    // Отдельная невидимая сфера увеличенного радиуса: по ней работает
    // выбор мышью, иначе в аппарат почти невозможно попасть.
    const picker = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }),
      this.count
    );
    picker.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    picker.frustumCulled = false;
    this.picker = picker;
    this.group.add(picker);

    this.leftPanel = new THREE.Matrix4().makeTranslation(0, 0, -0.026);
    this.rightPanel = new THREE.Matrix4().makeTranslation(0, 0, 0.026);

    this.buildOrbits(bundle, model);
  }

  buildOrbits(bundle, model) {
    const point = new THREE.Vector3();
    bundle.planes.forEach((plane, index) => {
      const positions = new Float32Array(181 * 3);
      for (let step = 0; step <= 180; step += 1) {
        model.orbitPoint(plane.raan_deg, (step / 180) * Math.PI * 2, point);
        positions[step * 3] = point.x;
        positions[step * 3 + 1] = point.y;
        positions[step * 3 + 2] = point.z;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: PLANE_COLORS[index % PLANE_COLORS.length],
          transparent: true,
          opacity: 0.34,
        })
      );
      line.userData.owner = { type: "plane", id: plane.id };
      this.orbits.add(line);
    });
  }

  /**
   * Обновить положения и цвета.
   *
   * @param positions инерциальные координаты из орбитальной модели, км
   * @param step      номер отсчёта расчётной сетки
   * @param routeSet  индексы аппаратов текущего маршрута
   * @param selected  индекс выделенного аппарата либо -1
   */
  update(positions, step, routeSet, selected) {
    if (!this.bus) return;
    const bundle = this.bundle;
    const stage = bundle.design.launch_stage;

    for (let index = 0; index < this.count; index += 1) {
      const satellite = bundle.satellites[index];
      const deployed = satellite.launch_batch <= stage;
      const [x, y, z] = toScene(
        positions[index * 3],
        positions[index * 3 + 1],
        positions[index * 3 + 2]
      );

      if (!deployed) {
        this.bus.setMatrixAt(index, this.hidden);
        this.picker.setMatrixAt(index, this.hidden);
        this.panels.setMatrixAt(index * 2, this.hidden);
        this.panels.setMatrixAt(index * 2 + 1, this.hidden);
        this.bus.setColorAt(index, COLORS.undeployed);
        continue;
      }

      this.scratch.set(x, y, z);
      this.matrix.makeTranslation(x, y, z);
      // Разворачиваем корпус «лицом» к Земле — так аппарат читается как аппарат.
      ORIENTATION.lookAt(this.scratch, ORIGIN, UP);
      this.matrix.multiply(ORIENTATION);

      this.bus.setMatrixAt(index, this.matrix);
      this.picker.setMatrixAt(index, this.matrix);
      this.panels.setMatrixAt(index * 2, TEMP.multiplyMatrices(this.matrix, this.leftPanel));
      this.panels.setMatrixAt(index * 2 + 1, TEMP.multiplyMatrices(this.matrix, this.rightPanel));

      const active = bundle.isActive(step, index);
      let color = COLORS.idle;
      if (index === selected) color = COLORS.selected;
      else if (!active) color = COLORS.failed;
      else if (routeSet.has(index)) color = COLORS.route;
      this.bus.setColorAt(index, color);
    }

    this.bus.instanceMatrix.needsUpdate = true;
    this.panels.instanceMatrix.needsUpdate = true;
    this.picker.instanceMatrix.needsUpdate = true;
    if (this.bus.instanceColor) this.bus.instanceColor.needsUpdate = true;
  }

  setOrbitsVisible(visible) {
    this.orbits.visible = visible;
  }

  /** Объекты, по которым работает выбор мышью. */
  pickTargets() {
    return [...(this.picker ? [this.picker] : []), ...this.orbits.children];
  }

  ownerForInstance(instanceId) {
    const satellite = this.bundle?.satellites[instanceId];
    return satellite ? { type: "satellite", id: satellite.id } : null;
  }

  dispose() {
    for (const child of [...this.group.children, ...this.orbits.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
      child.parent.remove(child);
    }
    this.bus = null;
    this.panels = null;
    this.picker = null;
  }
}

const ORIGIN = new THREE.Vector3(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const TEMP = new THREE.Matrix4();
const ORIENTATION = new THREE.Matrix4();
