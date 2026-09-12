/* global THREE */
"use strict";

const $ = (id) => document.getElementById(id);
const canvas = $("space-canvas");

const scenarios = {
  full: { title: "Полная группировка", stage: 3, range: 3000, failures: [], metrics: {
    C65: { availability: 96.67, visibility: 97.78, outage: "8 мин", hops: "2,29" },
    C70: { availability: 98.75, visibility: 99.86, outage: "2 мин", hops: "2,66" },
    C72: { availability: 98.89, visibility: 100, outage: "2 мин", hops: "3,15" }
  }},
  first: { title: "Первая очередь запуска", stage: 1, range: 3000, failures: [], metrics: {
    C65: { availability: 27.22, visibility: 38.19, outage: "572 мин", hops: "2,07" },
    C70: { availability: 15.83, visibility: 48.75, outage: "658 мин", hops: "2,14" },
    C72: { availability: 12.64, visibility: 58.47, outage: "796 мин", hops: "3,12" }
  }},
  outages: { title: "Недоступность десяти аппаратов", stage: 3, range: 3000,
    failures: ["S03", "S07", "S11", "S16", "S19", "S23", "S27", "S32", "S39", "S45"], metrics: {
    C65: { availability: 79.31, visibility: 84.58, outage: "24 мин", hops: "2,35" },
    C70: { availability: 80.97, visibility: 90.28, outage: "24 мин", hops: "2,75" },
    C72: { availability: 82.64, visibility: 93.06, outage: "20 мин", hops: "3,26" }
  }},
  range: { title: "Дальность ISL 2000 км", stage: 3, range: 2000, failures: [], metrics: {
    C65: { availability: 83.61, visibility: 97.78, outage: "72 мин", hops: "2,29" },
    C70: { availability: 73.19, visibility: 99.86, outage: "72 мин", hops: "2,73" },
    C72: { availability: 75.28, visibility: 100, outage: "4 мин", hops: "3,49" }
  }}
};

const clients = {
  C65: { title: "Терминал C65", coords: "65,0° с. ш. · 60,0° в. д.", lat: 65, lon: 60, route: ["C65", "S07", "S23", "G_MUR"] },
  C70: { title: "Терминал C70", coords: "70,0° с. ш. · 90,0° в. д.", lat: 70, lon: 90, route: ["C70", "S23", "S08", "G_MUR"] },
  C72: { title: "Терминал C72", coords: "72,0° с. ш. · 130,0° в. д.", lat: 72, lon: 130, route: ["C72", "S39", "S24", "S09", "G_MUR"] }
};

const gateways = {
  G_MUR: { title: "Шлюз Мурманск", coords: "68,97° с. ш. · 33,07° в. д.", lat: 68.97, lon: 33.07 }
};

const state = {
  scenario: "full", client: "C70", stage: 3, range: 3000,
  time: 21600, playing: true, speed: 300,
  earthRotation: true, links: true, orbits: true,
  selection: { type: "client", id: "C70" }, customFailures: new Set(), recoveredFailures: new Set()
};

const satelliteData = Array.from({ length: 48 }, (_, index) => {
  const plane = Math.floor(index / 16);
  return {
    id: `S${String(index + 1).padStart(2, "0")}`,
    index, plane, slot: index % 16, batch: plane + 1,
    phase: [0, 7.5, 15][plane] * Math.PI / 180,
    raan: [0, 60, 120][plane] * Math.PI / 180
  };
});
const satelliteById = new Map(satelliteData.map((satellite) => [satellite.id, satellite]));

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 760 ? 1 : 1.35));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050914, 0.045);
const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 100);
camera.position.set(0.2, 0.35, 5.15);

const worldRoot = new THREE.Group();
worldRoot.rotation.set(-0.12, -0.28, 0);
scene.add(worldRoot);
scene.add(new THREE.HemisphereLight(0x8dbdff, 0x02040a, 0.55));
const sunlight = new THREE.DirectionalLight(0xffffff, 3.1);
sunlight.position.set(-4.5, 2.8, 4.8);
scene.add(sunlight);
const rimLight = new THREE.PointLight(0x3c7dff, 11, 12, 2);
rimLight.position.set(3.7, -1.4, -3.5);
scene.add(rimLight);

const textureLoader = new THREE.TextureLoader();
const earthMap = textureLoader.load("./assets/earth-day.jpg");
earthMap.colorSpace = THREE.SRGBColorSpace;
earthMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const earthNormal = textureLoader.load("./assets/earth-normal.jpg");
const earthSpecular = textureLoader.load("./assets/earth-specular.jpg");

