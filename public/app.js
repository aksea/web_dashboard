const $ = (id) => document.getElementById(id);

const fields = {
  cursorSurface: $("cursor-surface"),
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

const state = {
  lastSeen: 0,
  lastHandToken: "",
  lastRingSeq: 0,
  lastGesture: "",
  cursor: {
    initialized: false,
    lastIndex: null,
    x: 0.5,
    y: 0.5,
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
loadInitialState().catch(console.error);
connectEvents();
animate();
