const $ = (id) => document.getElementById(id);

const fields = {
  clock: $("clock"),
  zenohDot: $("zenoh-dot"),
  zenohStatus: $("zenoh-status"),
  registryPill: $("registry-pill"),
  behavior: $("behavior"),
  environment: $("environment"),
  intent: $("intent"),
  entity: $("entity"),
  owner: $("owner"),
  video: $("video"),
  videoPill: $("video-pill"),
  videoEmpty: $("video-empty"),
  videoUrl: $("video-url"),
  cameraLabels: $("camera-labels"),
};

let renderedCameraLabels = "";

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

function render(state) {
  const zenohOnline = state.connection?.zenoh === "online" || state.connection?.zenoh === "disabled";
  fields.zenohDot.classList.toggle("online", zenohOnline);
  fields.zenohStatus.textContent = `Zenoh ${statusText(state.connection?.zenoh)}`;

  const registered = Boolean(state.registry?.registered);
  setPill(fields.registryPill, registered ? "已注册" : "未注册", registered ? "good" : "bad");

  fields.behavior.textContent = text(state.recognition?.behavior?.label, "等待数据");
  fields.environment.textContent = text(state.recognition?.environment?.label, "等待数据");
  fields.intent.textContent = text(state.recognition?.intent?.label, "等待判断");

  const entityName = text(state.registry?.display_name, state.registry?.entity_id ? state.registry.entity_id : "-");
  fields.entity.textContent = entityName;
  fields.owner.textContent = text(state.registry?.metadata?.owner);

  const videoStatus = state.video?.status ?? "waiting";
  const videoOnline = videoStatus === "online";
  setPill(fields.videoPill, statusText(videoStatus), videoOnline ? "good" : videoStatus === "offline" ? "bad" : "");
  fields.videoEmpty.classList.toggle("hidden", videoOnline);
  fields.videoUrl.textContent = text(state.video?.rtsp_url, "可通过注册信息或 --rtsp-url 提供");
  renderCameraLabels(videoOnline ? state.video?.camera_labels : []);
  requestAnimationFrame(positionCameraLabels);
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

tickClock();
setInterval(tickClock, 1000);
new ResizeObserver(positionCameraLabels).observe(fields.video.parentElement);
fields.video.addEventListener("load", positionCameraLabels);
loadInitialState().catch(console.error);
connectEvents();
