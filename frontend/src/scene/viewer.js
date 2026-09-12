/* global THREE */
/**
 * 3D-вид: сборка сцены, управление камерой и выбор объектов.
 *
 * Модуль не знает ни про API, ни про панели: он получает пакет расчёта и
 * текущий выбор, а наружу сообщает, по какому объекту кликнули.
 */

import { Earth, createStarfield } from "./earth.js";
import { Constellation } from "./constellation.js";
import { Network } from "./network.js";
import { OrbitModel, toScene } from "../model/orbit.js";

const HOME_CAMERA = new THREE.Vector3(0.2, 0.35, 5.15);
const HOME_ROTATION = { x: -0.12, y: -0.28 };

export class Viewer {
  constructor(canvas, { onPick, onHover } = {}) {
    this.canvas = canvas;
    this.onPick = onPick;
    this.onHover = onHover;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 760 ? 1 : 1.35));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(39, 1, 0.1, 100);
    this.camera.position.copy(HOME_CAMERA);

    this.world = new THREE.Group();
    this.world.rotation.set(HOME_ROTATION.x, HOME_ROTATION.y, 0);
    this.scene.add(this.world);

    this.scene.add(new THREE.AmbientLight(0x5d7297, 0.6));
    this.scene.add(createStarfield());

    // Солнце задаёт форму и терминатор. Оно декоративное: освещённость в
    // расчёте не участвует, модель оперирует только геометрией.
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(5, 2.4, 3.4);
    this.scene.add(sun);

    // Подсветка со стороны камеры: Земля вращается физически, и без неё
    // обращённая к наблюдателю сторона регулярно уходит в тень, а это
    // рабочий инструмент — карта должна читаться всегда.
    this.headlight = new THREE.DirectionalLight(0xdce9ff, 2.0);
    this.scene.add(this.headlight);

    const rim = new THREE.PointLight(0x3c7dff, 9, 12, 2);
    rim.position.set(-3.4, -1.4, -2.6);
    this.scene.add(rim);

    this.earth = new Earth(this.world);
    this.constellation = new Constellation(this.world);
    this.network = null;
    this.model = null;
    this.bundle = null;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.scratch = new THREE.Vector3();
    this.routeNodes = [];

    this.bindPointer();
  }

  /** Подключить новый расчётный пакет. */
  load(bundle) {
    this.bundle = bundle;
    this.model = new OrbitModel(bundle);
    this.earth.setSites(bundle.groundSites);
    this.constellation.build(bundle, this.model);
    if (this.network) {
      this.world.remove(this.network.links);
      this.world.remove(this.network.route);
      this.world.remove(this.network.routeGlow);
    }
    this.network = new Network(this.world, bundle.pairCount);
  }

  /**
   * Перерисовать кадр.
   *
   * @param options.seconds       модельное время
   * @param options.step          отсчёт расчётной сетки
   * @param options.routeIndices  индексы аппаратов маршрута
   * @param options.routeSites    идентификаторы наземных узлов маршрута
   */
  render({ seconds, step, routeIndices, routeSites, selectedIndex, showLinks, showOrbits, showRoute }) {
    if (!this.bundle || !this.model) return;

    const positions = this.model.propagate(seconds);
    this.headlight.position.copy(this.camera.position);
    this.earth.setAngle(this.model.earthAngle(seconds));
    this.constellation.setOrbitsVisible(showOrbits);
    this.constellation.update(positions, step, routeIndices, selectedIndex);
    this.network.updateLinks(this.bundle, step, positions, showLinks);

    this.routeNodes.length = 0;
    if (routeSites.length) {
      const client = this.earth.sitePosition(routeSites[0], new THREE.Vector3());
      if (client) this.routeNodes.push(client);
    }
    for (const index of routeIndices) {
      const [x, y, z] = toSceneTriple(positions, index);
      this.routeNodes.push(new THREE.Vector3(x, y, z));
    }
    if (routeSites.length > 1) {
      const gateway = this.earth.sitePosition(routeSites[routeSites.length - 1], new THREE.Vector3());
      if (gateway) this.routeNodes.push(gateway);
    }
    this.network.updateRoute(this.routeNodes, showRoute);
    this.earth.highlight(new Set(routeSites));

    this.resize();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = this.renderer.getPixelRatio();
    if (
      this.canvas.width !== Math.round(width * ratio) ||
      this.canvas.height !== Math.round(height * ratio)
    ) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
    }
  }

  resetCamera() {
    this.camera.position.copy(HOME_CAMERA);
    this.world.rotation.set(HOME_ROTATION.x, HOME_ROTATION.y, 0);
  }

  /**
   * Развернуть сцену на район обслуживания.
   *
   * Наземные пункты в задаче северные, а вид по умолчанию смотрел в Тихий
   * океан — покрытие и маршруты были не видны без ручного вращения.
   */
  frameGroundSegment(clientIds) {
    const centroid = new THREE.Vector3();
    const point = new THREE.Vector3();
    let counted = 0;
    for (const id of clientIds) {
      if (this.earth.sitePosition(id, point)) {
        centroid.add(point);
        counted += 1;
      }
    }
    if (!counted) return;
    centroid.divideScalar(counted);
    aimAt(this.world, centroid, 0.72);
  }

  /** Плавно довернуть сцену так, чтобы объект оказался перед камерой. */
  focus(ownerType, id) {
    const target = new THREE.Vector3();
    if (ownerType === "satellite") {
      const index = this.bundle.satelliteIndex.get(id);
      if (index === undefined) return;
      const positions = this.model.positions;
      const [x, y, z] = toSceneTriple(positions, index);
      target.set(x, y, z);
    } else if (!this.earth.sitePosition(id, target)) {
      return;
    }
    aimAt(this.world, target, 0.85);
  }

  bindPointer() {
    let dragging = false;
    let start = null;
    let previous = { x: 0, y: 0 };

    const setPointer = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    this.canvas.addEventListener("pointerdown", (event) => {
      start = { x: event.clientX, y: event.clientY };
      previous = { x: event.clientX, y: event.clientY };
      dragging = false;
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (start) {
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved > 4) dragging = true;
        if (dragging) {
          this.world.rotation.y += (event.clientX - previous.x) * 0.005;
          this.world.rotation.x = Math.max(
            -1.35,
            Math.min(1.35, this.world.rotation.x + (event.clientY - previous.y) * 0.005)
          );
          previous = { x: event.clientX, y: event.clientY };
        }
        return;
      }
      setPointer(event);
      const hit = this.pick();
      if (this.onHover) this.onHover(hit, event);
    });

    this.canvas.addEventListener("pointerup", (event) => {
      // Выбираем объект только если нажатие началось на этом же холсте:
      // одиночный pointerup (например, после перетаскивания извне) не должен
      // менять выделение.
      if (start && !dragging) {
        setPointer(event);
        const hit = this.pick();
        if (hit && this.onPick) this.onPick(hit);
      }
      start = null;
      dragging = false;
    });

    this.canvas.addEventListener("pointercancel", () => {
      start = null;
      dragging = false;
    });

    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const distance = this.camera.position.length();
        const next = Math.max(1.6, Math.min(12, distance + event.deltaY * 0.0022));
        this.camera.position.setLength(next);
      },
      { passive: false }
    );
  }

  /** Что находится под курсором: аппарат, плоскость, пункт или ничего. */
  pick() {
    if (!this.bundle) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = [...this.constellation.pickTargets(), ...this.earth.markers];
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      if (hit.object === this.constellation.picker) {
        const owner = this.constellation.ownerForInstance(hit.instanceId);
        if (owner) return owner;
      }
      if (hit.object.userData.owner) return hit.object.userData.owner;
    }
    return null;
  }
}

