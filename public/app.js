const $ = (id) => document.getElementById(id);

const fields = {
  cursorSurface: $("cursor-surface"),
  sceneMap: $("scene-map"),
  cursorTarget: $("cursor-target"),
  tapMarker: $("tap-marker"),
  armStatus: $("arm-status"),
  armWord: $("arm-word"),
  heightStage: document.querySelector(".height-stage"),
  heightColumn: $("height-column"),
  video: $("video"),
  videoEmpty: $("video-empty"),
  videoUrl: $("video-url"),
};

const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  lastSeen: 0,
  lastHandToken: "",
  lastRingSeq: 0,
  lastGesture: "",
  activeZoneId: "",
  cursor: {
    initialized: false,
    lastIndex: null,
    x: 0.5,
    y: 0.5,
  },
  sceneMap: {
    width: 0,
    height: 0,
    zones: [],
    zoneLabels: new Map(),
  },
  height: {
    value: 0.15,
    direction: 0,
    lastTick: performance.now(),
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setArmState(direction) {
  state.height.direction = direction;
  const label = direction > 0 ? "上" : direction < 0 ? "下" : "停";
  fields.armWord.textContent = label;
  fields.armStatus.classList.toggle("up", direction > 0);
  fields.armStatus.classList.toggle("down", direction < 0);
}

function svgElement(name, attrs = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function pointString(points) {
  return points.map((point) => `${Number(point.x)},${Number(point.y)}`).join(" ");
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < ((xj - xi) * (point.y - yi)) / Math.max(yj - yi, 1e-6) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInCircle(point, circle) {
  const dx = point.x - circle.center.x;
  const dy = point.y - circle.center.y;
  return dx * dx + dy * dy <= circle.radius * circle.radius;
}

function setActiveZone(zoneId) {
  if (state.activeZoneId === zoneId) return;
  if (state.activeZoneId) {
    const previous = fields.sceneMap.querySelector(`[data-zone-id="${state.activeZoneId}"]`);
    previous?.classList.remove("map-zone-active");
    state.sceneMap.zoneLabels.get(state.activeZoneId)?.classList.remove("map-zone-label-active");
  }
  state.activeZoneId = zoneId;
  if (zoneId) {
    const current = fields.sceneMap.querySelector(`[data-zone-id="${zoneId}"]`);
    current?.classList.add("map-zone-active");
    state.sceneMap.zoneLabels.get(zoneId)?.classList.add("map-zone-label-active");
  }
}

function zoneIdAtCursor() {
  const { width, height, zones } = state.sceneMap;
  if (!(width > 0) || !(height > 0) || !zones.length) return "";
  const point = {
    x: state.cursor.x * width,
    y: state.cursor.y * height,
  };
  const hit = zones.find((zone) => (
    zone.shape === "polygon"
      ? pointInPolygon(point, zone.points)
      : pointInCircle(point, zone)
  ));
  return hit?.id || "";
}

function markActiveZoneFromCursor() {
  const zoneId = zoneIdAtCursor();
  setActiveZone(zoneId);
  return zoneId;
}

async function reportSelectedZone(zoneId) {
  if (!zoneId) return;
  try {
    const response = await fetch("/api/select-zone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        selected: zoneId,
        zone_id: zoneId,
      }),
    });
    if (!response.ok) {
      console.error("zone selection publish failed", response.status);
    }
  } catch (error) {
    console.error("zone selection publish error", error);
  }
}

