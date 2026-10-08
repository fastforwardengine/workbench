#!/usr/bin/env python3
"""Agent-owned Linux USB camera and microphone, sensor API v2.

Python 3.11+, v4l2-ctl and Pillow for the camera, arecord (alsa-utils) for the
microphone. One process owns the USB device and serves two sensors: `camera`
(a stream of JPEG frames in a ring in RAM) and `microphone` (one WAV clip with
its level series).

The server listens on 127.0.0.1 at the port of the PORT variable, which the
workspace sets for each process that bash starts. It prints nothing. A reader
calls `fetch` with `GET /`, `GET /<sensor>/observe`, and `GET /files/<sha256>`.

Select the camera with --usb-id where no udev runs, or with --device. The server finds the capture
node of a USB ID again at each restart of the stream, so a reconnect that renumbers /dev/videoN needs
no restart of the server.

Lifecycle adapted from Ambion v0.6.0 examples/camera-chat. No daemon,
preview, captions, automatic device selection, or framework dependency.
"""
import argparse
import base64
import datetime as dt
import hashlib
import importlib.util
import io
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from array import array
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import parse_qsl, urlsplit


def utc():
    return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


API = 2  # The sensor protocol version. Every JSON body carries it.
STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
RATE = 48000
WINDOW = 480  # Samples in 10 ms at 48 kHz.
FLOOR = -120.0
AUDIO_DEVICE = r"[A-Za-z0-9_:=,.-]+"
USB_ID = r"[0-9a-fA-F]{4}:[0-9a-fA-F]{4}"
VIDEO4LINUX = Path("/sys/class/video4linux")

STREAM_FPS = 5  # Frames each second that v4l2-ctl streams.
DETECT_PERIOD = 0.5  # Seconds between two frames that go through the change rule: 2 frames each second.
RING_SECONDS = 120  # The ring keeps a frame for this time.
RING_MAX = 60  # The ring keeps this many frames at most.
SHOWN_MAX = 20  # Newest frames that an observation named, and that the ring did not keep.
MIN_GAP = 2.0  # Seconds between two kept frames, at least.
PIXEL_DELTA = 20  # A pixel differs when its grey value moves by more than this.
CHANGED_SHARE = 0.02  # The ring keeps a frame when more than this share of the pixels differ.
STALE_SECONDS = 10  # The newest frame is too old for an observation after this time.
FIRST_FRAME_SECONDS = 30  # The server waits this long for the first frame before it listens.
RESTART_PAUSE = 1.0  # Seconds between the end of a stream and the next start.
GREY_SIZE = (64, 36)  # The grey copy for the change rule: width and height.
CHUNK = 65536  # Bytes for each read of the stream.
FRAME_LIMIT = 16 * 1024 * 1024  # The splitter drops more bytes than this without an end marker.
SOI, EOI = b"\xff\xd8", b"\xff\xd9"  # JPEG start of image and end of image.


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


def usb_id_of(entry):
    """The USB ID, in lower case, of the device behind one video4linux entry."""
    usb = (entry / "device").resolve().parent  # The `device` link names the USB interface.
    return f"{(usb / 'idVendor').read_text().strip()}:{(usb / 'idProduct').read_text().strip()}".lower()


def capture_node(usb_id, root=VIDEO4LINUX):
    """The /dev/videoN path of the capture node of the USB device with this ID.
    A UVC camera also has a metadata node, whose index is 1. An entry that sysfs cannot read has no match."""
    found = []
    for entry in sorted(root.iterdir()) if root.is_dir() else []:
        try:
            if (entry / "index").read_text().strip() == "0" and usb_id_of(entry) == usb_id:
                found.append(f"/dev/{entry.name}")
        except OSError:
            continue
    if not found:
        raise ValueError(f"No capture node has USB ID {usb_id}. Attach the camera, then scan again.")
    if len(found) > 1:
        raise ValueError(f"More than one camera has USB ID {usb_id}: {', '.join(found)}. Use --device.")
    return found[0]


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
            dt.datetime.fromisoformat(value)
        except ValueError:
            return False
    return values["from"] < values["to"]


