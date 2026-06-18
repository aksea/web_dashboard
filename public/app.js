const $ = (id) => document.getElementById(id);

const fields = {
  clock: $("clock"),
  zenohDot: $("zenoh-dot"),
  zenohStatus: $("zenoh-status"),
  behavior: $("behavior"),
  environment: $("environment"),
  intent: $("intent"),
  cursorSurface: $("cursor-surface"),
  sceneMap: $("scene-map"),
  cursorTarget: $("cursor-target"),
  tapMarker: $("tap-marker"),
  video: $("video"),
  videoPill: $("video-pill"),
  videoEmpty: $("video-empty"),
  videoUrl: $("video-url"),
  cameraLabels: $("camera-labels"),
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
    lastActiveAt: 0,
    x: 0.5,
    y: 0.5,
  },
  sceneMap: {
    width: 0,
    height: 0,
    zones: [],
    zoneLabels: new Map(),
  },
};

let renderedCameraLabels = "";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function text(value, fallback = "-") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function statusText(value) {
  const map = {
    online: "在线",
    starting: "启动中",
    waiting: "等待",
    connecting: "连接中",
    disabled: "已禁用",
    no_target: "无目标",
    offline: "离线",
  };
  return map[value] ?? text(value, "未知");
}

function setPill(element, label, variant) {
  element.textContent = label;
  element.className = `pill ${variant ?? ""}`.trim();
}

function renderCameraLabels(labels = []) {
  const nextLabels = labels.slice(0, 4);
  const key = JSON.stringify(nextLabels);
  if (key === renderedCameraLabels) return;
  renderedCameraLabels = key;
  fields.cameraLabels.replaceChildren(
    ...nextLabels.map((label, index) => {
      const item = document.createElement("span");
      item.className = `camera-label label-${index + 1}`;
      item.textContent = text(label, `画面 ${index + 1}`);
      return item;
    }),
  );
}

