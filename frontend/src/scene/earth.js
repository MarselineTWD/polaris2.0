/* global THREE */
/**
 * Земля, атмосфера, звёзды и наземные пункты.
 *
 * Всё содержимое вращается вместе с планетой: угол поворота берётся из
 * орбитальной модели (`earth_angle0 + OMEGA * t`), а не подбирается на глаз,
 * поэтому наземный пункт под спутником на экране действительно находится
 * в зоне радиовидимости, посчитанной ядром.
 */

import { groundToScene } from "../model/orbit.js";

const CLIENT_COLOR = 0x54efc7;
const GATEWAY_COLOR = 0xffc75c;

export class Earth {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);

    const loader = new THREE.TextureLoader();
    const day = loader.load("./assets/earth-day.jpg");
    day.colorSpace = THREE.SRGBColorSpace;
    day.anisotropy = 4;

    this.globe = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.MeshPhongMaterial({
        map: day,
        normalMap: loader.load("./assets/earth-normal.jpg"),
        normalScale: new THREE.Vector2(0.55, 0.55),
        specularMap: loader.load("./assets/earth-specular.jpg"),
        specular: new THREE.Color(0x2a3a55),
        shininess: 14,
      })
    );
    this.group.add(this.globe);

    // Ореол атмосферы: полупрозрачная сфера чуть большего радиуса,
    // видимая только «с изнанки», даёт мягкий край планеты.
    this.group.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1.035, 64, 48),
        new THREE.MeshBasicMaterial({
          color: 0x3f7fd0,
          transparent: true,
          opacity: 0.16,
          side: THREE.BackSide,
        })
      )
    );

    this.sites = new Map();
    this.markers = [];
  }

  /** Заново расставить наземные пункты по данным пакета. */
  setSites(groundSites) {
    for (const entry of this.sites.values()) {
      this.group.remove(entry.group);
      entry.group.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) node.material.dispose();
      });
    }
    this.sites.clear();
    this.markers = [];

    for (const site of groundSites) {
      const isGateway = site.role === "gateway";
      const color = isGateway ? GATEWAY_COLOR : CLIENT_COLOR;
      const group = new THREE.Group();
      const [x, y, z] = groundToScene(site.lat_deg, site.lon_deg);
      group.position.set(x, y, z);
      group.lookAt(0, 0, 0);

      const pin = new THREE.Mesh(
        isGateway
          ? new THREE.ConeGeometry(0.022, 0.075, 16)
          : new THREE.CylinderGeometry(0.009, 0.009, 0.06, 12),
        new THREE.MeshBasicMaterial({ color })
      );
      pin.rotation.x = Math.PI / 2;
      pin.position.z = -0.03;
      group.add(pin);

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(isGateway ? 0.03 : 0.022, 16, 12),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
      );
      halo.position.z = -0.07;
      halo.userData.owner = { type: isGateway ? "gateway" : "client", id: site.id };
      group.add(halo);

      // Невидимая мишень увеличенного размера — чтобы в пункт было легко попасть курсором.
      const target = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      target.position.z = -0.07;
      target.userData.owner = { type: isGateway ? "gateway" : "client", id: site.id };
      group.add(target);

      this.group.add(group);
      this.sites.set(site.id, { group, halo, site, baseColor: color });
      this.markers.push(target, halo);
    }
  }

  /** Подсветить пункты, входящие в текущий маршрут. */
  highlight(activeIds) {
    for (const [id, entry] of this.sites) {
      const active = activeIds.has(id);
      entry.halo.material.color.setHex(active ? 0xffffff : entry.baseColor);
      entry.halo.scale.setScalar(active ? 1.35 : 1);
    }
  }

  /** Повернуть планету на угол θ, посчитанный орбитальной моделью. */
  setAngle(theta) {
    this.group.rotation.y = theta;
  }

  /** Положение наземного пункта в инерциальных координатах сцены. */
  sitePosition(siteId, target) {
    const entry = this.sites.get(siteId);
    if (!entry) return null;
    return target.copy(entry.group.position).applyAxisAngle(UP, this.group.rotation.y);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

export function createStarfield(count = 900) {
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    // Равномерное распределение по сфере: широта берётся через arccos,
    // иначе звёзды сгущаются у полюсов.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const radius = 26 + Math.random() * 16;
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi);
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0x9fb6d8, size: 0.11, sizeAttenuation: true, transparent: true, opacity: 0.75 })
  );
}