function computeBounds(scene, floor) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const zone of scene.zones || []) {
    if (floor && !zoneOnActiveFloor(zone, floor)) continue;
    if (Array.isArray(zone.boundary_2d) && zone.boundary_2d.length) {
      for (const point of zone.boundary_2d) {
        minX = Math.min(minX, Number(point.x));
        minY = Math.min(minY, Number(point.y));
        maxX = Math.max(maxX, Number(point.x));
        maxY = Math.max(maxY, Number(point.y));
      }
    } else if (zone.center && zone.radius) {
      minX = Math.min(minX, Number(zone.center.x) - Number(zone.radius));
      minY = Math.min(minY, Number(zone.center.y) - Number(zone.radius));
      maxX = Math.max(maxX, Number(zone.center.x) + Number(zone.radius));
      maxY = Math.max(maxY, Number(zone.center.y) + Number(zone.radius));
    } else if (zone.center) {
      minX = Math.min(minX, Number(zone.center.x));
      minY = Math.min(minY, Number(zone.center.y));
      maxX = Math.max(maxX, Number(zone.center.x));
      maxY = Math.max(maxY, Number(zone.center.y));
    }
  }
  for (const item of scene.containers || []) {
    if (floor && !containerOnActiveFloor(item, floor)) continue;
    if (!item.position) continue;
    minX = Math.min(minX, Number(item.position.x));
    minY = Math.min(minY, Number(item.position.y));
    maxX = Math.max(maxX, Number(item.position.x));
    maxY = Math.max(maxY, Number(item.position.y));
  }
  for (const target of scene.targets || []) {
    if (!target.position || floor && !zInFloor(target.position.z, floor)) continue;
    minX = Math.min(minX, Number(target.position.x));
    minY = Math.min(minY, Number(target.position.y));
    maxX = Math.max(maxX, Number(target.position.x));
    maxY = Math.max(maxY, Number(target.position.y));
  }

  if (Number.isFinite(minX) && maxX > minX && maxY > minY) {
    const padX = Math.max((maxX - minX) * 0.08, 600);
    const padY = Math.max((maxY - minY) * 0.2, 500);
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
  }

  const floorBounds = floor?.minimap_bounds;
  if (floorBounds?.min && floorBounds?.max) {
    return {
      minX: Math.min(Number(floorBounds.min.x), Number(floorBounds.max.x)),
      minY: Math.min(Number(floorBounds.min.y), Number(floorBounds.max.y)),
      maxX: Math.max(Number(floorBounds.min.x), Number(floorBounds.max.x)),
      maxY: Math.max(Number(floorBounds.min.y), Number(floorBounds.max.y)),
    };
  }

  const worldBounds = scene.world_frame?.bounds;
  if (worldBounds?.min && worldBounds?.max) {
    return {
      minX: Math.min(Number(worldBounds.min.x), Number(worldBounds.max.x)),
      minY: Math.min(Number(worldBounds.min.y), Number(worldBounds.max.y)),
      maxX: Math.max(Number(worldBounds.min.x), Number(worldBounds.max.x)),
      maxY: Math.max(Number(worldBounds.min.y), Number(worldBounds.max.y)),
    };
  }

  return null;
}

function floorContentScore(scene, floor) {
  let score = 0;
  for (const zone of scene.zones || []) {
    if (zoneOnActiveFloor(zone, floor)) score += 3;
  }
  for (const edge of scene.topology || []) {
    if (!floor) {
      score += 1;
    } else if (edge.floor === floor.name || edge.floor === floor.label) {
      score += 1;
    }
  }
  for (const item of scene.containers || []) {
    if (containerOnActiveFloor(item, floor)) score += 2;
  }
  for (const target of scene.targets || []) {
    if (zInFloor(target.position?.z, floor)) score += 2;
  }
  return score;
}

function zInFloor(z, floor) {
  if (!floor || z === undefined || z === null) return true;
  return Number(z) >= Number(floor.z_range.min) - 50 && Number(z) <= Number(floor.z_range.max) + 50;
}

function zoneOnActiveFloor(zone, floor) {
  if (!floor) return true;
  if (zone.floor_name) {
    return zone.floor_name === floor.name || zone.floor_name === floor.label;
  }
  if (zone.floor !== undefined && zone.floor !== null) {
    return Number(zone.floor) === Number(floor.id);
  }
  if (zone.z_range) {
    return Number(zone.z_range.max) >= Number(floor.z_range.min) - 50 &&
      Number(zone.z_range.min) <= Number(floor.z_range.max) + 50;
  }
  if (zone.center?.z !== undefined) {
    return zInFloor(zone.center.z, floor);
  }
  return false;
}

