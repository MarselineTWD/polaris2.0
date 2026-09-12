/* global THREE */
/**
 * Линии сети: межспутниковые связи и текущий маршрут.
 *
 * Состав связей берётся из расчётного пакета, а не воспроизводится в браузере
 * по эвристике: на экране видно ровно то, по чему считались доступность
 * и маршруты.
 */

import { toScene } from "../model/orbit.js";

export class Network {
  constructor(parent, maxPairs) {
    this.maxPairs = maxPairs;

    this.linkPositions = new Float32Array(maxPairs * 6);
    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(this.linkPositions, 3));
    linkGeometry.setDrawRange(0, 0);
    this.links = new THREE.LineSegments(
      linkGeometry,
      new THREE.LineBasicMaterial({ color: 0x4d8cc7, transparent: true, opacity: 0.22 })
    );
    this.links.frustumCulled = false;
    parent.add(this.links);

    // Маршрут: до 32 узлов с запасом, рисуется поверх остальных линий.
    this.routePositions = new Float32Array(32 * 3);
    const routeGeometry = new THREE.BufferGeometry();
    routeGeometry.setAttribute("position", new THREE.BufferAttribute(this.routePositions, 3));
    routeGeometry.setDrawRange(0, 0);
    this.route = new THREE.Line(
      routeGeometry,
      new THREE.LineBasicMaterial({ color: 0x54efc7, transparent: true, opacity: 0.95 })
    );
    this.route.frustumCulled = false;
    this.route.renderOrder = 2;
    parent.add(this.route);

    this.routeGlow = new THREE.Points(
      routeGeometry,
      new THREE.PointsMaterial({ color: 0x9dffe4, size: 0.05, transparent: true, opacity: 0.9 })
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
      const first = toScene(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
      const second = toScene(positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
      this.linkPositions[offset] = first[0];
      this.linkPositions[offset + 1] = first[1];
      this.linkPositions[offset + 2] = first[2];
      this.linkPositions[offset + 3] = second[0];
      this.linkPositions[offset + 4] = second[1];
      this.linkPositions[offset + 5] = second[2];
      segment += 1;
    }
    this.links.geometry.attributes.position.needsUpdate = true;
    this.links.geometry.setDrawRange(0, segment * 2);
    return pairs.length;
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
