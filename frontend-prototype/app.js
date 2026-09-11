const canvas = document.getElementById("space-canvas");

const scenarios = {
  full: { title: "Полная группировка", stage: 3, range: 3000, failures: 0, metrics: {
    C65: { availability: 96.67, visibility: 97.78, outage: "8 мин", hops: "2,29", backups: 2 },
    C70: { availability: 98.75, visibility: 99.86, outage: "2 мин", hops: "2,66", backups: 2 },
    C72: { availability: 98.89, visibility: 100, outage: "2 мин", hops: "3,15", backups: 1 }
  }},
  first: { title: "Первая очередь запуска", stage: 1, range: 3000, failures: 0, metrics: {
    C65: { availability: 27.22, visibility: 38.19, outage: "572 мин", hops: "2,07", backups: 0 },
    C70: { availability: 15.83, visibility: 48.75, outage: "658 мин", hops: "2,14", backups: 0 },
    C72: { availability: 12.64, visibility: 58.47, outage: "796 мин", hops: "3,12", backups: 0 }
  }},
  outages: { title: "Недоступность десяти аппаратов", stage: 3, range: 3000, failures: 10, metrics: {
    C65: { availability: 79.31, visibility: 84.58, outage: "24 мин", hops: "2,35", backups: 0 },
    C70: { availability: 80.97, visibility: 90.28, outage: "24 мин", hops: "2,75", backups: 1 },
    C72: { availability: 82.64, visibility: 93.06, outage: "20 мин", hops: "3,26", backups: 0 }
  }},
  range: { title: "Дальность ISL 2000 км", stage: 3, range: 2000, failures: 0, metrics: {
    C65: { availability: 83.61, visibility: 97.78, outage: "72 мин", hops: "2,29", backups: 0 },
    C70: { availability: 73.19, visibility: 99.86, outage: "72 мин", hops: "2,73", backups: 0 },
    C72: { availability: 75.28, visibility: 100, outage: "4 мин", hops: "3,49", backups: 0 }
  }}
};

const clients = {
  C65: { title: "Northern terminal 65", coords: "65.0° N · 60.0° E", route: ["C65", "S07", "S23", "G_MUR"] },
  C70: { title: "Northern terminal 70", coords: "70.0° N · 90.0° E", route: ["C70", "S23", "S08", "G_MUR"] },
  C72: { title: "Northern terminal 72", coords: "72.0° N · 130.0° E", route: ["C72", "S39", "S24", "S09", "G_MUR"] }
};

const state = {
  scenario: "full", client: "C70", stage: 3, range: 3000,
  time: 21600, playing: true, speed: 300,
  earthRotation: true, links: true, orbits: true, focus: 0
};

