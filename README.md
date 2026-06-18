# Cursor Arm Dashboard

本地 Web 展示端，用于接收板端 Zenoh 手势识别结果、戒指点击事件，并显示头盔 RTSP 视频。

当前界面布局：

- 顶部二分之一：光标控制区域，背景图来自 `public/assets/cursor-board.png`
- 左下四分之一：机械臂控制，显示 `上` / `下` / `停` 和柱子高度
- 右下四分之一：RTSP 视频画面

## 运行环境

- Node.js 18 或更高版本
- `ffmpeg`，用于在本机拉取 RTSP 并转成浏览器可显示的视频
- Python 3
- Python 包 `eclipse-zenoh`，用于订阅 Zenoh 消息

检查依赖：

```bash
node --version
ffmpeg -version
python3 --version
python3 -m pip show eclipse-zenoh
```

如果缺少 Zenoh Python 包：

```bash
python3 -m pip install eclipse-zenoh
```

## 启动

```bash
cd web_dashboard
npm start -- --rtsp-url rtsp://192.168.8.69:8554/cam
```

打开：

```text
http://127.0.0.1:8787/
```

默认情况下，展示端会：

- 启动 Web 服务，监听 `127.0.0.1:8787`
- 启动 Zenoh router，监听 `tcp/0.0.0.0:7447`
- 订阅 Mediapipe 手势数据：`halmet/mediapipe`
- 订阅戒指事件：`actor/ring/intent`
- 用 `ffmpeg` 将 RTSP 转成浏览器可显示的 `/video.mjpeg`

## 交互规则

- `pointing`：使用食指指尖的 delta 控制顶部红点移动
- `ok`：在红点当前位置打点
- 戒指 `tap`：在红点当前位置打点
- `up`：识别为控制机械臂向上
- `down`：识别为控制机械臂向下

板端负责完成 `pointing`、`ok`、`up`、`down` 的识别，前端只根据识别结果更新 UI。

## 板端配置

板端 Zenoh 需要连接这台电脑的 IP：

```toml
[zenoh]
mode = "client"
server_ip = "<展示端电脑IP>"
server_port = 7447
```

RTSP 地址只来自启动参数或代码里的默认值。启动时传 `--rtsp-url` 会覆盖默认值；如果代码里没有默认值且启动时也没有传地址，页面会显示“当前无 RTSP 目标地址”。

## 常用参数

```text
--host 127.0.0.1
--port 8787
--rtsp-url rtsp://<board-ip>:8554/cam
--zenoh-mode peer|client|router
--connect tcp/<host>:7447
--listen tcp/0.0.0.0:7447
--mediapipe-key halmet/mediapipe
--ring-key actor/ring/intent
--yolo-key halmet/yolo
--no-zenoh
--no-video
```

常见用法：

```bash
# 端口被占用时
npm start -- --port 8799

# 只看页面，不连接板端
npm start -- --no-zenoh --no-video
```

## 排查

状态接口：

```text
http://127.0.0.1:8787/api/state
```

如果没有视频，检查：

1. `video.rtsp_url` 是否为板端 RTSP 地址
2. `video.status` 是否为 `online`
3. `video.error` 是否有 ffmpeg 错误

电脑上可以直接测试 RTSP：

```bash
ffmpeg -rtsp_transport tcp -i rtsp://192.168.8.69:8554/cam -frames:v 1 -f null -
```