function containerOnActiveFloor(item, floor) {
  if (!floor) return true;
  if (item.floor_name) {
    return item.floor_name === floor.name || item.floor_name === floor.label;
  }
  if (item.floor !== undefined && item.floor !== null) {
    return Number(item.floor) === Number(floor.id);
  }
  return zInFloor(item.position?.z, floor);
}

function toMapPoint(worldX, worldY, bounds) {
  return {
    x: bounds.maxX - Number(worldX),
    y: bounds.maxY - Number(worldY),
  };
}

function toMapPoints(points, bounds) {
  return points.map((point) => toMapPoint(point.x, point.y, bounds));
}

function zoneLabelPoint(zone) {
  if (zone.center) return { x: Number(zone.center.x), y: Number(zone.center.y) };
  const points = zone.boundary_2d || [];
  if (!points.length) return null;
  return {
    x: points.reduce((sum, point) => sum + Number(point.x), 0) / points.length,
    y: points.reduce((sum, point) => sum + Number(point.y), 0) / points.length,
  };
}

function addMapGrid(svg, bounds) {
  const step = 5000;
  const startX = Math.ceil(bounds.minX / step) * step;
  const startY = Math.ceil(bounds.minY / step) * step;
  for (let x = startX; x <= bounds.maxX; x += step) {
    const p1 = toMapPoint(x, bounds.minY, bounds);
    const p2 = toMapPoint(x, bounds.maxY, bounds);
    svg.appendChild(svgElement("line", {
      class: "map-grid",
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
    }));
  }
  for (let y = startY; y <= bounds.maxY; y += step) {
    const p1 = toMapPoint(bounds.minX, y, bounds);
    const p2 = toMapPoint(bounds.maxX, y, bounds);
    svg.appendChild(svgElement("line", {
      class: "map-grid",
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
    }));
  }
}

function renderZones(svg, scene, floor, bounds) {
  state.sceneMap.zones = [];
  state.sceneMap.zoneLabels = new Map();
  for (const zone of scene.zones || []) {
    if (!zoneOnActiveFloor(zone, floor)) continue;
    const zoneId = zone.id || zone.display_name || zone.label;
    if (!zoneId) continue;
    if (Array.isArray(zone.boundary_2d) && zone.boundary_2d.length >= 3) {
      const points = toMapPoints(zone.boundary_2d, bounds);
      svg.appendChild(svgElement("polygon", {
        class: "map-zone",
        points: pointString(points),
        "data-zone-id": zoneId,
      }));
      state.sceneMap.zones.push({ id: zoneId, shape: "polygon", points });
    } else if (zone.center && zone.radius) {
      const center = toMapPoint(zone.center.x, zone.center.y, bounds);
      svg.appendChild(svgElement("circle", {
        class: "map-zone",
        cx: center.x,
        cy: center.y,
        r: Number(zone.radius),
        "data-zone-id": zoneId,
      }));
      state.sceneMap.zones.push({ id: zoneId, shape: "circle", center, radius: Number(zone.radius) });
    }

    const labelPoint = zoneLabelPoint(zone);
    if (!labelPoint) continue;
    const anchor = toMapPoint(labelPoint.x, labelPoint.y, bounds);
    const label = zone.label || zone.display_name || zone.id || "";
    const labelNode = svgElement("text", {
      class: "map-zone-label",
      x: anchor.x,
      y: anchor.y,
    });
    labelNode.textContent = label;
    svg.appendChild(labelNode);
    state.sceneMap.zoneLabels.set(zoneId, labelNode);
  }
}