const satelliteData = [];
for (let plane = 0; plane < 3; plane += 1) {
  for (let slot = 0; slot < 16; slot += 1) {
    const index = plane * 16 + slot;
    satelliteData.push({
      id: `S${String(index + 1).padStart(2, "0")}`,
      plane, slot, batch: plane + 1,
      phase: [0, 7.5, 15][plane] * Math.PI / 180,
      raan: [0, 60, 120][plane] * Math.PI / 180
    });
  }
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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

scene.add(new THREE.HemisphereLight(0x8dbdff, 0x02040a, 0.52));
const sunlight = new THREE.DirectionalLight(0xffffff, 3.15);
sunlight.position.set(-4.5, 2.8, 4.8);
scene.add(sunlight);
const blueRim = new THREE.PointLight(0x3c7dff, 13, 12, 2);
blueRim.position.set(3.7, -1.4, -3.5);
scene.add(blueRim);

const textureLoader = new THREE.TextureLoader();
const earthMap = textureLoader.load("./assets/earth-day.jpg");
earthMap.colorSpace = THREE.SRGBColorSpace;
earthMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
const earthNormal = textureLoader.load("./assets/earth-normal.jpg");
const earthSpecular = textureLoader.load("./assets/earth-specular.jpg");

const earthSystem = new THREE.Group();
earthSystem.rotation.z = -23.4 * Math.PI / 180;
worldRoot.add(earthSystem);

const earth = new THREE.Mesh(
  new THREE.SphereGeometry(1, 96, 96),
  new THREE.MeshPhongMaterial({
    map: earthMap, normalMap: earthNormal, normalScale: new THREE.Vector2(0.72, 0.72),
    specularMap: earthSpecular, specular: new THREE.Color(0x426b87), shininess: 18
  })
);
earthSystem.add(earth);

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.075, 64, 64),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    uniforms: { glowColor: { value: new THREE.Color(0x3ea9ff) } },
    vertexShader: `varying vec3 vNormal; varying vec3 vWorldPosition;
      void main(){ vNormal=normalize(normalMatrix*normal); vec4 wp=modelMatrix*vec4(position,1.0); vWorldPosition=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `uniform vec3 glowColor; varying vec3 vNormal; varying vec3 vWorldPosition;
      void main(){ vec3 viewDirection=normalize(cameraPosition-vWorldPosition); float intensity=pow(0.7-dot(vNormal,viewDirection),3.4); gl_FragColor=vec4(glowColor,intensity*0.72); }`
  })
);
earthSystem.add(atmosphere);
earthSystem.add(new THREE.Mesh(
  new THREE.SphereGeometry(1.012, 64, 64),
  new THREE.MeshBasicMaterial({ color: 0x4eb7ff, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending })
));

function createStars(count, minRadius, maxRadius, size, color, opacity) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const direction = new THREE.Vector3().randomDirection();
    const radius = THREE.MathUtils.lerp(minRadius, maxRadius, Math.random());
    positions[i * 3] = direction.x * radius;
    positions[i * 3 + 1] = direction.y * radius;
    positions[i * 3 + 2] = direction.z * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ size, color, transparent: true, opacity, sizeAttenuation: true })));
}
createStars(950, 10, 28, 0.023, 0x9ab8da, 0.68);
createStars(120, 8, 20, 0.042, 0xffffff, 0.78);

const orbitSystem = new THREE.Group();
worldRoot.add(orbitSystem);
const orbitLines = [];

function orbitPoint(data, angle, radius = 1.58) {
  const inclination = 87 * Math.PI / 180;
  const u = angle + data.phase;
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosO = Math.cos(data.raan);
  const sinO = Math.sin(data.raan);
  return new THREE.Vector3(
    radius * (cosO * cosU - sinO * sinU * Math.cos(inclination)),
    radius * sinU * Math.sin(inclination),
    radius * (sinO * cosU + cosO * sinU * Math.cos(inclination))
  );
}

for (let plane = 0; plane < 3; plane += 1) {
  const source = satelliteData[plane * 16];
  const points = [];
  for (let i = 0; i <= 256; i += 1) points.push(orbitPoint(source, i / 256 * Math.PI * 2));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: plane === 0 ? 0x4fe2c1 : 0x5e83ba, transparent: true, opacity: plane === 0 ? 0.33 : 0.22 })
  );
  line.userData.plane = plane;
  orbitLines.push(line);
  orbitSystem.add(line);
}

const satelliteRoot = new THREE.Group();
orbitSystem.add(satelliteRoot);
const bodyGeometry = new THREE.BoxGeometry(0.045, 0.035, 0.06);
const panelGeometry = new THREE.BoxGeometry(0.105, 0.008, 0.034);
const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xc9d8e8, metalness: 0.78, roughness: 0.28 });
const panelMaterial = new THREE.MeshStandardMaterial({ color: 0x315a9a, emissive: 0x071a39, metalness: 0.52, roughness: 0.32 });
const routeMaterial = new THREE.MeshStandardMaterial({ color: 0x54efc7, emissive: 0x1a8069, emissiveIntensity: 1.3, metalness: 0.45, roughness: 0.22 });
const failureMaterial = new THREE.MeshStandardMaterial({ color: 0xff5d7d, emissive: 0x9f1734, emissiveIntensity: 1.4 });

const satelliteMeshes = satelliteData.map(data => {
  const group = new THREE.Group();
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  const leftPanel = new THREE.Mesh(panelGeometry, panelMaterial);
  const rightPanel = new THREE.Mesh(panelGeometry, panelMaterial);
  leftPanel.position.x = -0.075;
  rightPanel.position.x = 0.075;
  group.add(body, leftPanel, rightPanel);
  group.userData = { data, body, panels: [leftPanel, rightPanel] };
  satelliteRoot.add(group);
  return group;
});

const linkGeometry = new THREE.BufferGeometry();
const linkLines = new THREE.LineSegments(linkGeometry, new THREE.LineBasicMaterial({ color: 0x5184b8, transparent: true, opacity: 0.13, depthWrite: false }));
orbitSystem.add(linkLines);
const routeGeometry = new THREE.BufferGeometry();
const routeLine = new THREE.Line(routeGeometry, new THREE.LineBasicMaterial({ color: 0x54efc7, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending }));
routeLine.renderOrder = 3;
orbitSystem.add(routeLine);

function makeLabel(text, accent) {
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = 256;
  labelCanvas.height = 72;
  const labelCtx = labelCanvas.getContext("2d");
  labelCtx.fillStyle = "rgba(4,10,20,.82)";
  labelCtx.fillRect(5, 5, 246, 62);
  labelCtx.strokeStyle = accent; labelCtx.lineWidth = 2; labelCtx.strokeRect(5, 5, 246, 62);
  labelCtx.fillStyle = "#eef7ff"; labelCtx.font = "600 26px Segoe UI";
  labelCtx.textAlign = "center"; labelCtx.textBaseline = "middle"; labelCtx.fillText(text, 128, 36);
  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(0.39, 0.11, 1);
  sprite.renderOrder = 5;
  return sprite;
}

function latLonVector(lat, lon, radius = 1.018) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(-radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
}

[
  { id: "C65", lat: 65, lon: 60, color: 0xffc45d },
  { id: "C70", lat: 70, lon: 90, color: 0x54efc7 },
  { id: "C72", lat: 72, lon: 130, color: 0xffc45d },
  { id: "G_MUR", lat: 68.97, lon: 33.07, color: 0x8d9dff }
].forEach(site => {
  const position = latLonVector(site.lat, site.lon);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 16), new THREE.MeshBasicMaterial({ color: site.color }));
  marker.position.copy(position);
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.036, 0.047, 24), new THREE.MeshBasicMaterial({ color: site.color, transparent: true, opacity: 0.68, side: THREE.DoubleSide }));
  halo.position.copy(position.clone().multiplyScalar(1.005));
  halo.lookAt(position.clone().multiplyScalar(2));
  const label = makeLabel(site.id, `#${site.color.toString(16).padStart(6, "0")}`);
  label.position.copy(position.clone().multiplyScalar(1.11));
  earthSystem.add(marker, halo, label);
});