def demo_pixel(x, y):
    """The grey value of the synthetic scene at one pixel of the 64x36 grid: a ramp with a bright block."""
    return 220 if 24 <= x < 40 and 12 < y <= 24 else 40 + 2 * x


# The grey copy of the scene, made without a decoder. DEMO_JPEG shows the same scene at three times the size.
DEMO_GREY = [demo_pixel(x, y) for y in range(GREY_SIZE[1]) for x in range(GREY_SIZE[0])]
DEMO_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1R"
    "V19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj"
    "Y2NjY2NjY2NjY2NjY2P/wAARCABsAMADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA"
    "AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6"
    "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG"
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA"
    "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5"
    "OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE"
    "xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlBThTRThQA8U8UwU8UAOFPFMFPFADxThT"
    "RThQA8U8UwU8UAOFPFMFPFADxThTRThQA8U8UwU8UAOFPFMFPFADxTxTBTxQA4U8UwU8UAPFOFNFOFAHBCnCminCgB4p4pgp"
    "4oAcKeKYKeKAHinCminCgB4p4pgp4oAcKeKYKeKAHinCminCgB4p4pgp4oAcKeKYKeKAHinimCnigBwp4pgp4oAeKcKaKcKA"
    "OCFOFNFOFADxTxTBTxQA4U8UwU8UAPFOFNFOFADxVsWF5/z6T/8Afs1UFeiUAcQLG8/59J/+/Zp4sbv/AJ9Z/wDv2a7SigDj"
    "RZXf/PrN/wB+zThZXX/PtN/37NdhRQByQs7r/n2m/wC+DUYrsa44UAOFPFMFPFADxTxTBTxQA4U8UwU8UAPFOFNFOFAHBCnC"
    "minCgB4p4pgp4oAcKeKYKeKAHinCminCgB4r0SvOxXolABRRRQAUUUUAFccK7GuOFADhTxTBTxQA8U8UwU8UAOFPFMFPFADx"
    "ThTRThQBwQpwpopwoAeKeKYKeKAHCnimCnigB4pwpopwoAeK9ErzsVtjxJef88oP++T/AI0AdTRXMDxHef8APOD/AL5P+NOH"
    "iG7/AOecH/fJ/wAaAOlormx4gu/+ecP/AHyf8acNeuv+ecP5H/GgDoq44VojXbr/AJ5w/kf8azhQA4U8UwU8UAPFPFMFPFAD"
    "hTxTBTxQA8U4U0U4UAcEKcKaKcKAHinimCnigBwp4pgp4oAeKcKaKcKAHinimCnigBwp4pgp4oAeKcKaKcKAHinimCnigBwp"
    "4pgp4oAeKeKYKeKAHCnimCnigB4pwpopwoA4IU4U0U4UAPFPFMFPFADhTxTBTxQA8U4U0U4UAPFPFMFPFADhTxTBTxQA8U4U"
    "0U4UAPFPFMFPFADhTxTBTxQA8U8UwU8UAOFPFMFPFADxThTRThQB/9k="
)


def centered(grey):
    """A grey copy with its mean subtracted, so that a change of brightness moves no pixel."""
    mean = sum(grey) / len(grey)
    return [value - mean for value in grey]


def changed_share(before, after):
    """The share of the pixels whose grey value moves by more than PIXEL_DELTA, after the means leave."""
    pairs = zip(centered(before), centered(after))
    return sum(abs(one - other) > PIXEL_DELTA for one, other in pairs) / len(before)


def judge(last, grey, gap):
    """The change rule. `last` is the grey copy of the last kept frame, or None before the first frame.
    `gap` is the time in seconds since that frame. Returns whether to keep the frame, and the share of
    changed pixels (None for the first frame)."""
    if last is None:
        return True, None
    share = changed_share(last, grey)
    return share > CHANGED_SHARE and gap >= MIN_GAP, share