const earthSystem = new THREE.Group();
worldRoot.add(earthSystem);
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(1.2, 64, 64),
  new THREE.MeshPhongMaterial({
    map: earthMap, normalMap: earthNormal, specularMap: earthSpecular,
    normalScale: new THREE.Vector2(0.72, 0.72), specular: 0x586b7f, shininess: 12
  })
);
earth.rotation.y = -1.28;
earthSystem.add(earth);

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.235, 48, 48),
  new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false,
    uniforms: { glowColor: { value: new THREE.Color(0x438eff) }, viewVector: { value: camera.position } },
    vertexShader: "varying vec3 vNormal; varying vec3 vPositionNormal; void main(){vNormal=normalize(normalMatrix*normal);vPositionNormal=normalize((modelViewMatrix*vec4(position,1.0)).xyz);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
    fragmentShader: "uniform vec3 glowColor;varying vec3 vNormal;varying vec3 vPositionNormal;void main(){float i=pow(0.72-dot(vNormal,-vPositionNormal),3.0);gl_FragColor=vec4(glowColor,0.52*i); }"
  })
);
worldRoot.add(atmosphere);

const starPositions = new Float32Array(650 * 3);
for (let i = 0; i < starPositions.length; i += 3) {
  const radius = 10 + Math.random() * 16;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  starPositions[i] = radius * Math.sin(phi) * Math.cos(theta);
  starPositions[i + 1] = radius * Math.cos(phi);
  starPositions[i + 2] = radius * Math.sin(phi) * Math.sin(theta);
}
const starsGeometry = new THREE.BufferGeometry();
starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
scene.add(new THREE.Points(starsGeometry, new THREE.PointsMaterial({ color: 0xa8c8ff, size: 0.015, transparent: true, opacity: 0.7, sizeAttenuation: true })));

function makePanelTexture() {
  const panelCanvas = document.createElement("canvas");
  panelCanvas.width = panelCanvas.height = 128;
  const context = panelCanvas.getContext("2d");
  context.fillStyle = "#0b2c58";
  context.fillRect(0, 0, 128, 128);
  context.strokeStyle = "#397fc5";
  context.lineWidth = 3;
  for (let position = 0; position <= 128; position += 32) {
    context.beginPath(); context.moveTo(position, 0); context.lineTo(position, 128); context.stroke();
    context.beginPath(); context.moveTo(0, position); context.lineTo(128, position); context.stroke();
  }
  const texture = new THREE.CanvasTexture(panelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const materials = {
  bus: new THREE.MeshStandardMaterial({ color: 0xc7d2df, metalness: 0.82, roughness: 0.28 }),
  busRoute: new THREE.MeshStandardMaterial({ color: 0xaaffea, emissive: 0x1f9e7d, emissiveIntensity: 0.65, metalness: 0.72, roughness: 0.24 }),
  busFailed: new THREE.MeshStandardMaterial({ color: 0x7d273a, emissive: 0x641327, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.45 }),
  busInactive: new THREE.MeshStandardMaterial({ color: 0x293343, metalness: 0.4, roughness: 0.6 }),
  panel: new THREE.MeshStandardMaterial({ map: makePanelTexture(), color: 0x7db7ff, emissive: 0x071b38, emissiveIntensity: 0.4, metalness: 0.38, roughness: 0.42 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x303b49, metalness: 0.75, roughness: 0.34 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd9aa54, metalness: 0.7, roughness: 0.28 }),
  click: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
};
const geometry = {
  bus: new THREE.BoxGeometry(0.105, 0.075, 0.085),
  panel: new THREE.BoxGeometry(0.13, 0.008, 0.067),
  boom: new THREE.CylinderGeometry(0.009, 0.009, 0.08, 8),
  dish: new THREE.ConeGeometry(0.034, 0.03, 16, 1, true),
  beacon: new THREE.SphereGeometry(0.012, 8, 8),
  click: new THREE.SphereGeometry(0.125, 10, 10)
};

const orbitSystem = new THREE.Group();
worldRoot.add(orbitSystem);
const satelliteGroups = [];
const interactiveObjects = [];

function createInstances(itemGeometry, material, count) {
  const mesh = new THREE.InstancedMesh(itemGeometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  orbitSystem.add(mesh);
  return mesh;
}

const satelliteInstances = {
  bus: createInstances(geometry.bus, materials.bus, 48),
  panel: createInstances(geometry.panel, materials.panel, 96),
  boom: createInstances(geometry.boom, materials.dark, 48),
  dish: createInstances(geometry.dish, materials.gold, 48),
  beacon: createInstances(geometry.beacon, new THREE.MeshBasicMaterial({ color: 0xffffff }), 48),
  click: createInstances(geometry.click, materials.click, 48)
};
satelliteInstances.click.userData = { type: "satellite-set" };
interactiveObjects.push(satelliteInstances.click);

function makeSatellite(data) {
  const group = new THREE.Group();
  group.userData = { type: "satellite", id: data.id };
  orbitSystem.add(group);
  satelliteGroups.push(group);
}
satelliteData.forEach(makeSatellite);

const componentMatrix = {
  leftPanel: new THREE.Matrix4().makeTranslation(-0.122, 0, 0),
  rightPanel: new THREE.Matrix4().makeTranslation(0.122, 0, 0),
  boom: new THREE.Matrix4().makeTranslation(0, 0.073, 0),
  dish: new THREE.Matrix4().compose(new THREE.Vector3(0, 0.125, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)), new THREE.Vector3(1, 1, 1)),
  beacon: new THREE.Matrix4().makeTranslation(0, -0.048, 0)
};
const instanceMatrix = new THREE.Matrix4();
const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

const orbitLines = [];
for (let plane = 0; plane < 3; plane += 1) {
  const points = [];
  for (let step = 0; step <= 128; step += 1) {
    const point = new THREE.Vector3();
    setOrbitPoint(point, plane, step / 128 * Math.PI * 2);
    points.push(point);
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: plane === 1 ? 0x445d99 : 0x31486e, transparent: true, opacity: 0.34 })
  );
  line.userData = { type: "plane", id: plane };
  orbitSystem.add(line);
  orbitLines.push(line);
  interactiveObjects.push(line);
}