function isFailed(data) {
  return state.scenario === "outages" && state.time >= 21600 && [31, 14, 48, 16, 26, 15, 8, 5, 32, 34].includes(Number(data.id.slice(1)));
}

function updateNetwork() {
  const routeIds = new Set(clients[state.client].route.filter(id => id.startsWith("S")));
  const active = [];
  satelliteMeshes.forEach(group => {
    const { data, body, panels } = group.userData;
    const launched = data.batch <= state.stage;
    const failed = isFailed(data);
    const inRoute = routeIds.has(data.id) && launched && !failed;
    const angle = data.slot * Math.PI / 8 + state.time / 5730;
    group.position.copy(orbitPoint(data, angle));
    group.lookAt(0, 0, 0);
    group.rotateY(Math.PI / 2);
    group.visible = launched;
    body.material = failed ? failureMaterial : inRoute ? routeMaterial : bodyMaterial;
    panels.forEach(panel => { panel.material = failed ? failureMaterial : inRoute ? routeMaterial : panelMaterial; });
    if (launched && !failed) active.push({ data, group });
  });

  const segments = [];
  if (state.links) {
    active.forEach(({ data, group }) => {
      const next = active.find(item => item.data.plane === data.plane && item.data.slot === (data.slot + 1) % 16);
      if (next) segments.push(group.position.x, group.position.y, group.position.z, next.group.position.x, next.group.position.y, next.group.position.z);
      if (state.range === 3000 && data.slot % 4 === 0) {
        const cross = active.find(item => item.data.plane === (data.plane + 1) % 3 && item.data.slot === data.slot);
        if (cross) segments.push(group.position.x, group.position.y, group.position.z, cross.group.position.x, cross.group.position.y, cross.group.position.z);
      }
    });
  }
  linkGeometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
  const routePoints = clients[state.client].route.filter(id => id.startsWith("S")).map(id => satelliteMeshes[Number(id.slice(1)) - 1].position.clone());
  routeGeometry.setFromPoints(routePoints);
  routeLine.visible = routePoints.length > 1;
  orbitLines.forEach(line => { line.visible = state.orbits; line.material.opacity = line.userData.plane === state.focus ? 0.48 : 0.2; });
}

