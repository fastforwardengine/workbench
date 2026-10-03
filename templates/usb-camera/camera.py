#!/usr/bin/env python3
"""Agent-owned Linux USB camera and microphone, sensor API v1.

Python 3.11+, fswebcam for the camera, arecord (alsa-utils) for the
microphone. One process owns the USB device and serves two sensors: `camera`
(one PNG frame) and `microphone` (one WAV clip with its level series).

Lifecycle adapted from Ambion v0.5.0 examples/camera-chat. No daemon,
preview, captions, automatic device selection, or framework dependency.
"""
import argparse
from array import array
import datetime as dt
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import wave
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


RATE = 48000
WINDOW = 480  # Samples in 10 ms at 48 kHz.
FLOOR = -120.0
AUDIO_DEVICE = r"[A-Za-z0-9_:=,.-]+"


def samples_of(frames):
    data = array("h", frames)
    if sys.byteorder == "big":
        data.byteswap()
    return data


def demo_wav():
    """Deterministic synthetic clip: 440 Hz tone gated at 10 Hz, about -6 dBFS, 1 s."""
    gate = RATE // 20  # Half of a 10 Hz period.
    data = array("h", (round(16384 * math.sin(2 * math.pi * 440 * n / RATE)) if (n // gate) % 2 == 0 else 0
                       for n in range(RATE)))
    if sys.byteorder == "big":
        data.byteswap()
    output = io.BytesIO()
    with wave.open(output, "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(RATE)
        clip.writeframes(data.tobytes())
    return output.getvalue()


def dbfs(square_sum, count):
    """RMS level in dBFS of count samples, from the sum of their squares."""
    rms = math.sqrt(square_sum / count) / 32768
    return round(max(FLOOR, 20 * math.log10(rms)) if rms > 0 else FLOOR, 1) + 0.0


def clip_levels(wav):
    """Validate a WAV and return its peak dBFS, RMS dBFS, and 10 ms RMS envelope."""
    try:
        with wave.open(io.BytesIO(wav), "rb") as clip:
            if (clip.getnchannels(), clip.getsampwidth(), clip.getframerate()) != (1, 2, RATE):
                raise ValueError("Capture is not mono 16-bit at 48000 Hz.")
            data = samples_of(clip.readframes(clip.getnframes()))
    except (wave.Error, EOFError) as error:
        raise ValueError("Capture is not a valid WAV.") from error
    if not data:
        raise ValueError("Capture holds no samples.")
    peak = max(max(data), -min(data))
    peak_level = FLOOR if peak == 0 else round(max(FLOOR, 20 * math.log10(peak / 32768)), 1) + 0.0
    total = sum(sample * sample for sample in data)
    envelope = [dbfs(sum(sample * sample for sample in data[start:start + WINDOW]), len(data[start:start + WINDOW]))
                for start in range(0, len(data), WINDOW)]
    return peak_level, dbfs(total, len(data)), envelope


class CheckoutError(ValueError):
    """The sensor does not sit in a git checkout that has a commit."""


def launch_source(checkout, repository):
    if not re.fullmatch(r"(?!templates/)[a-z][a-z0-9-]*/[a-z0-9][a-z0-9._-]{0,63}", repository):
        raise ValueError("Set AMBION_SENSOR_REPOSITORY to your fork ID, such as engineer/bench-camera.")
    def git(*args):
        done = subprocess.run(["git", "-C", str(checkout), *args], text=True, capture_output=True, check=True)
        return done.stdout.strip()

    try:
        if git("rev-parse", "--is-inside-work-tree") != "true":
            raise subprocess.CalledProcessError(1, "git", stderr="git: the folder is not a work tree.")
        source = {"repository": repository, "commit": git("rev-parse", "--verify", "HEAD"),
                  "dirty": bool(git("status", "--porcelain", "--untracked-files=all"))}
        branch = git("branch", "--show-current")
    except OSError as error:
        raise CheckoutError(f"camera needs git on PATH to read the commit of your fork at {checkout}.") from error
    except subprocess.CalledProcessError as error:
        lines = (error.stderr or "").strip().splitlines()
        raise CheckoutError(
            f"camera needs a git checkout of your fork at {checkout}. "
            "Clone your fork, then start the sensor from the clone (README step 4)."
            + (f" Git says: {lines[0]}" if lines else "")
        ) from error
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


class Capture:
    """One capture in flight. Each request that waits for it receives its result."""

    def __init__(self):
        self.done = threading.Event()
        self.observation = None
        self.error = None


class Camera:
    """One USB device, two sensors: `camera` (frames) and `microphone` (clips)."""

    def __init__(self, source, data, device, resolution="1280x720", demo=False, audio_device=None, seconds=5):
        self.source = source
        self.data = Path(data)
        self.device = device
        self.resolution = resolution
        self.demo = demo
        self.audio_device = audio_device
        self.seconds = seconds
        self.lock = threading.Lock()  # Guards `flights`.
        self.flights = {}  # The capture in flight of each sensor.
        self.writing = threading.Lock()  # One writer at a time for the blobs and the log.
        (self.data / "blobs").mkdir(parents=True, exist_ok=True)

    def sensors(self):
        """The configured sensors, with a description of each."""
        found = {}
        if self.demo or self.device:
            found["camera"] = "Synthetic demo camera" if self.demo else "USB camera, on-demand PNG frames"
        if self.demo or self.audio_device:
            found["microphone"] = ("Synthetic demo microphone" if self.demo
                                   else "USB microphone, on-demand WAV clips with a level series")
        return found

    def store(self, digest, blob):
        """Write the blob through a temporary file, so a crash leaves no partial blob."""
        path = self.data / "blobs" / digest
        if path.exists() and path.read_bytes() == blob:
            return
        descriptor, name = tempfile.mkstemp(dir=self.data / "blobs", prefix=".tmp-")
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(blob)
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, path)
        except BaseException:
            Path(name).unlink(missing_ok=True)
            raise

    def keep(self, sensor, at, parts, digest, blob):
        """Store the blob and append the observation to the log."""
        observation = {"at": at, "parts": parts}
        with self.writing:
            self.store(digest, blob)
            with (self.data / "observations.jsonl").open("a") as output:
                output.write(json.dumps({"source": self.source, "sensor": sensor, "observation": observation}) + "\n")
        return observation

    def observe(self, sensor):
        """Serve one request. A request that arrives while a capture of the same sensor
        runs waits for that capture and receives its observation. Each sensor has its own
        device, so a camera capture and a microphone clip run in parallel."""
        with self.lock:
            flight = self.flights.get(sensor)
            leader = flight is None
            if leader:
                flight = self.flights[sensor] = Capture()
        if leader:
            try:
                flight.observation = self.acquire(sensor)
            except BaseException as error:
                flight.error = error
            finally:
                with self.lock:
                    del self.flights[sensor]
                flight.done.set()
        else:
            flight.done.wait()
        if flight.error is not None:
            raise flight.error
        return flight.observation

    def drain(self):
        """Wait for the captures in flight. The subprocess timeouts bound the wait."""
        with self.lock:
            flights = list(self.flights.values())
        for flight in flights:
            flight.done.wait()

    def acquire(self, sensor="camera"):
        if sensor == "microphone":
            return self.record()
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
        label = "SYNTHETIC DEMO: not a bench measurement." if self.demo else f"USB camera {self.device}; timestamp is capture receipt time."
        parts = [{"kind": "text", "text": label}, {"kind": "frame", "file": digest, "mediaType": "image/png"}]
        return self.keep("camera", at, parts, digest, png)

    def record(self):
        """One WAV clip, its levels, and the 10 ms level series."""
        if self.demo:
            wav, started, seconds = demo_wav(), utc(), 1
        else:
            seconds = self.seconds
            with tempfile.TemporaryDirectory(dir=self.data) as folder:
                path = Path(folder) / "clip.wav"
                started = utc()  # The series starts when arecord is launched.
                subprocess.run(["arecord", "-q", "-D", self.audio_device, "-f", "S16_LE", "-r", str(RATE),
                                "-c", "1", "-d", str(seconds), "-t", "wav", str(path)],
                               check=True, capture_output=True, timeout=seconds + 15)
                wav = path.read_bytes()
        peak, rms, envelope = clip_levels(wav)
        at = utc()  # Receipt time, not a hardware clock.
        digest = hashlib.sha256(wav).hexdigest()
        what = f"{seconds} s clip, {RATE} Hz mono 16-bit; peak {peak} dBFS, RMS {rms} dBFS."
        if self.demo:
            label = f"SYNTHETIC DEMO: not a bench measurement. A 440 Hz tone pulsed at 10 Hz; {what}"
        else:
            label = (f"USB microphone {self.audio_device}; {what} "
                     "The series starts when arecord is launched; the timestamp is receipt time.")
        parts = [{"kind": "text", "text": label},
                 {"kind": "file", "file": digest, "name": "clip.wav", "mediaType": "audio/wav"},
                 {"kind": "series", "channel": "level", "unit": "dBFS", "from": started,
                  "intervalMs": 10, "values": envelope}]
        return self.keep("microphone", at, parts, digest, wav)


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
                return self.json(200, {"api": 1, "source": camera.source, "sensors": [
                    {"name": name, "description": text, "spans": False} for name, text in camera.sensors().items()]})
            if re.fullmatch(r"/files/[a-f0-9]{64}", self.path):
                try:
                    data = (camera.data / "blobs" / self.path[7:]).read_bytes()
                except FileNotFoundError:
                    return self.error(404, "unknown", "Unknown file.")
                self.send_response(200)
                kind = "image/png" if data.startswith(b"\x89PNG") else "audio/wav"
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.error(404, "unknown", "Unknown path.")

        def do_POST(self):
            found = re.fullmatch(r"/([a-z]+)/observe", self.path)
            sensor = found.group(1) if found else None
            if sensor not in camera.sensors():
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
                return self.error(422, "unavailable", "History is not supported.")
            try:
                observation = camera.observe(sensor)
            except (OSError, ValueError, subprocess.SubprocessError):
                return self.error(503, "unavailable", f"{sensor.capitalize()} capture failed; check device access and status.")
            self.json(200, {"api": 1, "observations": [observation]})

    # StreamRequestHandler applies this timeout to the socket before it reads the headers.
    Handler.timeout = timeout
    # One thread for each request. `Camera.observe` joins the requests of one sensor to one capture.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", help="Explicit V4L2 capture node from device-scan, e.g. /dev/video0")
    parser.add_argument("--audio-device", help="ALSA PCM of the microphone from arecord -l, e.g. plughw:CARD=BRIO,DEV=0")
    parser.add_argument("--seconds", type=int, default=5, help="Length of each clip, 1 to 30")
    parser.add_argument("--resolution", default="1280x720")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    if not (args.demo or args.device or args.audio_device):
        parser.error("Select --device or --audio-device from the bench scan, or use --demo for synthetic evidence.")
    if args.audio_device and not re.fullmatch(AUDIO_DEVICE, args.audio_device):
        parser.error("Invalid audio device.")
    if not 1 <= args.seconds <= 30:
        parser.error("--seconds must be from 1 to 30.")
    if not re.fullmatch(r"[1-9][0-9]{0,3}x[1-9][0-9]{0,3}", args.resolution):
        parser.error("Invalid resolution.")
    checkout = Path(__file__).resolve().parent
    data = Path(os.environ.get("AMBION_SENSOR_DATA_DIR", "")).expanduser()
    if not data.is_absolute() or data.resolve().is_relative_to(checkout):
        parser.error("Set AMBION_SENSOR_DATA_DIR to an absolute directory outside the checkout.")
    try:
        source = launch_source(checkout, os.environ.get("AMBION_SENSOR_REPOSITORY", ""))
    except CheckoutError as error:
        print(error, file=sys.stderr)
        sys.exit(2)
    except ValueError as error:
        parser.error(str(error))
    camera = Camera(source, data, args.device, args.resolution, args.demo, args.audio_device, args.seconds)
    for sensor in camera.sensors():
        camera.acquire(sensor)  # No READY or connection before usable evidence.
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
        # A handler thread is a daemon. Wait for its capture, so that no fswebcam or arecord
        # keeps the device and no temporary folder stays in the data directory.
        camera.drain()


if __name__ == "__main__":
    main()
