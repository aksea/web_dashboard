#!/usr/bin/env python3
"""Line-delimited JSON Zenoh subscriber bridge for the Node.js dashboard."""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
import time
from typing import Any

try:
    import zenoh
except ImportError as exc:
    raise SystemExit(
        "Missing Python package 'zenoh'. Install it with:\n"
        f"  {sys.executable} -m pip install eclipse-zenoh"
    ) from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry-key", default="zho/entity/registry")
    parser.add_argument("--mediapipe-key", default="halmet/mediapipe")
    parser.add_argument("--yolo-key", default="halmet/yolo")
    parser.add_argument("--mode", default="peer", choices=("peer", "client", "router"))
    parser.add_argument("--connect", action="append", default=[])
    parser.add_argument("--listen", action="append", default=[])
    return parser.parse_args()


def make_config(args: argparse.Namespace):
    config = zenoh.Config()
    config.insert_json5("mode", json.dumps(args.mode))
    if args.connect:
        config.insert_json5("connect/endpoints", json.dumps(args.connect))
    if args.listen:
        config.insert_json5("listen/endpoints", json.dumps(args.listen))
    return config


def payload_to_text(payload: Any) -> str:
    if hasattr(payload, "to_bytes"):
        return payload.to_bytes().decode("utf-8", errors="replace")
    return bytes(payload).decode("utf-8", errors="replace")


def emit(kind: str, sample: Any) -> None:
    key = str(sample.key_expr)
    text = payload_to_text(sample.payload)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = {"raw": text}
    print(
        json.dumps(
            {
                "kind": kind,
                "key": key,
                "payload": payload,
                "received_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def emit_status(status: str) -> None:
    print(
        json.dumps(
            {
                "kind": "status",
                "status": status,
                "received_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def main() -> int:
    args = parse_args()
    stopped = threading.Event()

    def handle_signal(signum, frame) -> None:
        stopped.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    session = zenoh.open(make_config(args))
    subscribers = [
        session.declare_subscriber(args.registry_key, lambda sample: emit("registry", sample)),
        session.declare_subscriber(args.mediapipe_key, lambda sample: emit("mediapipe", sample)),
        session.declare_subscriber(args.yolo_key, lambda sample: emit("yolo", sample)),
    ]
    emit_status("online")

    try:
        while not stopped.is_set():
            time.sleep(0.2)
    finally:
        for subscriber in subscribers:
            subscriber.undeclare()
        session.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