function resizeRenderer() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  if (width < 600 && camera.position.z < 6.15) camera.position.z = 6.15;
  camera.updateProjectionMatrix();
}

function formatTime(seconds) {
  const safe = ((Math.round(seconds) % 86400) + 86400) % 86400;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return [hours, minutes, secs].map(value => String(value).padStart(2, "0")).join(":");
}
const formatPercent = value => `${value.toFixed(2).replace(".", ",")}%`;

function drawTimeline() {
  const scenario = scenarios[state.scenario];
  const patterns = {
    full: [[38,3,59],[66,2,32],[82,2,16]], first: [[13,24,8,20,7,28],[7,34,9,20,5,25],[10,42,6,29,4,9]],
    outages: [[28,5,17,6,20,7,17],[31,8,14,7,23,5,12],[35,5,22,6,20,4,8]], range: [[22,8,18,10,25,5,12],[18,11,15,12,21,9,14],[26,7,16,8,22,6,15]]
  };
  document.getElementById("availability-lanes").innerHTML = Object.keys(clients).map((clientId, laneIndex) => {
    let left = 0;
    const parts = patterns[state.scenario][laneIndex].map((size, index) => {
      const kind = index % 2 === 0 ? "available" : index % 4 === 1 ? "degraded" : "outage";
      const html = `<i class="lane-segment ${kind}" style="left:${left}%;width:${size}%"></i>`;
      left += size;
      return html;
    }).join("");
    return `<div class="availability-lane"><span>${clientId}</span><div class="lane-track">${parts}<b class="lane-cursor" style="left:${state.time / 86400 * 100}%"></b></div><strong>${formatPercent(scenario.metrics[clientId].availability)}</strong></div>`;
  }).join("");
}

function renderRoute() {
  const route = clients[state.client].route;
  document.getElementById("route-chain").innerHTML = route.map((node, index) => {
    const kind = index === 0 ? "терминал" : index === route.length - 1 ? "шлюз" : "спутник";
    return `<div class="route-node"><i></i><span>${node}</span><small>${kind}</small></div>`;
  }).join("");
  document.getElementById("route-hops").textContent = `${route.length - 1} перехода`;
}