const groundObjects = new Map();
function latLonPosition(target, lat, lon, radius = 1.225) {
  const latitude = lat * Math.PI / 180;
  const longitude = (lon - 90) * Math.PI / 180;
  return target.set(
    radius * Math.cos(latitude) * Math.cos(longitude),
    radius * Math.sin(latitude),
    radius * Math.cos(latitude) * Math.sin(longitude)
  );
}

function addGroundObject(id, data, type, color) {
  const group = new THREE.Group();
  latLonPosition(group.position, data.lat, data.lon);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(type === "gateway" ? 0.035 : 0.028, 12, 12), new THREE.MeshBasicMaterial({ color }));
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.065, 24), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false }));
  halo.lookAt(group.position.clone().multiplyScalar(2));
  const target = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), materials.click);
  target.userData = { type, id, owner: group };
  group.add(marker, halo, target);
  earthSystem.add(group);
  groundObjects.set(id, group);
  interactiveObjects.push(target);
}
Object.entries(clients).forEach(([id, data]) => addGroundObject(id, data, "client", 0x54efc7));
Object.entries(gateways).forEach(([id, data]) => addGroundObject(id, data, "gateway", 0x7188ff));

const MAX_LINKS = 120;
const networkPositions = new Float32Array(MAX_LINKS * 6);
const networkGeometry = new THREE.BufferGeometry();
networkGeometry.setAttribute("position", new THREE.BufferAttribute(networkPositions, 3).setUsage(THREE.DynamicDrawUsage));
networkGeometry.setDrawRange(0, 0);
const networkLines = new THREE.LineSegments(networkGeometry, new THREE.LineBasicMaterial({ color: 0x4d8cc7, transparent: true, opacity: 0.22 }));
worldRoot.add(networkLines);

const routePositions = new Float32Array(6 * 3);
const routeGeometry = new THREE.BufferGeometry();
routeGeometry.setAttribute("position", new THREE.BufferAttribute(routePositions, 3).setUsage(THREE.DynamicDrawUsage));
routeGeometry.setDrawRange(0, 0);
const routeLine = new THREE.Line(routeGeometry, new THREE.LineBasicMaterial({ color: 0x54efc7, transparent: true, opacity: 0.95 }));
worldRoot.add(routeLine);

function setOrbitPoint(target, plane, angle) {
  const radius = 1.73;
  const inclination = 87 * Math.PI / 180;
  const raan = [0, 60, 120][plane] * Math.PI / 180;
  const x = radius * Math.cos(angle);
  const y = radius * Math.sin(angle) * Math.sin(inclination);
  const z = radius * Math.sin(angle) * Math.cos(inclination);
  target.set(x * Math.cos(raan) - z * Math.sin(raan), y, x * Math.sin(raan) + z * Math.cos(raan));
  return target;
}

function isDeployed(data) { return data.batch <= state.stage; }
function isFailed(id) { return (scenarios[state.scenario].failures.includes(id) && !state.recoveredFailures.has(id)) || state.customFailures.has(id); }
function isRouteSatellite(id) { return clients[state.client].route.includes(id); }
function isActive(data) { return isDeployed(data) && !isFailed(data.id); }

function refreshSatelliteStyles() {
  satelliteData.forEach((data, index) => {
    const deployed = isDeployed(data);
    const failed = isFailed(data.id);
    satelliteGroups[index].visible = deployed;
    satelliteInstances.bus.setColorAt(index, new THREE.Color(!deployed ? 0x293343 : failed ? 0x7d273a : isRouteSatellite(data.id) ? 0x54efc7 : 0xc7d2df));
    satelliteInstances.beacon.setColorAt(index, new THREE.Color(failed ? 0xff5d7d : isRouteSatellite(data.id) ? 0x54efc7 : 0x82c6ff));
  });
  satelliteInstances.bus.instanceColor.needsUpdate = true;
  satelliteInstances.beacon.instanceColor.needsUpdate = true;
  const activeCount = satelliteData.filter(isActive).length;
  $("active-count").textContent = String(activeCount);
  $("header-count").textContent = `${activeCount} аппаратов`;
  renderFailureList();
}