def grey_of(jpeg):
    """A grey 64x36 copy of a JPEG as 2304 ints, or None when the JPEG does not decode.
    Any failure gives None: a corrupt frame can raise more than a decode error, such as the
    decompression bomb error of Pillow or MemoryError."""
    from PIL import Image  # Pillow loads here only: the tests of the rule and the demo need none.
    try:
        with Image.open(io.BytesIO(jpeg)) as image:
            image.draft("L", GREY_SIZE)  # The decoder then scales down while it reads.
            return list(image.convert("L").resize(GREY_SIZE).tobytes())
    except Exception:  # noqa: BLE001 - One bad frame must not stop the reader thread.
        return None


class Splitter:
    """Cut a byte stream into JPEG frames at the start and end markers. Junk between frames goes away."""

    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        """Add bytes, and return the frames that end in them."""
        self.buffer += data
        frames = []
        while (frame := self.next_frame()) is not None:
            frames.append(frame)
        return frames

    def next_frame(self):
        start = self.buffer.find(SOI)
        if start < 0:
            # A marker can split across two reads: keep a last 0xFF.
            del self.buffer[:len(self.buffer) - self.buffer.endswith(b"\xff")]
            return None
        del self.buffer[:start]
        # A frame ends at the first EOI, so an embedded EXIF thumbnail would split it. UVC MJPEG streams carry none.
        end = self.buffer.find(EOI, 2)
        if end < 0:
            if len(self.buffer) > FRAME_LIMIT:
                self.buffer.clear()  # No end marker in this many bytes: not a frame.
            return None
        frame = bytes(self.buffer[:end + 2])
        del self.buffer[:end + 2]
        return frame


class Frame(NamedTuple):
    at: str  # Receipt time, UTC with milliseconds.
    seen: float  # Receipt time on the clock of the ring, in seconds.
    jpeg: bytes
    digest: str
    share: float | None  # Share of changed pixels. None for the first frame.