function updateUI() {
  const scenario = scenarios[state.scenario];
  const metric = scenario.metrics[state.client];
  const client = clients[state.client];
  const active = satelliteData.filter(data => data.batch <= state.stage && !isFailed(data)).length;
  document.getElementById("project-name").textContent = scenario.title;
  document.getElementById("header-count").textContent = `${active} аппаратов`;
  document.getElementById("active-count").textContent = active;
  document.getElementById("links-count").textContent = Math.round(active * (state.range === 3000 ? 1.72 : .54));
  document.getElementById("client-name").textContent = client.title;
  document.getElementById("client-coords").textContent = client.coords;
  document.getElementById("availability-value").textContent = formatPercent(metric.availability);
  document.getElementById("availability-progress").style.width = `${metric.availability}%`;
  const goal = document.querySelector(".goal-state");
  goal.textContent = metric.availability >= 90 ? "✓ Цель достигнута" : `↓ Ниже цели на ${(90 - metric.availability).toFixed(2).replace(".", ",")} п.п.`;
  goal.style.color = metric.availability >= 90 ? "var(--accent)" : "var(--danger)";
  document.getElementById("visibility-value").textContent = formatPercent(metric.visibility);
  document.getElementById("outage-value").textContent = metric.outage;
  document.getElementById("average-hops").textContent = metric.hops;
  document.getElementById("backup-routes").textContent = metric.backups;
  document.getElementById("recommendation-text").textContent = metric.availability >= 90
    ? `Конфигурация достигает целевой доступности для ${state.client}. Критических разрывов сети не обнаружено.`
    : `Доступность ${state.client} ниже целевого уровня. Рекомендуется увеличить этап развёртывания или дальность межспутниковой связи.`;
  document.getElementById("timeline-time").textContent = formatTime(state.time);
  document.getElementById("scene-time").textContent = formatTime(state.time).slice(0, 5);
  document.getElementById("time-range").value = state.time;
  document.getElementById("scenario-select").value = state.scenario;
  document.getElementById("isl-input").value = state.range;
  document.querySelectorAll("[data-stage]").forEach(button => button.classList.toggle("active", Number(button.dataset.stage) === state.stage));
  document.querySelectorAll("[data-client]").forEach(button => button.classList.toggle("active", button.dataset.client === state.client));
  renderRoute(); drawTimeline(); updateNetwork();
}

