/**
 * Линии сети: межспутниковые связи и текущий маршрут.
 *
 * Состав связей берётся из расчётного пакета, а не воспроизводится в браузере
 * по эвристике: на экране видно ровно то, по чему считались доступность
 * и маршруты.
 */

import * as THREE from "../../vendor/three.module.min.js";
import { SCENE_SCALE } from "../model/orbit.js";

export class Network {
  constructor(parent, maxPairs, maxSatellites) {
    this.maxPairs = maxPairs;

    this.linkPositions = new Float32Array(maxPairs * 6);
    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(this.linkPositions, 3));
    linkGeometry.setDrawRange(0, 0);
    this.links = new THREE.LineSegments(
      linkGeometry,
      new THREE.LineBasicMaterial({
        color: 0x6ab5ff,
        transparent: true,
        opacity: 0.48,
        toneMapped: false,
      })
    );
    this.links.frustumCulled = false;
    parent.add(this.links);

    // Контекстный слой: только лучи из выбранного наземного пункта к тем
    // аппаратам, которые он действительно видит на текущем отсчёте.
    this.visibilityPositions = new Float32Array(maxSatellites * 6);
    const visibilityGeometry = new THREE.BufferGeometry();
    visibilityGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.visibilityPositions, 3)
    );
    visibilityGeometry.setDrawRange(0, 0);
    this.groundVisibility = new THREE.LineSegments(
      visibilityGeometry,
      new THREE.LineBasicMaterial({
        color: 0x48d7ff,
        transparent: true,
        opacity: 0.38,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    this.groundVisibility.frustumCulled = false;
    this.groundVisibility.renderOrder = 1;
    parent.add(this.groundVisibility);

    // Маршрут: до 32 узлов с запасом, рисуется поверх остальных линий.
    this.routePositions = new Float32Array(32 * 3);
    const routeGeometry = new THREE.BufferGeometry();
    routeGeometry.setAttribute("position", new THREE.BufferAttribute(this.routePositions, 3));
    routeGeometry.setDrawRange(0, 0);
    this.route = new THREE.Line(
      routeGeometry,
      new THREE.LineBasicMaterial({
        color: 0x32ffc4,
        transparent: true,
        opacity: 1,
        depthTest: false,
        toneMapped: false,
      })
    );
    this.route.frustumCulled = false;
    this.route.renderOrder = 2;
    parent.add(this.route);

    this.routeGlow = new THREE.Points(
      routeGeometry,
      new THREE.PointsMaterial({
        color: 0xb6ffeb,
        size: 0.065,
        transparent: true,
        opacity: 1,
        depthTest: false,
        toneMapped: false,
      })
    );
    this.routeGlow.frustumCulled = false;
    this.routeGlow.renderOrder = 3;
    parent.add(this.routeGlow);
  }

  /** Перерисовать межспутниковые связи отсчёта. */
  updateLinks(bundle, step, positions, visible) {
    this.links.visible = visible;
    if (!visible) {
      this.links.geometry.setDrawRange(0, 0);
      return 0;
    }

    const pairs = bundle.islPairs(step);
    let segment = 0;
    for (const pair of pairs) {
      if (segment >= this.maxPairs) break;
      const a = bundle.pairI[pair];
      const b = bundle.pairJ[pair];
      const offset = segment * 6;
      writeScenePosition(this.linkPositions, offset, positions, a);
      writeScenePosition(this.linkPositions, offset + 3, positions, b);
      segment += 1;
    }
    this.links.geometry.attributes.position.needsUpdate = true;
    this.links.geometry.setDrawRange(0, segment * 2);
    return pairs.length;
  }

  /** Показать радиовидимость только для одного выбранного наземного пункта. */
  updateGroundVisibility(origin, satelliteIndices, positions) {
    const show = origin && satelliteIndices.size > 0;
    this.groundVisibility.visible = Boolean(show);
    if (!show) {
      this.groundVisibility.geometry.setDrawRange(0, 0);
      return;
    }

    let segment = 0;
    for (const index of satelliteIndices) {
      const offset = segment * 6;
      this.visibilityPositions[offset] = origin.x;
      this.visibilityPositions[offset + 1] = origin.y;
      this.visibilityPositions[offset + 2] = origin.z;
      writeScenePosition(this.visibilityPositions, offset + 3, positions, index);
      segment += 1;
    }
    this.groundVisibility.geometry.attributes.position.needsUpdate = true;
    this.groundVisibility.geometry.setDrawRange(0, segment * 2);
  }

  /**
   * Перерисовать маршрут.
   *
   * @param nodes массив точек в координатах сцены: клиент, аппараты, шлюз
   */
  updateRoute(nodes, visible) {
    const show = visible && nodes.length > 1;
    this.route.visible = show;
    this.routeGlow.visible = show;
    if (!show) {
      this.route.geometry.setDrawRange(0, 0);
      return;
    }
    const limit = Math.min(nodes.length, 32);
    for (let index = 0; index < limit; index += 1) {
      this.routePositions[index * 3] = nodes[index].x;
      this.routePositions[index * 3 + 1] = nodes[index].y;
      this.routePositions[index * 3 + 2] = nodes[index].z;
    }
    this.route.geometry.attributes.position.needsUpdate = true;
    this.route.geometry.setDrawRange(0, limit);
  }
}

/** Записать координаты модели сразу в GPU-буфер без временных массивов. */
function writeScenePosition(target, offset, positions, satelliteIndex) {
  const source = satelliteIndex * 3;
  target[offset] = positions[source] * SCENE_SCALE;
  target[offset + 1] = positions[source + 2] * SCENE_SCALE;
  target[offset + 2] = -positions[source + 1] * SCENE_SCALE;
}
