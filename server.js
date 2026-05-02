#!/usr/bin/env node

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function parseArgs(argv) {
  let listenOverridden = false;
  let rtspUrlOverridden = false;
  const args = {
    host: "127.0.0.1",
    port: 8787,
    rtspUrl: "",
    rtspUrlOverridden: false,
    registryKey: "zho/entity/registry",
    mediapipeKey: "halmet/mediapipe",
    yoloKey: "halmet/yolo",
    zenohMode: "router",
    connect: [],
    listen: ["tcp/0.0.0.0:7447"],
    noZenoh: false,
    noVideo: false,
    cameraLabels: ["面部视角", "第一视角", "躯干视角", "环境视角"],
    ffmpeg: "ffmpeg",
    python: "python3",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i] ?? "";
    };
    if (arg === "--host") args.host = next();
    else if (arg === "--port") args.port = Number(next());
    else if (arg === "--rtsp-url") {
      args.rtspUrl = next();
      rtspUrlOverridden = true;
    }
    else if (arg === "--registry-key") args.registryKey = next();
    else if (arg === "--mediapipe-key") args.mediapipeKey = next();
    else if (arg === "--yolo-key") args.yoloKey = next();
    else if (arg === "--zenoh-mode") args.zenohMode = next();
    else if (arg === "--connect") args.connect.push(next());
    else if (arg === "--listen") {
      if (!listenOverridden) {
        args.listen = [];
        listenOverridden = true;
      }
      args.listen.push(next());
    }
    else if (arg === "--ffmpeg") args.ffmpeg = next();
    else if (arg === "--python") args.python = next();
    else if (arg === "--camera-labels") args.cameraLabels = next().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--no-zenoh") args.noZenoh = true;
    else if (arg === "--no-video") args.noVideo = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error("--port must be in 1..65535");
  }
  args.rtspUrlOverridden = rtspUrlOverridden;
  return args;
}

function printHelp() {
  console.log(`Usage: npm start -- [options]

Options:
  --host 127.0.0.1                 HTTP bind host
  --port 8787                      HTTP bind port
  --rtsp-url rtsp://host:8554/cam  RTSP source. If omitted, registry metadata is used.
  --zenoh-mode peer|client|router  Zenoh mode, default: router
  --connect tcp/HOST:7447          Zenoh endpoint, repeatable
  --listen tcp/0.0.0.0:7447        Zenoh listen endpoint, default: tcp/0.0.0.0:7447
  --registry-key zho/entity/registry
  --mediapipe-key halmet/mediapipe
  --yolo-key halmet/yolo
  --camera-labels 面部视角,第一视角,躯干视角,环境视角
  --no-zenoh                       Run UI without Zenoh subscription
  --no-video                       Run UI without RTSP transcoding
`);
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function emptyState(args) {
  return {
    connection: {
      zenoh: args.noZenoh ? "disabled" : "starting",
      video: args.noVideo ? "disabled" : "waiting",
      updated_at: nowText(),
    },
    registry: {
      registered: false,
      metadata: {},
    },
    video: {
      rtsp_url: args.rtspUrl || "",
      stream_url: "/video.mjpeg",
      status: args.noVideo ? "disabled" : "waiting",
      camera_labels: args.cameraLabels,
      last_frame_at: "",
      error: "",
    },
    recognition: {
      behavior: { label: "等待数据", confidence: null, source: "mediapipe", updated_at: "" },
      environment: { label: "等待数据", confidence: null, source: "yolo", updated_at: "" },
      intent: { label: "等待判断", confidence: null, source: "rule", updated_at: "" },
      camera_id: "",
      pts_ns: null,
    },
    raw: {
      mediapipe: null,
      yolo: null,
      last_message: null,
    },
  };
}

class DashboardState extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.state = emptyState(args);
  }

  snapshot() {
    return structuredClone(this.state);
  }

  update(mutator) {
    mutator(this.state);
    this.state.connection.updated_at = nowText();
    this.emit("update", this.snapshot());
  }
}

function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }
  return "";
}

function scoreFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function formatObjects(objects) {
  const names = objects
    .map((item) => firstText(item.class_name, item.name, item.label, item.classId))
    .filter(Boolean);
  if (names.length === 0) return "未检测到目标";
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join("、");
}

function translateBehavior(value) {
  const text = firstText(value);
  const map = {
    open_palm: "张开手掌",
    fist: "握拳",
    unknown: "未知动作",
  };
  return map[text] ?? text;
}

function classifyIntent(behavior, environment) {
  const value = behavior.toLowerCase();
  if (value.includes("open_palm") || value.includes("张开手掌")) return "张开手掌，可能在示意停止或请求关注";
  if (value.includes("fist") || value.includes("握拳")) return "握拳动作，可能表示确认或抓握意图";
  if (value.includes("point")) return "指向动作，可能在提示方向或目标";
  if (environment && environment !== "未检测到目标" && environment !== "等待数据") {
    return "结合环境目标，等待进一步意图判断";
  }
  return "暂无明确意图";
}

function applyRegistry(dashboard, key, payload) {
  dashboard.update((state) => {
    const registered = payload.action === "REG_REGISTER";
    const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
    state.registry = {
      registered,
      action: payload.action,
      entity_id: payload.entity_id ?? "",
      display_name: registered ? payload.display_name ?? "" : "",
      metadata: registered ? metadata : {},
      updated_at: nowText(),
    };
    if (registered && metadata.video_stream_url && !dashboard.args.rtspUrlOverridden) {
      state.video.rtsp_url = metadata.video_stream_url;
    } else if (!registered) {
      state.video.rtsp_url = "";
      state.video.status = "waiting";
      state.video.last_frame_at = "";
      state.video.error = "";
      state.connection.video = "waiting";
      state.video.stop_requested_at = Date.now();
    }
    state.raw.last_message = { key, payload, received_at: nowText() };
  });
}

function applyMediapipe(dashboard, key, payload) {
  const hands = Array.isArray(payload.hands) ? payload.hands : [];
  const primaryHand = hands.find((hand) => Number(hand.id ?? hand.hand_id) === 0) ?? hands[0] ?? null;
  const gesture = primaryHand ? firstText(primaryHand.gesture, primaryHand.behavior, primaryHand.action) : "";
  const handConfidence = primaryHand ? scoreFrom(primaryHand.gesture_score ?? primaryHand.score ?? primaryHand.confidence) : null;
  const behavior = translateBehavior(firstText(payload.behavior, payload.action, gesture, primaryHand ? "检测到手部动作" : "未检测到动作"));

  dashboard.update((state) => {
    state.recognition.behavior = {
      label: behavior,
      confidence: scoreFrom(payload.confidence) ?? handConfidence,
      source: "mediapipe",
      updated_at: nowText(),
    };
    if (payload.environment || payload.scene) {
      state.recognition.environment = {
        label: firstText(payload.environment, payload.scene),
        confidence: scoreFrom(payload.environment_confidence ?? payload.confidence),
        source: "mediapipe",
        updated_at: nowText(),
      };
    }
    state.recognition.intent = {
      label: firstText(payload.intent, classifyIntent(behavior, state.recognition.environment.label)),
      confidence: scoreFrom(payload.intent_confidence ?? payload.confidence) ?? handConfidence,
      source: payload.intent ? "zenoh" : "rule",
      updated_at: nowText(),
    };
    state.recognition.camera_id = payload.camera_id ?? state.recognition.camera_id;
    state.recognition.pts_ns = payload.pts_ns ?? state.recognition.pts_ns;
    state.raw.mediapipe = payload;
    state.raw.last_message = { key, payload, received_at: nowText() };
  });
}