let toastTimer;
function showToast(text) {
  const toast = document.getElementById("toast");
  toast.textContent = text; toast.classList.add("show"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}
function setDrawer(open) {
  document.getElementById("configuration-drawer").classList.toggle("open", open);
  document.getElementById("configuration-drawer").setAttribute("aria-hidden", String(!open));
  document.getElementById("drawer-backdrop").classList.toggle("open", open);
}

document.querySelectorAll("[data-stage]").forEach(button => button.addEventListener("click", () => { state.stage = Number(button.dataset.stage); updateUI(); }));
document.querySelectorAll("[data-client]").forEach(button => button.addEventListener("click", () => { state.client = button.dataset.client; updateUI(); }));
document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item === button));
  if (["configuration", "failures", "settings"].includes(button.dataset.section)) setDrawer(true);
  else if (button.dataset.section === "variants") document.getElementById("compare-button").click();
  else showToast(button.dataset.section === "analytics" ? "Метрики отображены на временной шкале и справа" : "Обзор группировки");
}));
document.querySelectorAll("[data-close-drawer]").forEach(button => button.addEventListener("click", () => setDrawer(false)));
document.getElementById("drawer-backdrop").addEventListener("click", () => setDrawer(false));
document.getElementById("scenario-select").addEventListener("change", event => {
  state.scenario = event.target.value;
  const scenario = scenarios[state.scenario];
  state.stage = scenario.stage; state.range = scenario.range;
  document.getElementById("failure-list").innerHTML = scenario.failures
    ? `<div class="failure-item"><div><strong>10 аппаратов недоступны</strong><span>06:00 — 24:00</span></div><span>S05…S48</span></div>`
    : `<div class="empty-state">В этом варианте нет заданных отказов</div>`;
  updateUI();
});
document.getElementById("apply-config").addEventListener("click", () => {
  state.range = Number(document.getElementById("isl-input").value) || state.range;
  setDrawer(false); showToast("Конфигурация применена — результаты пересчитаны"); updateUI();
});
document.getElementById("add-failure").addEventListener("click", () => {
  document.getElementById("failure-list").innerHTML = `<div class="failure-item"><div><strong>S23 · новый отказ</strong><span>06:00 — 12:00</span></div><span>6 часов</span></div>`;
  showToast("Добавлен демонстрационный отказ S23");
});
document.getElementById("compare-button").addEventListener("click", () => {
  document.getElementById("compare-modal").classList.add("open"); document.getElementById("compare-modal").setAttribute("aria-hidden", "false");
});
document.getElementById("close-compare").addEventListener("click", () => {
  document.getElementById("compare-modal").classList.remove("open"); document.getElementById("compare-modal").setAttribute("aria-hidden", "true");
});
document.getElementById("compare-modal").addEventListener("click", event => { if (event.target.id === "compare-modal") document.getElementById("close-compare").click(); });
document.getElementById("export-button").addEventListener("click", () => showToast("Прототип: подготовлена выгрузка результата cosmo-A-result-1.0"));
document.getElementById("calculate-button").addEventListener("click", event => {
  event.currentTarget.querySelector("span").textContent = "Расчёт…";
  setTimeout(() => { event.currentTarget.querySelector("span").textContent = "Пересчитать"; showToast("720 временных шагов рассчитаны"); }, 900);
});
document.getElementById("time-range").addEventListener("input", event => { state.time = Number(event.target.value); updateUI(); });
document.getElementById("speed-select").addEventListener("change", event => { state.speed = Number(event.target.value); });
document.getElementById("play-button").addEventListener("click", event => { state.playing = !state.playing; event.currentTarget.textContent = state.playing ? "Ⅱ" : "▶"; });
document.getElementById("toggle-earth").addEventListener("click", event => {
  state.earthRotation = !state.earthRotation; event.currentTarget.classList.toggle("active", state.earthRotation);
  event.currentTarget.title = state.earthRotation ? "Остановить вращение Земли" : "Запустить вращение Земли";
  showToast(state.earthRotation ? "Вращение Земли включено" : "Вращение Земли остановлено");
});
document.getElementById("toggle-links").addEventListener("click", event => { state.links = !state.links; event.currentTarget.classList.toggle("active", state.links); updateNetwork(); });
document.getElementById("toggle-orbits").addEventListener("click", event => { state.orbits = !state.orbits; event.currentTarget.classList.toggle("active", state.orbits); updateNetwork(); });
document.getElementById("home-camera").addEventListener("click", () => {
  worldRoot.rotation.set(-0.12, -0.28, 0); camera.position.set(0.2, 0.35, 5.15); state.focus = 0;
  showToast("Камера возвращена к общему виду");
});
document.getElementById("focus-route").addEventListener("click", () => {
  state.focus = (state.focus + 1) % 3; camera.position.z = 4.1; updateNetwork(); showToast("Камера сфокусирована на маршруте");
});
let draggingScene = false;
let pointerX = 0;
let pointerY = 0;
canvas.addEventListener("pointerdown", event => {
  draggingScene = true; pointerX = event.clientX; pointerY = event.clientY; canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", event => {
  if (!draggingScene) return;
  worldRoot.rotation.y += (event.clientX - pointerX) * 0.008;
  worldRoot.rotation.x = Math.max(-1.15, Math.min(1.15, worldRoot.rotation.x + (event.clientY - pointerY) * 0.006));
  pointerX = event.clientX; pointerY = event.clientY;
});
canvas.addEventListener("pointerup", () => { draggingScene = false; });
canvas.addEventListener("pointercancel", () => { draggingScene = false; });
canvas.addEventListener("wheel", event => {
  event.preventDefault();
  camera.position.z = Math.max(2.65, Math.min(8, camera.position.z + event.deltaY * 0.0035));
}, { passive: false });
window.addEventListener("resize", resizeRenderer);
window.addEventListener("keydown", event => { if (event.key === "Escape") { setDrawer(false); document.getElementById("close-compare").click(); } });

let lastFrame = performance.now();
let lastStep = Math.floor(state.time / 120);
function animate(now) {
  const delta = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (state.playing) state.time = (state.time + delta * state.speed) % 86400;
  if (state.earthRotation) earthSystem.rotation.y += delta * 0.045;
  orbitSystem.rotation.y += delta * 0.008;
  const step = Math.floor(state.time / 120);
  if (step !== lastStep) { lastStep = step; updateUI(); } else updateNetwork();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

resizeRenderer();
updateUI();
requestAnimationFrame(animate);