/**
 * Развернуть группу так, чтобы точка смотрела в камеру.
 *
 * Порядок поворотов в three.js — XYZ, то есть вектор преобразуется как
 * RX·RY·v. Сначала поворотом вокруг Y приводим точку в плоскость YZ со
 * стороны камеры: при p = (r·cos α, y, r·sin α) получаем x' = r·cos(α − φ),
 * и обнуление даёт φ = α − π/2 (знак выбран так, чтобы z' вышло
 * положительным, то есть точка оказалась к нам лицом, а не с обратной
 * стороны планеты). Затем поворотом вокруг X поднимаем её к центру кадра:
 * нужный угол равен atan2(y, √(x² + z²)).
 *
 * Множитель `lift` меньше единицы намеренно: при полном доведении до центра
 * взгляд становится строго сверху, сфера читается как круг, а орбитальные
 * кольца вырождаются в прямые.
 */
function aimAt(group, point, lift) {
  const horizontal = Math.hypot(point.x, point.z);
  group.rotation.y = Math.atan2(point.z, point.x) - Math.PI / 2;
  group.rotation.x = Math.max(
    -1.2,
    Math.min(1.2, Math.atan2(point.y, Math.max(horizontal, 1e-9)) * lift)
  );
}

function toSceneTriple(positions, index) {
  return toScene(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
}