function applyYolo(dashboard, key, payload) {
  const objects = Array.isArray(payload.objects)
    ? payload.objects
    : Array.isArray(payload.detections)
      ? payload.detections
      : [];
  const bestScore = objects.reduce((best, item) => {
    const score = scoreFrom(item.score ?? item.confidence);
    return score === null ? best : Math.max(best ?? 0, score);
  }, null);
  const environment = firstText(payload.environment, payload.scene, formatObjects(objects));

  dashboard.update((state) => {
    state.recognition.environment = {
      label: environment,
      confidence: scoreFrom(payload.confidence) ?? bestScore,
      source: "yolo",
      updated_at: nowText(),
    };
    if (payload.intent) {
      state.recognition.intent = {
        label: String(payload.intent),
        confidence: scoreFrom(payload.intent_confidence ?? payload.confidence),
        source: "zenoh",
        updated_at: nowText(),
      };
    } else if (!state.raw.mediapipe) {
      state.recognition.intent = {
        label: classifyIntent(state.recognition.behavior.label, environment),
        confidence: bestScore,
        source: "rule",
        updated_at: nowText(),
      };
    }
    state.recognition.camera_id = payload.camera_id ?? state.recognition.camera_id;
    state.recognition.pts_ns = payload.pts_ns ?? state.recognition.pts_ns;
    state.raw.yolo = payload;
    state.raw.last_message = { key, payload, received_at: nowText() };
  });
}

function applyGenericResult(dashboard, key, payload) {
  dashboard.update((state) => {
    if (payload.behavior || payload.action) {
      state.recognition.behavior = {
        label: firstText(payload.behavior, payload.action),
        confidence: scoreFrom(payload.behavior_confidence ?? payload.confidence),
        source: key,
        updated_at: nowText(),
      };
    }
    if (payload.environment || payload.scene) {
      state.recognition.environment = {
        label: firstText(payload.environment, payload.scene),
        confidence: scoreFrom(payload.environment_confidence ?? payload.confidence),
        source: key,
        updated_at: nowText(),
      };
    }
    if (payload.intent) {
      state.recognition.intent = {
        label: String(payload.intent),
        confidence: scoreFrom(payload.intent_confidence ?? payload.confidence),
        source: key,
        updated_at: nowText(),
      };
    }
    state.raw.last_message = { key, payload, received_at: nowText() };
  });
}

function startZenohBridge(args, dashboard) {
  if (args.noZenoh) return null;

  const bridge = path.join(__dirname, "zenoh_bridge.py");
  const bridgeArgs = [
    bridge,
    "--mode", args.zenohMode,
    "--registry-key", args.registryKey,
    "--mediapipe-key", args.mediapipeKey,
    "--yolo-key", args.yoloKey,
  ];
  for (const endpoint of args.connect) bridgeArgs.push("--connect", endpoint);
  for (const endpoint of args.listen) bridgeArgs.push("--listen", endpoint);

  const child = spawn(args.python, bridgeArgs, {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  dashboard.update((state) => {
    state.connection.zenoh = "starting";
  });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        dashboard.update((state) => {
          state.connection.zenoh = "online";
        });
        if (message.kind === "status") {
          dashboard.update((state) => {
            state.connection.zenoh = message.status ?? "online";
          });
        } else if (message.kind === "registry") applyRegistry(dashboard, message.key, message.payload);
        else if (message.kind === "mediapipe") applyMediapipe(dashboard, message.key, message.payload);
        else if (message.kind === "yolo") applyYolo(dashboard, message.key, message.payload);
        else applyGenericResult(dashboard, message.key, message.payload);
      } catch (error) {
        console.error("[zenoh] bad bridge line:", line, error.message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  child.on("exit", (code, signal) => {
    dashboard.update((state) => {
      state.connection.zenoh = `stopped${code === null ? "" : `:${code}`}${signal ? `:${signal}` : ""}`;
    });
  });

  return child;
}

class VideoRelay extends EventEmitter {
  constructor(args, dashboard) {
    super();
    this.args = args;
    this.dashboard = dashboard;
    this.child = null;
    this.rtspUrl = "";
    this.latestFrame = null;
    this.lastFrameAt = 0;
    this.jpegBuffer = Buffer.alloc(0);
    this.stopping = false;
  }

  ensureStarted(rtspUrl) {
    if (this.args.noVideo || !rtspUrl) return;
    if (rtspUrl === this.rtspUrl && this.child) return;
    this.stop();
    this.rtspUrl = rtspUrl;
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      "-i", rtspUrl,
      "-an",
      "-vf", "fps=10,scale=960:-2",
      "-q:v", "5",
      "-f", "mjpeg",
      "pipe:1",
    ];
    this.child = spawn(this.args.ffmpeg, ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.dashboard.update((state) => {
      state.video.status = "connecting";
      state.video.rtsp_url = rtspUrl;
      state.video.error = "";
      state.connection.video = "connecting";
    });

    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) {
        this.dashboard.update((state) => {
          state.video.error = text.slice(-300);
        });
      }
    });
    this.child.on("exit", (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.stopping = false;
        return;
      }
      this.dashboard.update((state) => {
        state.video.status = "offline";
        state.connection.video = `stopped${code === null ? "" : `:${code}`}${signal ? `:${signal}` : ""}`;
      });
    });
  }

  consume(chunk) {
    this.jpegBuffer = Buffer.concat([this.jpegBuffer, chunk]);
    while (true) {
      const start = this.jpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      const end = this.jpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), Math.max(start, 0) + 2);
      if (start < 0) {
        this.jpegBuffer = Buffer.alloc(0);
        return;
      }
      if (end < 0) {
        if (start > 0) this.jpegBuffer = this.jpegBuffer.slice(start);
        return;
      }
      const frame = this.jpegBuffer.slice(start, end + 2);
      this.jpegBuffer = this.jpegBuffer.slice(end + 2);
      this.latestFrame = frame;
      this.lastFrameAt = Date.now();
      this.emit("frame", frame);
      this.dashboard.update((state) => {
        state.video.status = "online";
        state.video.last_frame_at = nowText();
        state.video.error = "";
        state.connection.video = "online";
      });
    }
  }

  stop() {
    if (this.child) {
      this.stopping = true;
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.latestFrame = null;
    this.lastFrameAt = 0;
    this.jpegBuffer = Buffer.alloc(0);
    this.rtspUrl = "";
  }
}