function updateSatellitePositions() {
  const orbitalTime = state.time / 86400 * Math.PI * 2;
  satelliteData.forEach((data, index) => {
    const angle = data.slot / 16 * Math.PI * 2 + data.phase + orbitalTime * 14.8;
    const group = satelliteGroups[index];
    setOrbitPoint(group.position, data.plane, angle);
    group.rotation.y = -angle;
    group.updateMatrix();
    const base = isDeployed(data) ? group.matrix : hiddenMatrix;
    satelliteInstances.bus.setMatrixAt(index, base);
    satelliteInstances.click.setMatrixAt(index, base);
    satelliteInstances.panel.setMatrixAt(index * 2, instanceMatrix.multiplyMatrices(base, componentMatrix.leftPanel));
    satelliteInstances.panel.setMatrixAt(index * 2 + 1, instanceMatrix.multiplyMatrices(base, componentMatrix.rightPanel));
    satelliteInstances.boom.setMatrixAt(index, instanceMatrix.multiplyMatrices(base, componentMatrix.boom));
    satelliteInstances.dish.setMatrixAt(index, instanceMatrix.multiplyMatrices(base, componentMatrix.dish));
    satelliteInstances.beacon.setMatrixAt(index, instanceMatrix.multiplyMatrices(base, componentMatrix.beacon));
  });
  Object.values(satelliteInstances).forEach((mesh) => { mesh.instanceMatrix.needsUpdate = true; });
}

const tempA = new THREE.Vector3();
const tempB = new THREE.Vector3();
function objectPositionInWorldRoot(target, object) {
  object.getWorldPosition(target);
  return worldRoot.worldToLocal(target);
}

function writeSegment(array, segment, a, b) {
  const offset = segment * 6;
  array[offset] = a.x; array[offset + 1] = a.y; array[offset + 2] = a.z;
  array[offset + 3] = b.x; array[offset + 4] = b.y; array[offset + 5] = b.z;
}

function updateNetworkGeometry() {
  worldRoot.updateMatrixWorld(true);
  let segment = 0;
  if (state.links) {
    for (let index = 0; index < satelliteData.length && segment < MAX_LINKS; index += 1) {
      const data = satelliteData[index];
      if (!isActive(data)) continue;
      const samePlaneIndex = data.plane * 16 + (data.slot + 1) % 16;
      if (isActive(satelliteData[samePlaneIndex])) {
        objectPositionInWorldRoot(tempA, satelliteGroups[index]);
        objectPositionInWorldRoot(tempB, satelliteGroups[samePlaneIndex]);
        writeSegment(networkPositions, segment++, tempA, tempB);
      }
      if (state.range >= 2500 && data.plane < 2 && data.slot % 2 === 0) {
        const crossIndex = (data.plane + 1) * 16 + data.slot;
        if (isActive(satelliteData[crossIndex])) {
          objectPositionInWorldRoot(tempA, satelliteGroups[index]);
          objectPositionInWorldRoot(tempB, satelliteGroups[crossIndex]);
          writeSegment(networkPositions, segment++, tempA, tempB);
        }
      }
    }
  }
  networkGeometry.attributes.position.needsUpdate = true;
  networkGeometry.setDrawRange(0, segment * 2);
  networkLines.visible = state.links;
  $("links-count").textContent = String(segment);

  const route = clients[state.client].route;
  const routeBroken = route.some((id) => satelliteById.has(id) && !isActive(satelliteById.get(id)));
  let pointCount = 0;
  route.forEach((id) => {
    const object = satelliteById.has(id) ? satelliteGroups[satelliteById.get(id).index] : groundObjects.get(id);
    if (!object || (satelliteById.has(id) && !isActive(satelliteById.get(id)))) return;
    objectPositionInWorldRoot(tempA, object);
    routePositions[pointCount * 3] = tempA.x;
    routePositions[pointCount * 3 + 1] = tempA.y;
    routePositions[pointCount * 3 + 2] = tempA.z;
    pointCount += 1;
  });
  routeGeometry.attributes.position.needsUpdate = true;
  routeGeometry.setDrawRange(0, pointCount);
  routeLine.visible = state.links && !routeBroken && pointCount > 1;
}

function formatTime(seconds, includeSeconds = false) {
  const value = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const secs = Math.floor(value % 60);
  return [hours, minutes, ...(includeSeconds ? [secs] : [])].map((part) => String(part).padStart(2, "0")).join(":");
}