function renderTopology(svg, scene, floor, bounds) {
  const zoneMap = new Map((scene.zones || []).map((zone) => [zone.id, zone]));
  for (const edge of scene.topology || []) {
    if (floor && edge.floor) {
      const matched = edge.floor === floor.name || edge.floor === floor.label;
      if (!matched) continue;
    }
    const from = zoneMap.get(edge.from || edge.from_zone);
    const to = zoneMap.get(edge.to || edge.to_zone);
    if (!from?.center || !to?.center) continue;
    const p1 = toMapPoint(from.center.x, from.center.y, bounds);
    const p2 = toMapPoint(to.center.x, to.center.y, bounds);
    svg.appendChild(svgElement("line", {
      class: "map-topology",
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
    }));
  }
}

function renderContainers(svg, scene, floor, bounds) {
  for (const item of scene.containers || []) {
    if (!containerOnActiveFloor(item, floor) || !item.position) continue;
    const point = toMapPoint(item.position.x, item.position.y, bounds);
    svg.appendChild(svgElement("rect", {
      class: "map-container",
      x: point.x - 180,
      y: point.y - 180,
      width: 360,
      height: 360,
      rx: 48,
      ry: 48,
    }));
  }
}

function renderTargets(svg, scene, floor, bounds) {
  for (const target of scene.targets || []) {
    if (!target.position || target.visibility && target.visibility !== "god_view") continue;
    if (!zInFloor(target.position.z, floor)) continue;
    const point = toMapPoint(target.position.x, target.position.y, bounds);
    const size = 260;
    svg.appendChild(svgElement("polygon", {
      class: "map-target",
      points: `${point.x},${point.y - size} ${point.x + size},${point.y} ${point.x},${point.y + size} ${point.x - size},${point.y}`,
    }));
  }
}

function renderSceneMap(scene) {
  const floor = (scene.floors || [])
    .slice()
    .sort((a, b) => floorContentScore(scene, b) - floorContentScore(scene, a))[0] ??
    null;
  const bounds = computeBounds(scene, floor);
  if (!bounds) return;

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  fields.sceneMap.setAttribute("viewBox", `0 0 ${width} ${height}`);
  fields.sceneMap.setAttribute("preserveAspectRatio", "none");
  fields.sceneMap.replaceChildren();
  state.sceneMap.width = width;
  state.sceneMap.height = height;
  fields.sceneMap.appendChild(svgElement("rect", {
    class: "map-background",
    x: 0,
    y: 0,
    width,
    height,
  }));

  addMapGrid(fields.sceneMap, bounds);
  renderZones(fields.sceneMap, scene, floor, bounds);
  renderTopology(fields.sceneMap, scene, floor, bounds);
  renderContainers(fields.sceneMap, scene, floor, bounds);
  renderTargets(fields.sceneMap, scene, floor, bounds);

  fields.sceneMap.appendChild(svgElement("text", {
    class: "map-title",
    x: width / 2,
    y: 1400,
  }));
  fields.sceneMap.lastChild.textContent = `${scene.scene_name || "地图"} · ${floor?.name || ""}`;
}