function positionCameraLabels() {
  const frame = fields.video.parentElement;
  const frameWidth = frame.clientWidth;
  const frameHeight = frame.clientHeight;
  let left = 0;
  let top = 0;
  let width = frameWidth;
  let height = frameHeight;

  if (fields.video.naturalWidth > 0 && fields.video.naturalHeight > 0 && frameWidth > 0 && frameHeight > 0) {
    const imageRatio = fields.video.naturalWidth / fields.video.naturalHeight;
    const frameRatio = frameWidth / frameHeight;
    if (frameRatio > imageRatio) {
      width = frameWidth;
      height = width / imageRatio;
      top = (frameHeight - height) / 2;
    } else {
      height = frameHeight;
      width = height * imageRatio;
      left = (frameWidth - width) / 2;
    }
  }

  fields.cameraLabels.style.left = `${left}px`;
  fields.cameraLabels.style.top = `${top}px`;
  fields.cameraLabels.style.width = `${width}px`;
  fields.cameraLabels.style.height = `${height}px`;
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

function zoneVisualTuning(zoneId) {
  const map = {
    zone_01: { shapeDx: -380, shapeDy: -260, labelDx: 540, labelDy: -20, anchor: "start" },
    zone_02: { shapeDx: -180, shapeDy: 420, labelDx: 460, labelDy: -20, anchor: "start" },
    zone_03: { shapeDx: 420, shapeDy: -220, labelDx: -620, labelDy: 0, anchor: "end" },
    zone_08: { shapeDx: -620, shapeDy: 0, labelDx: 470, labelDy: 20, anchor: "start" },
    zone_09: { labelDx: -440, labelDy: 0, anchor: "end" },
    zone_10: { shapeDx: 160, shapeDy: -320, labelDx: 0, labelDy: -560, anchor: "middle" },
    zone_11: { shapeDx: 160, shapeDy: 320, labelDx: 0, labelDy: 560, anchor: "middle" },
    zone_12: { shapeDx: 520, shapeDy: 0, labelDx: 0, labelDy: 0, anchor: "middle" },
  };
  return map[zoneId] || {};
}

function zoneVisualCenter(zone, zoneId) {
  if (!zone.center) return null;
  const tuning = zoneVisualTuning(zoneId);
  return {
    x: Number(zone.center.x) + (tuning.shapeDx || 0),
    y: Number(zone.center.y) + (tuning.shapeDy || 0),
  };
}

function labelAnchorForZone(zone, zoneId) {
  const point = zone.center ? zoneVisualCenter(zone, zoneId) : zoneLabelPoint(zone);
  if (!point) return null;
  const tuning = zoneVisualTuning(zoneId);
  return {
    x: point.x + (tuning.labelDx || 0),
    y: point.y + (tuning.labelDy || 0),
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
    const tuning = zoneVisualTuning(zoneId);
    if (Array.isArray(zone.boundary_2d) && zone.boundary_2d.length >= 3) {
      const visualBoundary = zone.boundary_2d.map((point) => ({
        x: Number(point.x) + (tuning.shapeDx || 0),
        y: Number(point.y) + (tuning.shapeDy || 0),
      }));
      const points = toMapPoints(visualBoundary, bounds);
      svg.appendChild(svgElement("polygon", {
        class: "map-zone",
        points: pointString(points),
        "data-zone-id": zoneId,
      }));
      state.sceneMap.zones.push({ id: zoneId, shape: "polygon", points });
    } else if (zone.center && zone.radius) {
      const visualCenter = zoneVisualCenter(zone, zoneId);
      const center = toMapPoint(visualCenter.x, visualCenter.y, bounds);
      const radius = Number(zone.radius);
      svg.appendChild(svgElement("circle", {
        class: "map-zone",
        cx: center.x,
        cy: center.y,
        r: radius,
        "data-zone-id": zoneId,
      }));
      state.sceneMap.zones.push({ id: zoneId, shape: "circle", center, radius });
    }

    const labelPoint = labelAnchorForZone(zone, zoneId);
    if (!labelPoint) continue;
    const anchor = toMapPoint(labelPoint.x, labelPoint.y, bounds);
    const label = zone.label || zone.display_name || zone.id || "";
    const anchorName = tuning.anchor || "middle";
    const labelNode = svgElement("text", {
      class: "map-zone-label",
      x: anchor.x,
      y: anchor.y,
      "text-anchor": anchorName,
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

function targetVisualPosition(target) {
  if (target.target_id === "bomb_1") {
    return { x: -5000, y: -1960, z: target.position?.z ?? 575 };
  }
  return target.position;
}

function renderTargets(svg, scene, floor, bounds) {
  for (const target of scene.targets || []) {
    const position = targetVisualPosition(target);
    if (!position || target.visibility && target.visibility !== "god_view") continue;
    if (!zInFloor(position.z, floor)) continue;
    const point = toMapPoint(position.x, position.y, bounds);
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
    return;
  }

  const gain = 5.0;
  const now = performance.now();
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
    const inactiveMs = now - state.cursor.lastActiveAt;
    const dx = current.x - state.cursor.lastIndex.x;
    const dy = current.y - state.cursor.lastIndex.y;
    const jump = Math.hypot(dx, dy);
    const shouldRebase = inactiveMs > 250 || jump > 0.12;
    if (!shouldRebase) {
      const maxStep = 0.045;
      state.cursor.x = clamp(state.cursor.x + clamp(dx * gain, -maxStep, maxStep), 0, 1);
      state.cursor.y = clamp(state.cursor.y + clamp(dy * gain, -maxStep, maxStep), 0, 1);
    }
  }
  state.cursor.lastIndex = current;
  state.cursor.lastActiveAt = now;

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

function renderHand(hand) {
  const points = hand?.landmarks || [];
  if (points.length < 21) return;

  const width = Math.max(Number(hand.source_width || 640), 1);
  const height = Math.max(Number(hand.source_height || 360), 1);
  const gesture = hand.gesture || "";

  updateCursor(points, width, height, gesture);
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

function renderVideo(videoState) {
  const status = videoState?.status ?? "waiting";
  const videoOnline = status === "online";
  setPill(fields.videoPill, statusText(status), videoOnline ? "good" : status === "offline" ? "bad" : "");
  fields.videoEmpty.classList.toggle("hidden", videoOnline);
  fields.videoUrl.textContent = text(videoState?.rtsp_url, "当前无 RTSP 目标地址");
  renderCameraLabels(videoOnline ? videoState?.camera_labels : []);
  requestAnimationFrame(positionCameraLabels);
}

function renderDashboard(snapshot) {
  const zenohOnline = snapshot.connection?.zenoh === "online" || snapshot.connection?.zenoh === "disabled";
  fields.zenohDot.classList.toggle("online", zenohOnline);
  fields.zenohStatus.textContent = `Zenoh ${statusText(snapshot.connection?.zenoh)}`;

  fields.behavior.textContent = text(snapshot.recognition?.behavior?.label, "等待数据");
  fields.environment.textContent = text(snapshot.recognition?.environment?.label, "等待数据");
  fields.intent.textContent = text(snapshot.recognition?.intent?.label, "等待判断");
}

function primaryHandFrom(rawMediapipe) {
  const hands = Array.isArray(rawMediapipe?.hands) ? rawMediapipe.hands : [];
  return hands.find((hand) => Number(hand.id ?? hand.hand_id) === 0) ?? hands[0] ?? null;
}

function render(snapshot) {
  renderDashboard(snapshot);

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

function tickClock() {
  fields.clock.textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}

async function loadInitialState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  render(await response.json());
}

function connectEvents() {
  const events = new EventSource("/events");
  events.onmessage = (event) => render(JSON.parse(event.data));
  events.onerror = () => {
    fields.zenohDot.classList.remove("online");
    fields.zenohStatus.textContent = "服务重连中";
  };
}

fields.video.addEventListener("error", () => {
  fields.videoEmpty.classList.remove("hidden");
});

tickClock();
setInterval(tickClock, 1000);
new ResizeObserver(positionCameraLabels).observe(fields.video.parentElement);
fields.video.addEventListener("load", positionCameraLabels);
loadSceneMap().catch(console.error);
loadInitialState().catch(console.error);
connectEvents();
