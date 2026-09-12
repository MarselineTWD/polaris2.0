/**
 * 3D-вид: сборка сцены, управление камерой и выбор объектов.
 *
 * Модуль не знает ни про API, ни про панели: он получает пакет расчёта и
 * текущий выбор, а наружу сообщает, по какому объекту кликнули.
 */

import * as THREE from "../../vendor/three.module.min.js";
import { Earth, createStarfield } from "./earth.js";
import { Constellation } from "./constellation.js";
import { Network } from "./network.js";
import { OrbitModel, toScene } from "../model/orbit.js";

const HOME_CAMERA = new THREE.Vector3(0.2, 0.35, 5.15);
const HOME_ROTATION = { x: -0.12, y: -0.28 };

export class Viewer {
  constructor(canvas, { onPick, onHover, onCameraControl, onAssetsReady, onAssetError } = {}) {
    this.canvas = canvas;
    this.onPick = onPick;
    this.onHover = onHover;
    this.onCameraControl = onCameraControl;

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

    this.earth = new Earth(this.world, { onAssetsReady, onAssetError });
    this.constellation = new Constellation(this.world);
    this.network = null;
    this.model = null;
    this.bundle = null;

    this.raycaster = new THREE.Raycaster();
    // У линий Three.js по умолчанию огромный порог выбора (1 единица сцены),
    // поэтому орбитальная плоскость перехватывала наведение почти везде.
    this.raycaster.params.Line.threshold = 0.018;
    this.pointer = new THREE.Vector2();
    this.scratch = new THREE.Vector3();
    this.pickWorld = new THREE.Vector3();
    this.pickProjected = new THREE.Vector3();
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
      this.world.remove(this.network.groundVisibility);
      this.world.remove(this.network.route);
      this.world.remove(this.network.routeGlow);
    }
    this.network = new Network(this.world, bundle.pairCount, bundle.satelliteCount);
  }

  /**
   * Перерисовать кадр.
   *
   * @param options.seconds       модельное время
   * @param options.step          отсчёт расчётной сетки
   * @param options.routeIndices  индексы аппаратов маршрута
   * @param options.routeSites    идентификаторы наземных узлов маршрута
   */
  render({
    seconds,
    step,
    routeIndices,
    routeSites,
    selectedIndex,
    trackedIndex,
    visibilitySiteId,
    visibleIndices,
    showLinks,
    showOrbits,
    showRoute,
  }) {
    if (!this.bundle || !this.model) return;

    const positions = this.model.propagate(seconds);
    this.headlight.position.copy(this.camera.position);
    this.earth.setAngle(this.model.earthAngle(seconds));
    this.constellation.setOrbitsVisible(showOrbits);
    this.constellation.update(positions, step, routeIndices, selectedIndex, visibleIndices);
    this.network.updateLinks(this.bundle, step, positions, showLinks);

    const visibilityOrigin = visibilitySiteId
      ? this.earth.sitePosition(visibilitySiteId, VISIBILITY_ORIGIN)
      : null;
    this.network.updateGroundVisibility(visibilityOrigin, visibleIndices, positions);

    if (trackedIndex >= 0) {
      const [x, y, z] = toSceneTriple(positions, trackedIndex);
      this.scratch.set(x, y, z);
      aimAt(this.world, this.scratch, 1);
    }

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
    let pressedOwner = null;
    let previous = { x: 0, y: 0 };

    const setPointer = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    this.canvas.addEventListener("pointerdown", (event) => {
      setPointer(event);
      start = { x: event.clientX, y: event.clientY };
      previous = { x: event.clientX, y: event.clientY };
      pressedOwner = this.pick();
      dragging = false;
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (start) {
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved > 7 && !dragging) {
          dragging = true;
          if (this.onCameraControl) this.onCameraControl();
        }
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
        // При проигрывании аппарат движется и может покинуть зону pointerup.
        // В таком случае выбираем объект, который был нажат изначально.
        const hit = pressedOwner || this.pick();
        if (hit && this.onPick) this.onPick(hit);
      }
      start = null;
      pressedOwner = null;
      dragging = false;
    });

    this.canvas.addEventListener("pointercancel", () => {
      start = null;
      pressedOwner = null;
      dragging = false;
    });

    this.canvas.addEventListener("pointerleave", (event) => {
      start = null;
      pressedOwner = null;
      dragging = false;
      if (this.onHover) this.onHover(null, event);
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

    // Сначала интерактивные объекты, затем орбиты. Иначе тонкая, но очень
    // длинная линия плоскости оказывается ближе к камере и забирает событие.
    if (this.constellation.picker) {
      const satelliteHit = this.raycaster.intersectObject(this.constellation.picker, false)[0];
      if (satelliteHit) {
        const owner = this.constellation.ownerForInstance(satelliteHit.instanceId);
        if (owner) return owner;
      }
    }
    const projectedSatellite = this.pickProjectedSatellite();
    if (projectedSatellite) return projectedSatellite;
    const markerHit = this.raycaster.intersectObjects(this.earth.markers, false)[0];
    if (markerHit?.object.userData.owner) return markerHit.object.userData.owner;

    const orbitHit = this.raycaster.intersectObjects(this.constellation.orbits.children, false)[0];
    if (orbitHit?.object.userData.owner) {
      return orbitHit.object.userData.owner;
    }
    return null;
  }

  /**
   * Резервный выбор по экранному центру аппарата.
   *
   * Он не зависит от broad-phase InstancedMesh и сохраняет удобную область
   * 16–22 px даже в небольшом окне. Аппараты за Землёй исключаются.
   */
  pickProjectedSatellite() {
    if (!this.model || !this.bundle) return null;
    this.world.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const radius = Math.max(16, Math.min(22, width * 0.016));
    const stage = this.bundle.design.launch_stage;
    let best = null;
    let bestDistance = radius;

    for (let index = 0; index < this.bundle.satellites.length; index += 1) {
      const satellite = this.bundle.satellites[index];
      if (satellite.launch_batch > stage) continue;
      const [x, y, z] = toSceneTriple(this.model.positions, index);
      this.pickWorld.set(x, y, z).applyMatrix4(this.world.matrixWorld);
      if (occludedByEarth(this.camera.position, this.pickWorld)) continue;
      this.pickProjected.copy(this.pickWorld).project(this.camera);
      if (this.pickProjected.z < -1 || this.pickProjected.z > 1) continue;
      const dx = (this.pickProjected.x - this.pointer.x) * width / 2;
      const dy = (this.pickProjected.y - this.pointer.y) * height / 2;
      const distance = Math.hypot(dx, dy);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { type: "satellite", id: satellite.id };
      }
    }
    return best;
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

function occludedByEarth(camera, target) {
  const dx = target.x - camera.x;
  const dy = target.y - camera.y;
  const dz = target.z - camera.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared <= 1e-12) return false;
  const projection = Math.max(
    0,
    Math.min(1, -(camera.x * dx + camera.y * dy + camera.z * dz) / lengthSquared)
  );
  if (projection <= 0 || projection >= 0.999) return false;
  const closestX = camera.x + projection * dx;
  const closestY = camera.y + projection * dy;
  const closestZ = camera.z + projection * dz;
  return closestX * closestX + closestY * closestY + closestZ * closestZ < 0.985 ** 2;
}

const VISIBILITY_ORIGIN = new THREE.Vector3();