function metric() { return scenarios[state.scenario].metrics[state.client]; }
function routeMarkup(route) {
  return `<div class="route-mini">${route.map((node, index) => `<button type="button" data-route-node="${node}" title="Выбрать ${node}">${node}</button>${index < route.length - 1 ? "<i></i>" : ""}`).join("")}</div>`;
}

function bindRouteButtons(host) {
  host.querySelectorAll("[data-route-node]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.routeNode;
    state.selection = satelliteById.has(id) ? { type: "satellite", id } : clients[id] ? { type: "client", id } : { type: "gateway", id };
    if (clients[id]) state.client = id;
    refreshSatelliteStyles(); renderInspector(); updateNetworkGeometry();
  }));
}

function renderInspector() {
  const host = $("selection-content");
  const selection = state.selection;
  if (selection.type === "satellite") {
    const data = satelliteById.get(selection.id);
    const failed = isFailed(data.id);
    const deployed = isDeployed(data);
    const inRoute = isRouteSatellite(data.id);
    const status = !deployed ? "Ещё не выведен" : failed ? "Недоступен" : "Активен";
    host.innerHTML = `
      <div class="selection-eyebrow"><span>Спутник · плоскость P${data.plane + 1}</span><span class="selection-status ${failed ? "danger" : ""}">${status}</span></div>
      <h1 class="inspector-title">${data.id}</h1>
      <p class="inspector-subtitle">Аппарат ${data.slot + 1} из 16 · очередь запуска ${data.batch}</p>
      <div class="satellite-preview"><div class="satellite-glyph" aria-hidden="true"></div></div>
      <div class="selection-actions">
        <button class="button ${failed ? "button-subtle" : "button-primary"}" id="toggle-failure" type="button">${failed ? "Вернуть в сеть" : "Добавить отказ"}</button>
        <button class="button button-subtle" id="focus-selection" type="button">Показать</button>
      </div>
      <section class="compact-section"><h3>Параметры</h3><div class="detail-list">
        <div class="detail-row"><span>RAAN</span><strong>${[0, 60, 120][data.plane].toFixed(1)}°</strong></div>
        <div class="detail-row"><span>Фазирование</span><strong>${[0, 7.5, 15][data.plane].toFixed(1)}°</strong></div>
        <div class="detail-row"><span>Высота</span><strong>550 км</strong></div>
        <div class="detail-row"><span>Текущий маршрут</span><strong>${inRoute ? "Участвует" : "Не участвует"}</strong></div>
      </div></section>
      <p class="selection-help">Отказ применяется к текущему варианту и сразу перестраивает визуализацию маршрута. В ТЗ это основной интерактивный сценарий проверки устойчивости.</p>`;
    $("toggle-failure").addEventListener("click", () => toggleFailure(data.id));
    $("focus-selection").addEventListener("click", () => focusObject(satelliteGroups[data.index]));
    return;
  }
  if (selection.type === "plane") {
    const plane = Number(selection.id);
    host.innerHTML = `
      <div class="selection-eyebrow"><span>Орбитальная плоскость</span><span class="selection-status">В расчёте</span></div>
      <h1 class="inspector-title">Плоскость P${plane + 1}</h1>
      <p class="inspector-subtitle">Нажмите «Редактировать», чтобы изменить требуемые ТЗ параметры.</p>
      <section class="compact-section"><h3>Конфигурация</h3><div class="detail-list">
        <div class="detail-row"><span>RAAN</span><strong>${[0, 60, 120][plane].toFixed(1)}°</strong></div>
        <div class="detail-row"><span>Фазирование</span><strong>${[0, 7.5, 15][plane].toFixed(1)}°</strong></div>
        <div class="detail-row"><span>Аппаратов</span><strong>16</strong></div>
        <div class="detail-row"><span>Наклонение</span><strong>87°</strong></div>
      </div></section>
      <div class="selection-actions"><button class="button button-primary" id="edit-plane" type="button">Редактировать проект</button></div>`;
    $("edit-plane").addEventListener("click", () => setDrawer(true));
    return;
  }
  if (selection.type === "gateway") {
    const gateway = gateways[selection.id];
    host.innerHTML = `
      <div class="selection-eyebrow"><span>Наземная станция</span><span class="selection-status">Доступна</span></div>
      <h1 class="inspector-title">${gateway.title}</h1><p class="inspector-subtitle">${gateway.coords}</p>
      <section class="compact-section"><h3>Роль в сети</h3><div class="detail-list">
        <div class="detail-row"><span>Идентификатор</span><strong>${selection.id}</strong></div>
        <div class="detail-row"><span>Тип</span><strong>Шлюзовая станция</strong></div>
        <div class="detail-row"><span>Маршрутов</span><strong>3</strong></div>
      </div></section>`;
    return;
  }
  const client = clients[state.client];
  const currentMetric = metric();
  const goalMet = currentMetric.availability >= 90;
  const brokenBy = client.route.filter((id) => satelliteById.has(id) && isFailed(id));
  host.innerHTML = `
    <div class="selection-eyebrow"><span>Наземный терминал</span><span class="selection-status ${brokenBy.length ? "danger" : ""}">${brokenBy.length ? "Маршрут нарушен" : "Выбран"}</span></div>
    <h1 class="inspector-title">${client.title}</h1><p class="inspector-subtitle">${client.coords}</p>
    <div class="client-switch">${Object.keys(clients).map((id) => `<button type="button" data-client="${id}" class="${state.client === id ? "active" : ""}">${id}</button>`).join("")}</div>
    <div class="client-summary"><div class="client-score"><strong>${String(currentMetric.availability.toFixed(2)).replace(".", ",")}%</strong><span>${goalMet ? "Цель ≥ 90%" : "Ниже цели 90%"}</span></div>
      <div class="progress-track"><span style="width:${currentMetric.availability}%"></span><i></i></div>
    </div>
    <section class="compact-section"><h3>Текущий маршрут</h3>${routeMarkup(client.route)}</section>
    <section class="compact-section"><h3>Показатели</h3><div class="detail-list">
      <div class="detail-row"><span>Радиовидимость</span><strong>${String(currentMetric.visibility).replace(".", ",")}%</strong></div>
      <div class="detail-row"><span>Макс. перерыв</span><strong>${currentMetric.outage}</strong></div>
      <div class="detail-row"><span>Среднее число хопов</span><strong>${currentMetric.hops}</strong></div>
      ${brokenBy.length ? `<div class="detail-row"><span>Причина разрыва</span><strong>${brokenBy.join(", ")} недоступен</strong></div>` : ""}
    </div></section>
    <p class="selection-help">Выберите спутник прямо на сцене, чтобы увидеть его параметры или смоделировать отказ.</p>`;
  host.querySelectorAll("[data-client]").forEach((button) => button.addEventListener("click", () => selectClient(button.dataset.client)));
  bindRouteButtons(host);
}

