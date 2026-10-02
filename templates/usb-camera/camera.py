#!/usr/bin/env python3
"""Agent-owned Linux USB camera, sensor API v1. Python 3.11+, fswebcam.

Lifecycle adapted from Ambion v0.5.0 examples/camera-chat. No daemon,
preview, captions, audio, automatic device selection, or framework dependency.
"""
import argparse
import datetime as dt
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import tempfile
import zlib


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def demo_png():
    """Small deterministic synthetic PNG; never a bench measurement."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\0\xff\0\0\0\xff\0\0\0\0\xff\xff\xff\xff"))
            + chunk(b"IEND", b""))


def launch_source(checkout, repository):
    if not re.fullmatch(r"(?!templates/)[a-z][a-z0-9-]*/[a-z0-9][a-z0-9._-]{0,63}", repository):
        raise ValueError("Set AMBION_SENSOR_REPOSITORY to your fork ID, such as instruments/bench-camera.")
    def git(*args):
        return subprocess.check_output(["git", "-C", str(checkout), *args], text=True).strip()
    source = {"repository": repository, "commit": git("rev-parse", "HEAD"),
              "dirty": bool(git("status", "--porcelain", "--untracked-files=all"))}
    branch = git("branch", "--show-current")
    if branch:
        source["branch"] = branch
    return source


def valid_request(body):
    if not isinstance(body, dict) or type(body.get("api")) is not int or body["api"] != 1:
        return False
    if set(body) - {"api", "span"}:
        return False
    if "span" not in body:
        return True
    span = body["span"]
    if not isinstance(span, dict) or set(span) != {"from", "to"}:
        return False
    for value in span.values():
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value):
            return False
        try:
            dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
    return span["from"] < span["to"]


class Camera:
    def __init__(self, source, data, device, resolution="1280x720", demo=False):
        self.source = source
        self.data = Path(data)
        self.device = device
        self.resolution = resolution
        self.demo = demo
        (self.data / "blobs").mkdir(parents=True, exist_ok=True)

    def store(self, digest, png):
        """Write the blob through a temporary file, so a crash leaves no partial blob."""
        blob = self.data / "blobs" / digest
        if blob.exists() and blob.read_bytes() == png:
            return
        descriptor, name = tempfile.mkstemp(dir=self.data / "blobs", prefix=".tmp-")
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(png)
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, blob)
        except BaseException:
            Path(name).unlink(missing_ok=True)
            raise

    def acquire(self):
        if self.demo:
            png = demo_png()
        else:
            # Temporary capture stays outside Git. A timeout bounds acquisition.
            with tempfile.TemporaryDirectory(dir=self.data) as folder:
                path = Path(folder) / "frame.png"
                subprocess.run(["fswebcam", "-d", self.device, "-r", self.resolution,
                                "-S", "10", "--no-banner", "--png", "6", str(path)],
                               check=True, capture_output=True, timeout=30)
                png = path.read_bytes()
                if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError("Capture did not produce a PNG.")
        at = utc()  # Receipt time, not a camera hardware clock.
        digest = hashlib.sha256(png).hexdigest()
        self.store(digest, png)
        label = "SYNTHETIC DEMO: not a bench measurement." if self.demo else f"USB camera {self.device}; timestamp is capture receipt time."
        observation = {"at": at, "parts": [{"kind": "text", "text": label},
                       {"kind": "frame", "file": digest, "mediaType": "image/png"}]}
        with (self.data / "observations.jsonl").open("a") as output:
            output.write(json.dumps({"source": self.source, "observation": observation}) + "\n")
        return observation


def open_server(camera, port=0, timeout=10):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def json(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def error(self, status, code, message):
            self.json(status, {"api": 1, "code": code, "message": message})

        def do_GET(self):
            if self.path == "/":
                return self.json(200, {"api": 1, "source": camera.source, "sensors": [{
                    "name": "camera", "description": "Synthetic demo camera" if camera.demo else "USB camera, on-demand PNG frames",
                    "spans": False}]})
            if re.fullmatch(r"/files/[a-f0-9]{64}", self.path):
                try:
                    data = (camera.data / "blobs" / self.path[7:]).read_bytes()
                except FileNotFoundError:
                    return self.error(404, "unknown", "Unknown frame.")
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.error(404, "unknown", "Unknown path.")

        def do_POST(self):
            if self.path != "/camera/observe":
                return self.error(404, "unknown", "Unknown sensor.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("Invalid body length.")
                body = json.loads(self.rfile.read(length))
                if not valid_request(body):
                    raise ValueError("Invalid request.")
            except (ValueError, OSError):
                return self.error(400, "invalid", "Invalid observation request.")
            if "span" in body:
                return self.error(422, "unavailable", "Frame history is not supported.")
            try:
                observation = camera.acquire()
            except (OSError, ValueError, subprocess.SubprocessError):
                return self.error(503, "unavailable", "Camera capture failed; check device access and status.")
            self.json(200, {"api": 1, "observations": [observation]})

    # StreamRequestHandler applies this timeout to the socket before it reads the headers.
    Handler.timeout = timeout
    # Single request at a time: no overlapping capture of the same device.
    return HTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", help="Explicit V4L2 capture node from device-scan, e.g. /dev/v4l/by-id/<camera>-video-index0")
    parser.add_argument("--resolution", default="1280x720")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    if not args.demo and not args.device:
        parser.error("Select --device from the bench scan, or use --demo for synthetic evidence.")
    if not re.fullmatch(r"[1-9][0-9]{0,3}x[1-9][0-9]{0,3}", args.resolution):
        parser.error("Invalid resolution.")
    checkout = Path(__file__).resolve().parent
    data = Path(os.environ.get("AMBION_SENSOR_DATA_DIR", "")).expanduser()
    if not data.is_absolute() or data.resolve().is_relative_to(checkout):
        parser.error("Set AMBION_SENSOR_DATA_DIR to an absolute directory outside the checkout.")
    source = launch_source(checkout, os.environ.get("AMBION_SENSOR_REPOSITORY", ""))
    camera = Camera(source, data, args.device, args.resolution, args.demo)
    camera.acquire()  # No READY or connection before a usable frame.
    server = open_server(camera, args.port)
    def stop(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("READY " + json.dumps({"port": server.server_port, "source": source}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
