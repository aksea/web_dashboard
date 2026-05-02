# Intent Behavior Dashboard

独立的本地 Node.js Web 展示界面，用于项目演示、调试和交付展示。页面展示 RTSP 视频画面，以及识别服务输出的行为、环境和意图。

## 功能

- 浅色卡片式 Dashboard
- RTSP 视频展示
- Zenoh 注册状态展示
- Zenoh 识别结果展示：行为、环境、意图
- 默认从注册消息里的 `metadata.video_stream_url` 读取 RTSP 地址
- 支持启动时手动覆盖 RTSP 地址

## 依赖

- Node.js 18+
- `ffmpeg`，用于把 RTSP 转成浏览器可显示的视频流
- Python 包 `eclipse-zenoh`，用于 Zenoh 订阅桥接

安装 Zenoh Python 包：

```bash
python3 -m pip install eclipse-zenoh
```

## 启动

进入本目录：

```bash
cd web_dashboard
```

默认会作为 Zenoh router 监听 `tcp/0.0.0.0:7447`，通常直接启动即可：

```bash
npm start
```

打开：

```text
http://127.0.0.1:8787/
```

默认从 Zenoh 注册消息读取 RTSP 地址，通常直接启动即可：

```bash
npm start
```

如果注册消息里的 RTSP 地址不可用，或需要临时覆盖：

```bash
npm start -- --rtsp-url rtsp://<board-ip>:8554/cam
```

## 常用参数

```text
--host 127.0.0.1
--port 8787
--rtsp-url rtsp://<board-ip>:8554/cam
--zenoh-mode peer|client|router    默认 router
--connect tcp/<host>:7447
--listen tcp/0.0.0.0:7447          默认监听这个地址
--camera-labels 面部视角,第一视角,躯干视角,环境视角
--registry-key zho/entity/registry
--mediapipe-key halmet/mediapipe
--yolo-key halmet/yolo
--no-zenoh
--no-video
```

## 输入数据

默认订阅三类 Zenoh key：

- `zho/entity/registry`：设备注册状态，注册 payload 可包含 `metadata.video_stream_url`
- `halmet/mediapipe`：行为数据，例如手势 `open_palm`、`fist`；多手结果只展示 `id` / `hand_id` 为 `0` 的手
- `halmet/yolo`：环境目标数据

如果识别服务直接输出 `behavior`、`environment`、`intent` 字段，页面也会优先展示这些字段。

## 拼接视频标签

如果 RTSP 地址是 4 路拼接流，页面会默认按 2x2 顺序在每路画面的左上角显示：

```text
左上：面部视角
右上：第一视角
左下：躯干视角
右下：环境视角
```

现场摄像头安装方向不同时，可以覆盖标签：

```bash
npm start -- --camera-labels 前方,左侧,右侧,后方
```