function renderTimeline() {
  const profiles = { C65: [17, 33, 51, 71, 88], C70: [12, 29, 48, 66, 91], C72: [9, 25, 43, 63, 84] };
  const availabilityHost = $("availability-lanes");
  availabilityHost.innerHTML = Object.entries(profiles).map(([id, cuts]) => {
    const value = scenarios[state.scenario].metrics[id].availability;
    const segments = [
      [0, cuts[0], "available"], [cuts[0], cuts[1], "degraded"], [cuts[1], cuts[2], "available"],
      [cuts[2], cuts[3], "outage"], [cuts[3], cuts[4], "available"], [cuts[4], 100, "degraded"]
    ];
    return `<div class="availability-lane"><span>${id}</span><div class="lane-track">${segments.map(([left, right, type]) => `<i class="lane-segment ${type}" style="left:${left}%;width:${right-left}%"></i>`).join("")}<i class="lane-cursor"></i></div><strong>${String(value.toFixed(1)).replace(".", ",")}%</strong></div>`;
  }).join("");
  updateTimeUI();
}

function updateTimeUI() {
  $("scene-time").textContent = formatTime(state.time);
  $("timeline-time").textContent = formatTime(state.time, true);
  $("time-range").value = String(Math.floor(state.time / 120) * 120);
  const percentage = state.time / 86400 * 100;
  document.querySelectorAll(".lane-cursor").forEach((cursor) => { cursor.style.left = `${percentage}%`; });
}

function renderProject() {
  const scenario = scenarios[state.scenario];
  $("project-name").textContent = scenario.title;
  $("scenario-select").value = state.scenario;
  $("isl-input").value = String(state.range);
  document.querySelectorAll("[data-stage]").forEach((button) => button.classList.toggle("active", Number(button.dataset.stage) === state.stage));
  refreshSatelliteStyles();
  renderTimeline();
  renderInspector();
  updateNetworkGeometry();
}

function renderFailureList() {
  const allFailures = new Set([...scenarios[state.scenario].failures.filter((id) => !state.recoveredFailures.has(id)), ...state.customFailures]);
  $("failure-list").innerHTML = allFailures.size
    ? [...allFailures].map((id) => `<div class="failure-item"><div><strong>${id}</strong><span>00:00–24:00 · недоступен</span></div><button class="mini-action" data-remove-failure="${id}" type="button">Удалить</button></div>`).join("")
    : `<div class="empty-state">В этом варианте нет заданных отказов</div>`;
  $("failure-list").querySelectorAll("[data-remove-failure]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.removeFailure;
    if (scenarios[state.scenario].failures.includes(id)) state.recoveredFailures.add(id);
    state.customFailures.delete(id);
    refreshSatelliteStyles(); renderInspector(); updateNetworkGeometry();
  }));
}