function sendJson(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const info = await stat(filePath);
  if (!info.isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const contentType = MIME[path.extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function handleEvents(req, res, dashboard) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
  });
  const write = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
  write(dashboard.snapshot());
  dashboard.on("update", write);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
  req.on("close", () => {
    clearInterval(keepalive);
    dashboard.off("update", write);
  });
}

function handleMjpeg(req, res, relay) {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=rkstudioframe",
    "Cache-Control": "no-store",
    "Connection": "close",
    "Pragma": "no-cache",
  });

  const writeFrame = (frame) => {
    res.write(`--rkstudioframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write("\r\n");
  };

  if (relay.latestFrame) writeFrame(relay.latestFrame);
  relay.on("frame", writeFrame);
  req.on("close", () => {
    relay.off("frame", writeFrame);
  });
}

const args = parseArgs(process.argv.slice(2));
const dashboard = new DashboardState(args);
const relay = new VideoRelay(args, dashboard);
const zenohChild = startZenohBridge(args, dashboard);

if (args.rtspUrl) {
  relay.ensureStarted(args.rtspUrl);
}

dashboard.on("update", (state) => {
  if (!state.video.rtsp_url) {
    relay.stop();
    return;
  }
  relay.ensureStarted(state.video.rtsp_url);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${args.host}:${args.port}`);
    if (url.pathname === "/api/state") return sendJson(res, dashboard.snapshot());
    if (url.pathname === "/events") return handleEvents(req, res, dashboard);
    if (url.pathname === "/video.mjpeg") return handleMjpeg(req, res, relay);
    return await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("Internal server error");
  }
});

server.listen(args.port, args.host, () => {
  console.log(`dashboard: http://${args.host}:${args.port}/`);
  console.log(`registry:  ${args.registryKey}`);
  console.log(`mediapipe: ${args.mediapipeKey}`);
  console.log(`yolo:      ${args.yoloKey}`);
  if (args.rtspUrl) console.log(`rtsp:      ${args.rtspUrl}`);
});

function shutdown() {
  server.close();
  relay.stop();
  if (zenohChild) zenohChild.kill("SIGTERM");
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
