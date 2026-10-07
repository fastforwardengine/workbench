#!/usr/bin/env python3
"""Agent-owned macOS USB camera and microphone, sensor API v2.

Python 3.11+ and ffmpeg (Homebrew) with AVFoundation, for the camera and for the
microphone. One process owns the USB device and serves two sensors: `camera`
(one PNG frame) and `microphone` (one WAV clip with its level series).

The server listens on 127.0.0.1 at the port of the PORT variable, which the
workspace sets for each process that bash starts. It prints nothing. A reader
calls `fetch` with `GET /`, `GET /<sensor>/observe`, and `GET /files/<sha256>`.

Select the camera with --usb-id, or with --device. The server asks system_profiler for the name of
a USB ID, and ffmpeg for the AVFoundation index of that name, at each capture. A reconnect that
renumbers the indexes needs no restart.

Lifecycle adapted from Ambion v0.6.0 examples/camera-chat. No daemon,
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
from urllib.parse import parse_qsl, urlsplit
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


API = 2  # The sensor protocol version. Every JSON body carries it.
STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
RATE = 48000
WINDOW = 480  # Samples in 10 ms at 48 kHz.
FLOOR = -120.0
DEVICE_NAME = r"[A-Za-z0-9 _:=,.()'+-]+"  # An AVFoundation name, or an index.
USB_ID = r"[0-9a-fA-F]{4}:[0-9a-fA-F]{4}"
SKIPPED_FRAMES = 10  # The exposure settles in these frames.
USB_TYPES = ("SPUSBDataType", "SPUSBHostDataType")  # The second one is for a newer macOS.
VENDOR_KEYS = ("vendor_id", "apple_vendor_id", "USBDeviceKeyVendorID", "idVendor")
PRODUCT_KEYS = ("product_id", "USBDeviceKeyProductID", "idProduct")


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


def hex_id(entry, keys):
    """The four hex digits in the first of these keys that has a value, such as 0x046d  (Logitech Inc.)."""
    for key in keys:
        found = re.search(r"0x([0-9a-fA-F]{1,4})", str(entry.get(key, "")))
        if found:
            return found.group(1).lower().zfill(4)
    return None


def usb_names(tree, usb_id):
    """The names of the USB devices with this ID, from the JSON of system_profiler, at any depth."""
    names = []
    if isinstance(tree, dict):
        if f"{hex_id(tree, VENDOR_KEYS)}:{hex_id(tree, PRODUCT_KEYS)}" == usb_id and tree.get("_name"):
            names.append(str(tree["_name"]))
        for value in tree.values():
            names += usb_names(value, usb_id)
    elif isinstance(tree, list):
        for value in tree:
            names += usb_names(value, usb_id)
    return names


def usb_name(usb_id):
    """The name of the one USB device with this ID. A newer macOS lists devices under another data type."""
    names = []
    for data_type in USB_TYPES:
        done = subprocess.run(["system_profiler", data_type, "-json"], capture_output=True, text=True, timeout=60)
        try:
            names = sorted(set(usb_names(json.loads(done.stdout), usb_id)))
        except json.JSONDecodeError:
            continue
        if names:
            break
    if not names:
        raise ValueError(f"No USB device has ID {usb_id}. Attach the camera, then scan again.")
    if len(names) > 1:
        raise ValueError(f"More than one USB device has ID {usb_id}: {', '.join(names)}. Use --device.")
    return names[0]


def avfoundation_devices():
    """The AVFoundation devices of ffmpeg: {"video": [(index, name)], "audio": [...]}.
    ffmpeg prints the list on stderr, and it exits with status 1 because the input is empty."""
    done = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                          capture_output=True, text=True, timeout=30)
    found, kind = {"video": [], "audio": []}, None
    for line in (done.stderr + done.stdout).splitlines():
        if "AVFoundation video devices:" in line:
            kind = "video"
        elif "AVFoundation audio devices:" in line:
            kind = "audio"
        entry = re.match(r"\[AVFoundation[^\]]*\]\s+\[(\d+)\]\s+(.+?)\s*$", line)
        if entry and kind:
            found[kind].append((int(entry.group(1)), entry.group(2)))
    return found


def pick(kind, wanted, devices=None):
    """The (index, name) of the AVFoundation device of this kind, from a name or an index.
    An index passes as it is, with no name. A name matches in any case. An exact match wins over a part of a name."""
    if re.fullmatch(r"[0-9]+", wanted):
        return int(wanted), None
    devices = (devices or avfoundation_devices())[kind]
    key = wanted.casefold()
    found = [one for one in devices if one[1].casefold() == key]
    found = found or [one for one in devices if key in one[1].casefold() or one[1].casefold() in key]
    if not found:
        listing = ", ".join(f"{index} {name}" for index, name in devices) or "none"
        raise ValueError(f"No AVFoundation {kind} device is named {wanted}. The {kind} devices are: {listing}.")
    if len(found) > 1:
        raise ValueError(f"More than one AVFoundation {kind} device matches {wanted}: "
                         f"{', '.join(f'{index} {name}' for index, name in found)}. Use the index.")
    return found[0]


def video_choice(device, usb_id):
    """The (index, name) of the video device. A USB ID goes to its name, and the name to an index."""
    return pick("video", usb_name(usb_id) if usb_id else device)


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
            "Clone your fork, then start the sensor from the clone (README, the fork and clone step)."
            + (f" Git says: {lines[0]}" if lines else "")
        ) from error
    if branch:
        source["branch"] = branch
    return source


def valid_query(query):
    """True when the query is empty, or holds one `from` and one `to` that make a span."""
    pairs = parse_qsl(query, keep_blank_values=True)
    if not pairs:
        return query == ""
    values = dict(pairs)
    if len(pairs) != 2 or set(values) != {"from", "to"}:
        return False
    for value in values.values():
        if not STAMP.fullmatch(value):
            return False
        try:
            dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
    return values["from"] < values["to"]


class Capture:
    """One capture in flight. Each request that waits for it receives its result."""

    def __init__(self):
        self.done = threading.Event()
        self.observation = None
        self.error = None


class Camera:
    """One USB device, two sensors: `camera` (frames) and `microphone` (clips)."""

    def __init__(self, source, data, device, resolution="1280x720", demo=False, audio_device=None, seconds=5,
                 usb_id=None, framerate="30"):
        self.source = source
        self.data = Path(data)
        self.device = device
        self.usb_id = usb_id
        self.resolution = resolution
        self.framerate = framerate
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
        if self.demo or self.device or self.usb_id:
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
        index, name = None, None
        if self.demo:
            png = demo_png()
        else:
            # A name resolves at each capture, so a reconnect that renumbers the devices needs no restart.
            index, name = video_choice(self.device, self.usb_id)
            # Temporary capture stays outside Git. A timeout bounds acquisition.
            with tempfile.TemporaryDirectory(dir=self.data) as folder:
                path = Path(folder) / "frame.png"
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation",
                                "-framerate", self.framerate, "-video_size", self.resolution, "-i", str(index),
                                "-vf", f"trim=start_frame={SKIPPED_FRAMES},setpts=PTS-STARTPTS",
                                "-frames:v", "1", "-update", "1", str(path)],
                               check=True, capture_output=True, timeout=30)
                png = path.read_bytes()
                if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError("Capture did not produce a PNG.")
        at = utc()  # Receipt time, not a camera hardware clock.
        digest = hashlib.sha256(png).hexdigest()
        where = ", ".join(filter(None, [self.usb_id, f"AVFoundation video {index}" + (f' "{name}"' if name else "")]))
        label = "SYNTHETIC DEMO: not a bench measurement." if self.demo else f"USB camera {where}; timestamp is capture receipt time."
        parts = [{"kind": "text", "text": label}, {"kind": "frame", "file": digest, "mediaType": "image/png"}]
        return self.keep("camera", at, parts, digest, png)

    def record(self):
        """One WAV clip, its levels, and the 10 ms level series."""
        if self.demo:
            wav, started, seconds = demo_wav(), utc(), 1
        else:
            seconds = self.seconds
            index, _name = pick("audio", self.audio_device)  # The index can change after a reconnect.
            with tempfile.TemporaryDirectory(dir=self.data) as folder:
                path = Path(folder) / "clip.wav"
                started = utc()  # The series starts when ffmpeg is launched.
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation",
                                "-i", f":{index}", "-t", str(seconds), "-ac", "1", "-ar", str(RATE),
                                "-c:a", "pcm_s16le", "-f", "wav", str(path)],
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
                     "The series starts when ffmpeg is launched; the timestamp is receipt time.")
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
            self.json(status, {"api": API, "code": code, "message": message})

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == "/":
                return self.json(200, {"api": API, "source": camera.source, "sensors": [
                    {"name": name, "description": text, "spans": False} for name, text in camera.sensors().items()]})
            if re.fullmatch(r"/files/[a-f0-9]{64}", url.path):
                return self.file(url.path[7:])
            found = re.fullmatch(r"/([a-z]+)/observe", url.path)
            if found:
                return self.observe(found.group(1), url.query)
            self.error(404, "unknown", "Unknown path.")

        def file(self, digest):
            try:
                data = (camera.data / "blobs" / digest).read_bytes()
            except FileNotFoundError:
                return self.error(404, "unknown", "Unknown file.")
            self.send_response(200)
            kind = "image/png" if data.startswith(b"\x89PNG") else "audio/wav"
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def observe(self, sensor, query):
            if sensor not in camera.sensors():
                return self.error(404, "unknown", "Unknown sensor.")
            if not valid_query(query):
                return self.error(400, "invalid", "The query is empty, or holds one from and one to that make a span.")
            if query:
                return self.error(422, "unavailable", "History is not supported.")
            try:
                observation = camera.observe(sensor)
            except (OSError, ValueError, subprocess.SubprocessError):
                return self.error(503, "unavailable", f"{sensor.capitalize()} capture failed; check the device and its access.")
            self.json(200, {"api": API, "observations": [observation]})

        def unsupported(self):
            self.error(404, "unknown", "Unknown path.")

        do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = unsupported

    # StreamRequestHandler applies this timeout to the socket before it reads the headers.
    Handler.timeout = timeout
    # One thread for each request. `Camera.observe` joins the requests of one sensor to one capture.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def port_of(value):
    """The port that the workspace gave this process, or a reason that it gave none."""
    if value is None or not re.fullmatch(r"[0-9]{1,5}", value) or not 1 <= int(value) <= 65535:
        raise ValueError("Set PORT to an integer from 1 to 65535. The workspace sets it for each process that bash starts.")
    return int(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", help="AVFoundation video device, a name or an index from the ffmpeg list, e.g. 'Logitech BRIO'")
    parser.add_argument("--usb-id", help="USB ID of the camera from device-scan, e.g. 046d:085e. The server finds the device at each capture")
    parser.add_argument("--audio-device", help="AVFoundation audio device, a name or an index from the ffmpeg list, e.g. BRIO")
    parser.add_argument("--seconds", type=int, default=5, help="Length of each clip, 1 to 30")
    parser.add_argument("--resolution", default="1280x720")
    parser.add_argument("--framerate", default="30", help="Frames per second that the camera lists, e.g. 30")
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args()
    if args.device and args.usb_id is not None:
        parser.error("--device and --usb-id exclude each other. Give one of them.")
    if not (args.demo or args.device or args.usb_id or args.audio_device):
        parser.error("Select --usb-id, --device, or --audio-device from the bench scan, or use --demo for synthetic evidence.")
    if args.usb_id is not None:
        if not re.fullmatch(USB_ID, args.usb_id):
            parser.error("Invalid USB ID. Give four hex digits, a colon, and four hex digits, such as 046d:085e.")
        args.usb_id = args.usb_id.lower()
    if args.device and not re.fullmatch(DEVICE_NAME, args.device):
        parser.error("Invalid video device.")
    if args.audio_device and not re.fullmatch(DEVICE_NAME, args.audio_device):
        parser.error("Invalid audio device.")
    if not re.fullmatch(r"[1-9][0-9]{0,2}(\.[0-9]{1,6})?", args.framerate):
        parser.error("Invalid frame rate.")
    if not 1 <= args.seconds <= 30:
        parser.error("--seconds must be from 1 to 30.")
    if not re.fullmatch(r"[1-9][0-9]{0,3}x[1-9][0-9]{0,3}", args.resolution):
        parser.error("Invalid resolution.")
    try:
        port = port_of(os.environ.get("PORT"))
    except ValueError as error:
        parser.error(str(error))
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
    camera = Camera(source, data, args.device, args.resolution, args.demo, args.audio_device, args.seconds,
                    args.usb_id, args.framerate)
    for sensor in camera.sensors():
        camera.acquire(sensor)  # The server listens only after the first usable evidence.
    try:
        server = open_server(camera, port)
    except OSError as error:
        print(f"camera cannot listen on port {port}: {error}. Start it again to get a new port.", file=sys.stderr)
        sys.exit(1)
    def stop(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        # A handler thread is a daemon. Wait for its capture, so that no ffmpeg
        # keeps the device and no temporary folder stays in the data directory.
        camera.drain()


if __name__ == "__main__":
    main()