function selectClient(id) {
  state.client = id;
  state.selection = { type: "client", id };
  refreshSatelliteStyles(); renderInspector(); updateNetworkGeometry();
}

function toggleFailure(id) {
  const baselineFailure = scenarios[state.scenario].failures.includes(id);
  if (baselineFailure) {
    if (state.recoveredFailures.has(id)) state.recoveredFailures.delete(id);
    else state.recoveredFailures.add(id);
  } else if (state.customFailures.has(id)) state.customFailures.delete(id);
  else state.customFailures.add(id);
  refreshSatelliteStyles(); renderInspector(); updateNetworkGeometry();
  showToast(isFailed(id) ? `${id}: отказ добавлен, маршрут пересчитан` : `${id}: аппарат возвращён в сеть`);
}

function setDrawer(open) {
  $("configuration-drawer").classList.toggle("open", open);
  $("drawer-backdrop").classList.toggle("open", open);
  $("configuration-drawer").setAttribute("aria-hidden", String(!open));
}

function setCompare(open) {
  $("compare-modal").classList.toggle("open", open);
  $("compare-modal").setAttribute("aria-hidden", String(!open));
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2400);
}

function focusObject(object) {
  objectPositionInWorldRoot(tempA, object);
  worldRoot.rotation.y -= Math.atan2(tempA.x, tempA.z) * 0.35;
  camera.position.z = 4.25;
}

const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.045;
const pointer = new THREE.Vector2();
let pointerStart = null;
let dragging = false;
let previousPointer = { x: 0, y: 0 };
let hoveredOwner = null;

function setPointer(event) {
  const bounds = canvas.getBoundingClientRect();
  pointer.x = (event.clientX - bounds.left) / bounds.width * 2 - 1;
  pointer.y = -(event.clientY - bounds.top) / bounds.height * 2 + 1;
}

function resolveHit(hit) {
  if (hit.object.userData.type === "satellite-set") {
    const satellite = satelliteData[hit.instanceId];
    return { type: "satellite", id: satellite.id, owner: satelliteGroups[satellite.index] };
  }
  return hit.object.userData;
}

function pick(event, hoverOnly = false) {
  setPointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(interactiveObjects, false).find((item) => item.object.visible && item.object.parent.visible);
  const hitData = hit ? resolveHit(hit) : null;
  if (hoveredOwner && hoveredOwner !== hitData?.owner) hoveredOwner.scale.setScalar(1);
  hoveredOwner = hitData?.owner || null;
  if (hoveredOwner) hoveredOwner.scale.setScalar(1.16);
  canvas.style.cursor = hit ? "pointer" : dragging ? "grabbing" : "grab";
  const tooltip = $("object-tooltip");
  if (hit) {
    const data = hitData;
    const label = data.type === "satellite" ? `${data.id} · нажмите для деталей` : data.type === "plane" ? `Плоскость P${Number(data.id) + 1}` : (clients[data.id]?.title || gateways[data.id]?.title);
    tooltip.textContent = label;
    tooltip.style.left = `${event.clientX - canvas.getBoundingClientRect().left}px`;
    tooltip.style.top = `${event.clientY - canvas.getBoundingClientRect().top}px`;
    tooltip.hidden = false;
  } else tooltip.hidden = true;
  if (!hoverOnly && hit) {
    const data = hitData;
    state.selection = { type: data.type, id: data.id };
    if (data.type === "client") state.client = data.id;
    refreshSatelliteStyles(); renderInspector(); updateNetworkGeometry();
  }
}

canvas.addEventListener("pointerdown", (event) => {
  pointerStart = { x: event.clientX, y: event.clientY };
  previousPointer = { ...pointerStart };
  dragging = true;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (dragging) {
    const dx = event.clientX - previousPointer.x;
    const dy = event.clientY - previousPointer.y;
    worldRoot.rotation.y += dx * 0.006;
    worldRoot.rotation.x = THREE.MathUtils.clamp(worldRoot.rotation.x + dy * 0.004, -1.05, 1.05);
    previousPointer = { x: event.clientX, y: event.clientY };
    $("object-tooltip").hidden = true;
  } else pick(event, true);
});
canvas.addEventListener("pointerup", (event) => {
  const movement = pointerStart ? Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) : 99;
  dragging = false;
  if (movement < 6) pick(event, false);
});
canvas.addEventListener("pointerleave", () => { $("object-tooltip").hidden = true; canvas.style.cursor = "grab"; });
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  camera.position.z = THREE.MathUtils.clamp(camera.position.z + event.deltaY * 0.0022, 3.15, 7.1);
}, { passive: false });