async function loadSceneMap() {
  const response = await fetch("/assets/scene_map.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`scene map load failed: ${response.status}`);
  renderSceneMap(await response.json());
}

function updateCursor(points, width, height, gesture) {
  const indexTip = points[8];
  const active = gesture === "pointing";
  if (!active) {
    state.cursor.lastIndex = null;
    return;
  }

  const gain = 5.0;
  const current = {
    x: clamp(Number(indexTip[0]) / width, 0, 1),
    y: clamp(Number(indexTip[1]) / height, 0, 1),
  };
  if (!state.cursor.initialized) {
    state.cursor.x = 0.5;
    state.cursor.y = 0.5;
    state.cursor.initialized = true;
  }
  if (state.cursor.lastIndex) {
    state.cursor.x = clamp(state.cursor.x + (current.x - state.cursor.lastIndex.x) * gain, 0, 1);
    state.cursor.y = clamp(state.cursor.y + (current.y - state.cursor.lastIndex.y) * gain, 0, 1);
  }
  state.cursor.lastIndex = current;

  const bounds = fields.cursorSurface.getBoundingClientRect();
  fields.cursorTarget.style.left = `${state.cursor.x * bounds.width}px`;
  fields.cursorTarget.style.top = `${state.cursor.y * bounds.height}px`;
}

function placeTapMarker() {
  const bounds = fields.cursorSurface.getBoundingClientRect();
  fields.tapMarker.style.left = `${state.cursor.x * bounds.width}px`;
  fields.tapMarker.style.top = `${state.cursor.y * bounds.height}px`;
  fields.tapMarker.classList.remove("visible");
  void fields.tapMarker.offsetWidth;
  fields.tapMarker.classList.add("visible");
}

function updateArm(gesture) {
  if (gesture === "pinch-in") setArmState(-1);
  else if (gesture === "pinch-out") setArmState(1);
  else setArmState(0);
}

function renderHand(hand) {
  const points = hand?.landmarks || [];
  if (points.length < 21) return;

  const width = Math.max(Number(hand.source_width || 640), 1);
  const height = Math.max(Number(hand.source_height || 360), 1);
  const gesture = hand.gesture || "";

  updateCursor(points, width, height, gesture);
  updateArm(gesture);
  if (gesture === "ok" && state.lastGesture !== "ok") {
    const zoneId = markActiveZoneFromCursor();
    if (zoneId) {
      reportSelectedZone(zoneId);
    }
    placeTapMarker();
  }
  state.lastGesture = gesture;
  state.lastSeen = Date.now();
}

function handToken(hand) {
  if (hand?.pts_ns !== undefined && hand?.pts_ns !== null) return `pts:${hand.pts_ns}`;
  const indexTip = hand?.landmarks?.[8] || [];
  return [
    hand?.updated_at || "",
    hand?.gesture || "",
    Number(indexTip[0]).toFixed(3),
    Number(indexTip[1]).toFixed(3),
  ].join("|");
}

function renderHeight(deltaMs) {
  const speedPerSecond = 0.24;
  if (state.height.direction !== 0) {
    state.height.value = clamp(
      state.height.value + state.height.direction * speedPerSecond * (deltaMs / 1000),
      0,
      1,
    );
  }
  const stageHeight = Math.max(fields.heightStage.getBoundingClientRect().height, 80);
  const columnHeight = 36 + state.height.value * Math.max(stageHeight - 96, 1);
  fields.heightColumn.style.height = `${columnHeight}px`;
}

function renderVideo(videoState) {
  const status = videoState?.status ?? "waiting";
  fields.videoEmpty.classList.toggle("hidden", status === "online");
  fields.videoUrl.textContent = videoState?.rtsp_url || "等待 RTSP 地址";
}

function primaryHandFrom(rawMediapipe) {
  const hands = Array.isArray(rawMediapipe?.hands) ? rawMediapipe.hands : [];
  return hands.find((hand) => Number(hand.id ?? hand.hand_id) === 0) ?? hands[0] ?? null;
}

function render(snapshot) {
  const hand = snapshot.hand ?? primaryHandFrom(snapshot.raw?.mediapipe);
  if (hand) {
    const token = handToken(hand);
    if (token !== state.lastHandToken) {
      state.lastHandToken = token;
      renderHand(hand);
    }
  }

  const ring = snapshot.ring;
  if (ring?.result === "tap" && ring.seq !== state.lastRingSeq) {
    state.lastRingSeq = ring.seq;
    placeTapMarker();
  }

  renderVideo(snapshot.video);
}

function animate() {
  const now = performance.now();
  const deltaMs = Math.min(now - state.height.lastTick, 100);
  state.height.lastTick = now;

  if (state.lastSeen && Date.now() - state.lastSeen >= 1500) {
    setArmState(0);
  }
  renderHeight(deltaMs);
  requestAnimationFrame(animate);
}

async function loadInitialState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  render(await response.json());
}

function connectEvents() {
  const events = new EventSource("/events");
  events.onmessage = (event) => render(JSON.parse(event.data));
}

fields.video.addEventListener("error", () => {
  fields.videoEmpty.classList.remove("hidden");
});

setArmState(0);
loadSceneMap().catch(console.error);
loadInitialState().catch(console.error);
connectEvents();
animate();
