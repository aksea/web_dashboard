# Intent Behavior Dashboard

独立的本地 Node.js 展示界面，用于演示和调试人的行为、环境、意图识别结果。页面会显示视频画面、设备注册状态、Owner、行为、环境和意图。

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

## 启动展示端

进入项目目录：

```bash
cd web_dashboard
```

启动服务：

```bash
npm start
```

打开浏览器：

```text
http://127.0.0.1:8787/
```

默认情况下，展示端会：

- 启动 Web 服务，监听 `127.0.0.1:8787`
- 启动 Zenoh router，监听 `tcp/0.0.0.0:7447`
- 订阅注册、Mediapipe、YOLO 三类 Zenoh 数据
- 从注册消息里的 `metadata.video_stream_url` 读取视频地址
- 用 `ffmpeg` 在本机拉流并转成浏览器可显示的 `/video.mjpeg`

## 板端配置

板端 Zenoh 需要连接这台电脑的 IP：

```toml
[zenoh]
mode = "client"
server_ip = "<展示端电脑IP>"
server_port = 7447
```

实体注册信息需要包含视频地址：

```json
{
  "action": "REG_REGISTER",
  "metadata": {
    "owner": "operator_01",
    "video_stream_url": "rtsp://<board-ip>:8554/cam"
  }
}
```

板端运行时建议按顺序开启：

1. 启动视频推流
2. 注册实体
3. 启动 Mediapipe / YOLO
4. 发送识别结果

收到 `REG_UNREGISTER` 后，页面会清空注册状态并停止显示视频画面。

## 默认订阅

```text
注册状态：zho/entity/registry
行为数据：halmet/mediapipe
环境数据：halmet/yolo
```

Mediapipe 多手结果只展示 `id` 或 `hand_id` 为 `0` 的手。当前手势显示映射：

```text
open_palm -> 张开手掌
fist      -> 握拳
unknown   -> 未知动作
```

如果识别服务直接输出 `behavior`、`environment`、`intent` 字段，页面会优先展示这些字段。

## 拼接视频标签

如果视频是 4 路拼接流，页面默认按 2x2 顺序显示：

```text
左上：面部视角
右上：第一视角
左下：躯干视角
右下：环境视角
```

需要覆盖标签时：

```bash
npm start -- --camera-labels 前方,左侧,右侧,后方
```

## 常用参数

```text
--host 127.0.0.1
--port 8787
--rtsp-url rtsp://<board-ip>:8554/cam
--zenoh-mode peer|client|router
--connect tcp/<host>:7447
--listen tcp/0.0.0.0:7447
--registry-key zho/entity/registry
--mediapipe-key halmet/mediapipe
--yolo-key halmet/yolo
--camera-labels 面部视角,第一视角,躯干视角,环境视角
--no-zenoh
--no-video
```

常见用法：

```bash
# 端口被占用时
npm start -- --port 8799

# 注册消息的视频地址不可用时，手动指定
npm start -- --rtsp-url rtsp://<board-ip>:8554/cam

# 只看页面，不连接板端
npm start -- --no-zenoh --no-video
```

## 排查

如果页面显示已注册但没有视频：

1. 打开状态接口：

```text
http://127.0.0.1:8787/api/state
```

2. 检查 `video.rtsp_url` 是否有值。

3. 检查 `video.error`，这里会显示 ffmpeg 拉流错误。

4. 在电脑上直接测试视频地址：

```bash
ffmpeg -rtsp_transport tcp -i rtsp://<board-ip>:8554/cam -frames:v 1 -f null -
```

如果 8787 或 7447 被占用，停止旧服务，或用 `--port` / `--listen` 换端口。