document.querySelectorAll("[data-stage]").forEach((button) => button.addEventListener("click", () => {
  state.stage = Number(button.dataset.stage);
  state.selection = { type: "plane", id: state.stage - 1 };
  renderProject();
}));
$("play-button").addEventListener("click", () => {
  state.playing = !state.playing;
  $("play-button").textContent = state.playing ? "Ⅱ" : "▶";
});
$("speed-select").addEventListener("change", (event) => { state.speed = Number(event.target.value); });
$("time-range").addEventListener("input", (event) => { state.time = Number(event.target.value); updateSatellitePositions(); updateNetworkGeometry(); updateTimeUI(); });
$("home-camera").addEventListener("click", () => { camera.position.set(0.2, 0.35, 5.15); worldRoot.rotation.set(-0.12, -0.28, 0); });
$("toggle-earth").addEventListener("click", (event) => { state.earthRotation = !state.earthRotation; event.currentTarget.classList.toggle("active", state.earthRotation); });
$("toggle-links").addEventListener("click", (event) => { state.links = !state.links; event.currentTarget.classList.toggle("active", state.links); updateNetworkGeometry(); });
$("toggle-orbits").addEventListener("click", (event) => { state.orbits = !state.orbits; event.currentTarget.classList.toggle("active", state.orbits); orbitLines.forEach((line) => { line.visible = state.orbits; }); });
$("project-button").addEventListener("click", () => setDrawer(true));
$("compare-button").addEventListener("click", () => setCompare(true));
$("close-compare").addEventListener("click", () => setCompare(false));
$("compare-modal").addEventListener("click", (event) => { if (event.target === $("compare-modal")) setCompare(false); });
$("drawer-backdrop").addEventListener("click", () => setDrawer(false));
document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", () => setDrawer(false)));
$("scenario-select").addEventListener("change", (event) => {
  state.scenario = event.target.value;
  state.stage = scenarios[state.scenario].stage;
  state.range = scenarios[state.scenario].range;
  state.customFailures.clear();
  state.recoveredFailures.clear();
  renderProject();
});
$("apply-config").addEventListener("click", () => {
  state.range = THREE.MathUtils.clamp(Number($("isl-input").value) || 3000, 100, 10000);
  setDrawer(false); renderProject(); showToast("Параметры проверены, расчёт обновлён");
});
$("add-failure").addEventListener("click", () => {
  const firstAvailable = satelliteData.find((item) => isDeployed(item) && !isFailed(item.id));
  if (firstAvailable) toggleFailure(firstAvailable.id);
});
$("calculate-button").addEventListener("click", (event) => {
  const button = event.currentTarget;
  button.disabled = true; button.innerHTML = "◌ <span>Считаем…</span>";
  setTimeout(() => { button.disabled = false; button.innerHTML = "▶ <span>Пересчитать</span>"; renderProject(); showToast("Расчёт завершён без ошибок"); }, 650);
});
$("export-button").addEventListener("click", () => {
  const payload = { schema_version: "cosmo-A-1.0", scenario: state.scenario, stage: state.stage, isl_range_km: state.range, client: state.client, time_seconds: Math.round(state.time), failures: [...new Set([...scenarios[state.scenario].failures.filter((id) => !state.recoveredFailures.has(id)), ...state.customFailures])] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "polaris-scenario.json"; link.click(); URL.revokeObjectURL(url);
  showToast("Сценарий экспортирован в JSON");
});
$("scenario-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.schema_version !== "cosmo-A-1.0") throw new Error("ожидается schema_version cosmo-A-1.0");
    if (Number.isFinite(data.stage)) state.stage = THREE.MathUtils.clamp(Math.round(data.stage), 1, 3);
    if (Number.isFinite(data.isl_range_km)) state.range = THREE.MathUtils.clamp(data.isl_range_km, 100, 10000);
    state.customFailures = new Set(Array.isArray(data.failures) ? data.failures.filter((id) => satelliteById.has(id)) : []);
    state.recoveredFailures.clear();
    renderProject(); showToast(`Сценарий «${file.name}» загружен`);
  } catch (error) { showToast(`Ошибка файла: ${error.message}`); }
  event.target.value = "";
});

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * renderer.getPixelRatio()) || canvas.height !== Math.round(height * renderer.getPixelRatio())) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }
}

let previousFrame = performance.now();
let networkAccumulator = 0;
let uiAccumulator = 0;
function animate(now) {
  const delta = Math.min((now - previousFrame) / 1000, 0.05);
  previousFrame = now;
  if (state.playing) state.time = (state.time + delta * state.speed) % 86400;
  if (state.earthRotation) earthSystem.rotation.y += delta * 0.035;
  orbitSystem.rotation.y += delta * 0.018;
  updateSatellitePositions();
  networkAccumulator += delta;
  uiAccumulator += delta;
  if (networkAccumulator >= 1 / 18) { updateNetworkGeometry(); networkAccumulator = 0; }
  if (uiAccumulator >= 0.1) { updateTimeUI(); uiAccumulator = 0; }
  resize();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

renderProject();
updateSatellitePositions();
updateNetworkGeometry();
requestAnimationFrame(animate);