class Ring:
    """The frames that the change rule kept, the newest frame, and a lock for the threads of the server."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.arrived = threading.Event()  # Set at the first frame.
        self.kept = deque(maxlen=RING_MAX)
        self.shown = deque(maxlen=SHOWN_MAX)  # Newest frames that an observation named.
        self.newest = None
        self.base = None  # The grey copy of the last kept frame.
        self.last_at = None  # The receipt time of the last kept frame. It stays after the ring drops that frame.
        self.kept_seen = 0.0
        self.pending = 0.0  # The share of the last frame that went through the rule, 0 after a kept frame.

    def offer(self, jpeg, grey, at):
        """Take one streamed frame. `grey` is None for a frame that skips the rule."""
        seen = self.clock()
        digest = hashlib.sha256(jpeg).hexdigest()
        with self.lock:
            frame = Frame(at, seen, jpeg, digest, self.pending)
            if grey is not None:
                keep, share = judge(self.base, grey, seen - self.kept_seen)
                frame = frame._replace(share=share)
                self.pending = 0.0 if keep else share
                if keep:
                    self.kept.append(frame)
                    self.base, self.last_at, self.kept_seen = grey, at, seen
            self.newest = frame
            self.trim()
        self.arrived.set()

    def trim(self):
        """Drop the frames older than RING_SECONDS. The deques hold the count limits."""
        now = self.clock()
        for frames in (self.kept, self.shown):
            while frames and now - frames[0].seen > RING_SECONDS:
                frames.popleft()

    def snapshot(self):
        """The kept frames, the newest frame when the ring did not keep it, and the receipt time of the
        last kept frame. Raises ValueError when no frame arrived for STALE_SECONDS."""
        with self.lock:
            newest = self.newest
            if newest is None or self.clock() - newest.seen > STALE_SECONDS:
                raise ValueError("The stream gave no frame in the last seconds.")
            self.trim()
            kept = list(self.kept)
            extra = None if kept and kept[-1] is newest else newest
            if extra is not None and all(one.digest != extra.digest for one in self.shown):
                self.shown.append(extra)  # The file of this frame stays readable while the seat fetches it.
            return kept, extra, self.last_at

    def find(self, digest):
        """The JPEG bytes of a frame in the ring, or None."""
        with self.lock:
            self.trim()
            for frame in (*self.kept, *self.shown, self.newest):
                if frame is not None and frame.digest == digest:
                    return frame.jpeg
        return None


def stream_command(node, resolution, fps=STREAM_FPS):
    """The v4l2-ctl command that writes MJPEG frames to stdout. `--stream-to=-` turns on `--silent`."""
    width, height = resolution.split("x")
    return ["v4l2-ctl", "-d", node, f"--set-fmt-video=width={width},height={height},pixelformat=MJPG",
            f"--set-parm={fps}", "--stream-mmap", "--stream-to=-"]


def start_stream(node, resolution):
    """Start v4l2-ctl. This is the one place that launches it, so a test can replace it."""
    return subprocess.Popen(stream_command(node, resolution), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


class DemoProcess:
    """Stands in for v4l2-ctl in the demo: the same synthetic JPEG at STREAM_FPS."""

    def __init__(self):
        self.stopped = threading.Event()
        self.stdout = self

    def read1(self, _size):
        return b"" if self.stopped.wait(1 / STREAM_FPS) else DEMO_JPEG

    def terminate(self):
        self.stopped.set()

    kill = terminate

    def wait(self, timeout=None):
        return 0

    def close(self):
        pass


class Reader(threading.Thread):
    """Run the stream, split it into frames, and offer them to the ring. A stream that ends starts again."""

    def __init__(self, ring, resolve, launch, decode, pause=RESTART_PAUSE):
        super().__init__(name="stream", daemon=True)
        self.ring = ring
        self.resolve = resolve  # Returns the capture node, or raises ValueError.
        self.launch = launch  # Takes the node and returns a process with a `stdout`.
        self.decode = decode  # Takes a JPEG and returns a grey copy, or None.
        self.pause = pause
        self.stopping = threading.Event()
        self.hold = threading.Lock()  # Guards `process`.
        self.process = None
        self.problem = ""  # The last failure, for the message at start.
        self.checked = float("-inf")

    def run(self):
        while not self.stopping.is_set():
            try:
                self.once()
                self.problem = "The stream ended."
            except Exception as error:  # noqa: BLE001 - A surprise becomes the problem and a restart.
                self.problem = str(error) or type(error).__name__
            self.stopping.wait(self.pause)

    def once(self):
        """One stream, from its start to its end."""
        process = self.launch(self.resolve())
        with self.hold:
            if self.stopping.is_set():
                process.terminate()
            self.process = process
        try:
            splitter = Splitter()
            while chunk := process.stdout.read1(CHUNK):
                for jpeg in splitter.feed(chunk):
                    self.take(jpeg)
        finally:
            self.end(process)

    def take(self, jpeg):
        """Offer one frame. A frame that is due for the rule needs a grey copy.
        A frame that does not decode is skipped. A frame that is not due must start with the
        start marker and end with the end marker, or the reader skips it."""
        at, seen = utc(), self.ring.clock()
        grey = None
        if seen - self.checked >= DETECT_PERIOD:
            grey = self.decode(jpeg)
            if grey is None:
                return
            self.checked = seen
        elif not (jpeg.startswith(b"\xff\xd8\xff") and jpeg.endswith(EOI)):
            return
        self.ring.offer(jpeg, grey, at)

    @staticmethod
    def end(process):
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()

    def stop(self, timeout=10):
        """Stop the stream, and wait for the thread. A thread that stays alive loses its process by kill."""
        self.stopping.set()
        with self.hold:
            if self.process is not None:
                self.process.terminate()
        if self.is_alive():
            self.join(timeout=timeout)
        if self.is_alive():
            with self.hold:
                if self.process is not None:
                    self.process.kill()  # v4l2-ctl must not outlive the server.


class Capture:
    """One capture in flight. Each request that waits for it receives its result."""

    def __init__(self):
        self.done = threading.Event()
        self.observation = None
        self.error = None


def percent(share):
    return f"{share * 100:.1f} %"


def kept_status(frame):
    """The text about a kept frame: the share of pixels that changed since the kept frame before it."""
    if frame.share is None:
        return "Kept: the first frame of the stream."
    return f"Kept: {percent(frame.share)} of the pixels changed since the previous kept frame."


def newest_status(frame, last_at):
    """The text about a newest frame that the ring did not keep. `last_at` is None before the first kept frame."""
    if last_at is None:
        return "Not kept: the ring kept no frame yet."
    if frame.share is not None and frame.share > CHANGED_SHARE:
        return (f"Not kept yet: {percent(frame.share)} of the pixels differ from the kept frame of {last_at}. "
                f"The rule keeps a frame {MIN_GAP:g} s after the last kept frame.")
    return f"Not kept: no change since {last_at}."


class Camera:
    """One USB device, two sensors: `camera` (frames) and `microphone` (clips)."""

    def __init__(self, source, data, device, resolution="1280x720", demo=False, audio_device=None, seconds=5,
                 usb_id=None):
        self.source = source
        self.data = Path(data)
        self.device = device
        self.usb_id = usb_id
        self.resolution = resolution
        self.demo = demo
        self.audio_device = audio_device
        self.seconds = seconds
        self.node = device  # The capture node of the stream. A USB ID resolves at each start of the stream.
        self.ring = Ring()
        self.reader = None
        self.lock = threading.Lock()  # Guards `flights`.
        self.flights = {}  # The capture in flight of each sensor.
        self.writing = threading.Lock()  # One writer at a time for the blobs and the log.
        (self.data / "blobs").mkdir(parents=True, exist_ok=True)

    def sensors(self):
        """The configured sensors, with a description of each."""
        found = {}
        if self.demo or self.device or self.usb_id:
            found["camera"] = ("Synthetic demo camera" if self.demo
                               else "USB camera, JPEG frames that a change rule keeps for two minutes")
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
        """The observations of one request. The camera answers from the ring. A request for a clip that
        arrives while a clip of the same sensor records waits for that clip and receives its observation."""
        if sensor == "camera":
            return self.frames()
        with self.lock:
            flight = self.flights.get(sensor)
            leader = flight is None
            if leader:
                flight = self.flights[sensor] = Capture()
        if leader:
            try:
                flight.observation = self.record()
            except BaseException as error:  # noqa: BLE001  # the waiting threads receive any error
                flight.error = error
            finally:
                with self.lock:
                    del self.flights[sensor]
                flight.done.set()
        else:
            flight.done.wait()
        if flight.error is not None:
            raise flight.error
        return [flight.observation]

    def drain(self):
        """Wait for the captures in flight. The subprocess timeouts bound the wait."""
        with self.lock:
            flights = list(self.flights.values())
        for flight in flights:
            flight.done.wait()

    def find_node(self):
        """The capture node for the next start of the stream. A USB ID resolves again, so a reconnect that
        renumbers the nodes needs no restart."""
        self.node = self.device or capture_node(self.usb_id, VIDEO4LINUX)
        return self.node

    def start(self):
        """Start the stream of the camera sensor."""
        if "camera" not in self.sensors():
            return
        if self.demo:
            self.reader = Reader(self.ring, lambda: "demo", lambda _node: DemoProcess(), lambda _jpeg: DEMO_GREY)
        else:
            self.reader = Reader(self.ring, self.find_node, lambda node: start_stream(node, self.resolution), grey_of)
        self.reader.start()

    def ready(self, timeout=FIRST_FRAME_SECONDS):
        """Wait for the first frame. True when it arrives, and when the server has no camera sensor."""
        return self.reader is None or self.ring.arrived.wait(timeout)

    def stop(self):
        """Stop the stream. v4l2-ctl then releases the device."""
        if self.reader is not None:
            self.reader.stop()

    def frames(self):
        """The kept frames and the newest frame, oldest first. Raises ValueError when the stream is stale."""
        kept, extra, last_at = self.ring.snapshot()
        now = self.ring.clock()
        observations = [self.observation(frame, now, kept_status(frame)) for frame in kept]
        if extra is not None:
            observations.append(self.observation(extra, now, newest_status(extra, last_at)))
        return observations

    def observation(self, frame, now, status):
        """One observation of a frame. The frame is in RAM only, and no file or log line is written."""
        where = f"{self.usb_id} at {self.node}" if self.usb_id else self.node
        label = ("SYNTHETIC DEMO: not a bench measurement." if self.demo
                 else f"USB camera {where}; timestamp is receipt time.")
        text = f"{label} Received {frame.at}, {now - frame.seen:.1f} s ago. {status}"
        return {"at": frame.at, "parts": [{"kind": "text", "text": text},
                                          {"kind": "frame", "file": frame.digest, "mediaType": "image/jpeg"}]}

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


def media_type(data):
    """The content type of a file, from its first bytes: a PNG, a JPEG, or else a WAV clip."""
    if data.startswith(b"\x89PNG"):
        return "image/png"
    return "image/jpeg" if data.startswith(b"\xff\xd8\xff") else "audio/wav"


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
            data = camera.ring.find(digest)  # A camera frame lives in RAM. A clip lives on disk.
            if data is None:
                try:
                    data = (camera.data / "blobs" / digest).read_bytes()
                except FileNotFoundError:
                    return self.error(404, "unknown", "Unknown file.")
            self.send_response(200)
            self.send_header("Content-Type", media_type(data))
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
                observations = camera.observe(sensor)
            except (OSError, ValueError, subprocess.SubprocessError):
                return self.error(503, "unavailable", f"{sensor.capitalize()} capture failed; check the device and its access.")
            self.json(200, {"api": API, "observations": observations})

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


def start_evidence(camera):
    """Start the stream. The server listens only after the first frame and the first clip."""
    camera.start()
    try:
        if not camera.ready():
            problem = camera.reader.problem
            print(f"camera got no frame in {FIRST_FRAME_SECONDS} s. Check the device, v4l2-ctl, and its access."
                  + (f" Last failure: {problem}" if problem else ""), file=sys.stderr)
            sys.exit(1)
        if "microphone" in camera.sensors():
            camera.record()
    except BaseException:
        camera.stop()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", help="Explicit V4L2 capture node, e.g. /dev/video0. Use it on a host with udev or one camera")
    parser.add_argument("--usb-id", help="USB ID of the camera from device-scan, e.g. 046d:085e. The server finds the node at each capture")
    parser.add_argument("--audio-device", help="ALSA PCM of the microphone from arecord -l, e.g. plughw:CARD=BRIO,DEV=0")
    parser.add_argument("--seconds", type=int, default=5, help="Length of each clip, 1 to 30")
    parser.add_argument("--resolution", default="1280x720")
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
    if args.audio_device and not re.fullmatch(AUDIO_DEVICE, args.audio_device):
        parser.error("Invalid audio device.")
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
                    args.usb_id)
    if "camera" in camera.sensors() and not args.demo and importlib.util.find_spec("PIL") is None:
        parser.error("The camera needs Pillow. Install the python3-pil package.")
    start_evidence(camera)
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
        camera.stop()  # v4l2-ctl then releases the device.
        # A handler thread is a daemon. Wait for its clip, so that no arecord keeps the device
        # and no temporary folder stays in the data directory.
        camera.drain()


if __name__ == "__main__":
    main()
