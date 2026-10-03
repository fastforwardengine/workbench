#!/usr/bin/env python3
"""Sensor server for a programmable supply, sensor API v1. Python 3.11+.

    AMBION_SENSOR_REPOSITORY=engineer/bench-psu \\
    AMBION_SENSOR_DATA_DIR=$HOME/sensor-data/bench-psu \\
    python3 -u -B sensor.py [--config psu.json] [--sim FILE] [--port 0]

The sensor only reads the supply. It never writes a setpoint, never turns
an output on, and takes no drive lock. It serves three sensors:

- output: the voltage, the current, and the power of each channel, as series.
  It serves spans from samples.jsonl.
- recent: the statistics of the last minute, and the recent changes.
- settings: the setpoints, the protection limits, and the drive owner.

The lifecycle follows ../usb-camera/camera.py.
"""

import argparse
import datetime as dt
import hashlib
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
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from drivers import Reading, SupplyError, open_driver
from guard import DriveLocks, Guard, load_config, lock_directory, natural

# The constants that an agent can tune.
MIN_PERIOD = 0.25  # the shortest sample period, in seconds
BUS_SHARE = 3  # the period is at least BUS_SHARE times the cost of one measure call
SETTINGS_SECONDS = 1  # the time between two reads of the settings
MEMORY_SECONDS = 60  # the samples and the changes that stay in memory
WINDOWS = (3, 5, 15, 30, 60)  # the windows of `recent`, in seconds
PERCENTILES = (5, 25, 50, 75, 95)
MAX_SPAN_SAMPLES = 14400  # the most samples that one span answers

HERE = Path(__file__).resolve().parent
EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
QUANTITIES = (("voltage", "V"), ("current", "A"), ("power", "W"))
STATISTICS = ("min", "p5", "p25", "p50", "p75", "p95", "max", "mean")
SENSORS = (
    ("output", "Voltage, current, and power of each channel, as series", True),
    ("recent", "Statistics of the last minute, and the recent changes", False),
    ("settings", "Setpoints, protection limits, and the drive owner of each channel", False),
)


def iso(ms):
    """The wire form of a time in integer milliseconds."""
    moment = EPOCH + dt.timedelta(milliseconds=ms)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def parse_iso(text):
    """The integer milliseconds of a wire time."""
    moment = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    return (moment - EPOCH) // dt.timedelta(milliseconds=1)


def wall_clock():
    return time.time_ns() // 1_000_000


class CheckoutError(ValueError):
    """The sensor does not sit in a git checkout that has a commit."""


def launch_source(checkout, repository):
    if not re.fullmatch(r"(?!templates/)[a-z][a-z0-9-]*/[a-z0-9][a-z0-9._-]{0,63}", repository):
        raise ValueError("Set AMBION_SENSOR_REPOSITORY to your fork ID, such as engineer/bench-psu.")

    def git(*args):
        return subprocess.check_output(["git", "-C", str(checkout), *args], text=True, stderr=subprocess.DEVNULL).strip()

    try:
        git("rev-parse", "--is-inside-work-tree")
        git("rev-parse", "--verify", "HEAD")
    except (OSError, subprocess.CalledProcessError) as error:
        raise CheckoutError(
            f"psu needs a git checkout of your fork at {checkout}. "
            "Clone your fork, then start the sensor from the clone (README step 1)."
        ) from error

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
        if not isinstance(value, str) or not ISO.fullmatch(value):
            return False
        try:
            dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
    return span["from"] < span["to"]


def period_ms(description):
    """The sample period: the longest of the minimum, the bus share, and the refresh time."""
    refresh = 1 / description.refresh_hz if description.refresh_hz else 0
    seconds = max(MIN_PERIOD, BUS_SHARE * description.measure_seconds, refresh)
    return math.ceil(round(1000 * seconds, 6))


def decimals_of(step):
    """The decimal places of a step, such as 2 for 0.01."""
    return max(0, round(-math.log10(step))) if step and step > 0 else 3


def percentile(ordered, p):
    """The nearest-rank percentile of a sorted list."""
    rank = -(-p * len(ordered) // 100)
    return ordered[max(rank, 1) - 1]


def window_statistics(values, decimals):
    ordered = sorted(values)
    found = {"n": len(ordered)}
    if not ordered:
        return {**found, **{name: None for name in STATISTICS}}
    found["min"] = ordered[0]
    for p in PERCENTILES:
        found[f"p{p}"] = percentile(ordered, p)
    found["max"] = ordered[-1]
    found["mean"] = round(math.fsum(ordered) / len(ordered), decimals)
    return found


def split_runs(samples):
    """Split samples into runs: each next sample has the same period and is one period later."""
    runs = []
    for sample in samples:
        last = runs[-1][-1] if runs else None
        if last and sample["period_ms"] == last["period_ms"] and sample["at"] == last["at"] + last["period_ms"]:
            runs[-1].append(sample)
        else:
            runs.append([sample])
    return runs


def parse_sample(line, channels):
    """A sample from one line of samples.jsonl, or None for a line that does not fit."""
    try:
        record = json.loads(line)
        sample = {"at": parse_iso(record["at"]), "period_ms": int(record["period_ms"]),
                  "channels": {name: list(values) for name, values in record["channels"].items()}}
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return None
    ok = set(sample["channels"]) == set(channels) and all(len(v) == 3 for v in sample["channels"].values())
    return sample if ok and sample["period_ms"] > 0 else None


def read_lines(path):
    try:
        with open(path) as handle:
            yield from handle
    except FileNotFoundError:
        return


def pid_alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def encode(document):
    return json.dumps(document, sort_keys=True, separators=(",", ":")).encode()


def store_blob(data, digest, content):
    """Write the blob through a temporary file, so a crash leaves no partial blob."""
    blobs = Path(data) / "blobs"
    blobs.mkdir(parents=True, exist_ok=True)
    blob = blobs / digest
    if blob.exists() and blob.read_bytes() == content:
        return
    descriptor, name = tempfile.mkstemp(dir=blobs, prefix=".tmp-")
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, blob)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


class SpanTooLarge(Exception):
    """A span holds more samples than MAX_SPAN_SAMPLES."""


class Sensor:
    def __init__(self, guard, config, data, source, clock=None):
        self.guard = guard
        self.config = config
        self.name = config["name"]
        self.data = Path(data)
        self.source = source
        self.clock = clock or wall_clock
        self.description = guard.describe()
        self.period_ms = period_ms(self.description)
        self.channels = sorted(config["channels"], key=natural)
        self.labels = {name: config["channels"][name].get("label", name) for name in self.channels}
        self.decimals = {}
        for name in self.channels:
            rating = self.description.channels[name]
            volts, amps = decimals_of(rating.voltage_step), decimals_of(rating.current_step)
            self.decimals[name] = (volts, amps, amps)
        self.locks = DriveLocks(lock_directory(), self.name)
        self.lock = threading.Lock()
        self.ring = deque()
        self.changes = deque()
        self.latest = None  # (at_ms, snapshot)
        self.logged = None  # the last snapshot in settings.jsonl
        self.last_error = None  # (at_ms, message)
        self.error_kind = None
        self.settings_second = None
        self.data.mkdir(parents=True, exist_ok=True)
        (self.data / "blobs").mkdir(exist_ok=True)
        self.samples_path = self.data / "samples.jsonl"
        self.settings_path = self.data / "settings.jsonl"
        self.refill()

    # Memory

    def refill(self):
        """Read the memory back from the logs, so a restart keeps the last minute."""
        cutoff = self.clock() - MEMORY_SECONDS * 1000
        for line in read_lines(self.samples_path):
            sample = parse_sample(line, self.channels)
            if sample and sample["at"] > cutoff:
                self.ring.append(sample)
        self.trim()
        previous = None
        for line in read_lines(self.settings_path):
            try:
                record = json.loads(line)
                at, snapshot = parse_iso(record["at"]), record["channels"]
                if not isinstance(snapshot, dict):
                    raise TypeError
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
            if previous is not None and at > cutoff:
                self.changes.extend(self.diff(previous, snapshot, at))
            previous = snapshot
        self.logged = previous

    def trim(self):
        if self.ring:
            edge = self.ring[-1]["at"] - MEMORY_SECONDS * 1000
            while self.ring[0]["at"] <= edge:
                self.ring.popleft()

    def diff(self, before, after, at):
        """One change for each channel and key that differs, except the mode."""
        found = []
        for channel, now in after.items():
            old = before.get(channel)
            if not isinstance(old, dict) or not isinstance(now, dict):
                continue
            for key, value in now.items():
                if key != "mode" and old.get(key) != value:
                    found.append({"at": at, "channel": channel, "key": key, "from": old.get(key),
                                  "to": value, "owner": now.get("owner")})
        return found

    # Reads

    def round_reading(self, channel, reading):
        volts, amps, watts = self.decimals[channel]
        return [round(reading[channel].voltage, volts), round(reading[channel].current, amps),
                round(reading[channel].power, watts)]

    def measure(self, at_ms):
        """Read every channel once, and return the sample. It stores nothing."""
        readings = self.guard.measure()
        return {"at": at_ms, "period_ms": self.period_ms,
                "channels": {name: self.round_reading(name, readings) for name in self.channels}}

    def store(self, sample):
        line = {"at": iso(sample["at"]), "period_ms": sample["period_ms"], "channels": sample["channels"]}
        with self.samples_path.open("a") as output:
            output.write(json.dumps(line, separators=(",", ":")) + "\n")
        with self.lock:
            self.ring.append(sample)
            self.trim()

    def sample(self, at_ms):
        """Read the supply, and record the sample at the slot at_ms."""
        sample = self.measure(at_ms)
        self.store(sample)
        return sample

    def latest_reading(self, channel):
        with self.lock:
            sample = self.ring[-1] if self.ring else None
        return Reading(*sample["channels"][channel]) if sample else None

    def owner(self, channel):
        info = self.locks.holder(channel)
        if not isinstance(info, dict) or not pid_alive(info.get("pid")):
            return None
        return {"actuator": info.get("actuator"), "pid": info.get("pid"), "started": info.get("started")}

    def snapshot_channel(self, channel, setting):
        reading = self.latest_reading(channel)
        mode = setting.mode if reading is None else self.guard.mode(setting, reading)
        volts, amps, _ = self.decimals[channel]

        def rounded(value, places):
            return None if value is None else round(value, places)

        return {"label": self.labels[channel], "output": "on" if setting.on else "off", "mode": mode,
                "voltage": rounded(setting.voltage, volts), "current": rounded(setting.current, amps),
                "ovp": rounded(setting.ovp, volts), "ocp": rounded(setting.ocp, amps),
                "tripped": list(setting.tripped), "owner": self.owner(channel)}

    def observe_settings(self, at_ms):
        """Read the settings, keep the snapshot, and log it when a key other than the mode changed."""
        settings = self.guard.settings()
        snapshot = {name: self.snapshot_channel(name, settings[name]) for name in self.channels}
        changes = [] if self.logged is None else self.diff(self.logged, snapshot, at_ms)
        first = self.logged is None
        if first or changes:
            with self.settings_path.open("a") as output:
                output.write(json.dumps({"at": iso(at_ms), "channels": snapshot}, separators=(",", ":")) + "\n")
        with self.lock:
            self.latest = (at_ms, snapshot)
            self.settings_second = at_ms // 1000
            if first or changes:
                self.logged = snapshot
            self.changes.extend(changes)
            while self.changes and self.changes[0]["at"] <= at_ms - MEMORY_SECONDS * 1000:
                self.changes.popleft()

    # The sampler

    def fail(self, kind, at_ms, error):
        with self.lock:
            self.last_error = (at_ms, str(error) or type(error).__name__)
            self.error_kind = kind

    def clear(self, kind):
        with self.lock:
            if self.error_kind == kind:
                self.last_error = self.error_kind = None

    def tick(self, slot):
        """One slot: a sample, and the settings in the first slot of each new second."""
        try:
            sample = self.measure(slot)
            self.clear("sample")
            # A reading that ends after its slot means that a controller held the bus.
            # The sensor drops it, and the gap shows in n.
            if self.clock() < slot + self.period_ms:
                self.store(sample)
        except Exception as error:
            self.fail("sample", slot, error)
        if self.settings_second is None or slot // 1000 >= self.settings_second + SETTINGS_SECONDS:
            try:
                self.observe_settings(slot)
                self.clear("settings")
            except Exception as error:
                self.fail("settings", slot, error)

    def next_slot(self, slot=None):
        """The slot after `slot`, or the slot that runs now when the last tick overran.

        A reading may start late in its slot: the settings read takes the bus
        after the sample of the same slot. The reading counts when it ends
        before the end of its slot.
        """
        current = self.clock() // self.period_ms * self.period_ms
        if slot is None:
            return current + self.period_ms
        return max(slot + self.period_ms, current)

    def run(self, stop_event):
        slot = self.next_slot()
        while True:
            if stop_event.wait(max(0, (slot - self.clock()) / 1000)):
                return
            self.tick(slot)
            slot = self.next_slot(slot)

    # The sensors

    def output_observations(self, samples):
        found = []
        for run in split_runs(samples):
            parts = []
            for channel in self.channels:
                for index, (quantity, unit) in enumerate(QUANTITIES):
                    parts.append({"kind": "series", "channel": f"{channel}/{quantity}", "unit": unit,
                                  "from": iso(run[0]["at"]), "intervalMs": run[0]["period_ms"],
                                  "values": [sample["channels"][channel][index] for sample in run]})
            found.append({"at": iso(run[-1]["at"]), "parts": parts})
        return found

    def output_latest(self):
        with self.lock:
            samples = list(self.ring)
        return self.output_observations(samples)

    def output_span(self, start, end):
        kept, count = [], 0
        for line in read_lines(self.samples_path):
            sample = parse_sample(line, self.channels)
            if sample and start <= sample["at"] < end:
                count += 1
                if count <= MAX_SPAN_SAMPLES:
                    kept.append(sample)
        if count > MAX_SPAN_SAMPLES:
            raise SpanTooLarge(f"The span holds {count} samples, and the limit is {MAX_SPAN_SAMPLES}. "
                               "Ask for a shorter span.")
        return self.output_observations(kept)

    def recent_document(self):
        """The statistics of the last minute, or None when there is no sample."""
        with self.lock:
            samples, changes = list(self.ring), list(self.changes)
            error = self.last_error
        if not samples:
            return None
        end = samples[-1]["at"]
        channels = {}
        for channel in self.channels:
            entry = {"label": self.labels[channel]}
            for index, (quantity, unit) in enumerate(QUANTITIES):
                windows = {}
                for seconds in WINDOWS:
                    values = [s["channels"][channel][index] for s in samples if s["at"] > end - seconds * 1000]
                    windows[str(seconds)] = {**window_statistics(values, self.decimals[channel][index]),
                                             "expected": seconds * 1000 // self.period_ms}
                entry[quantity] = {"unit": unit, "windows": windows}
            channels[channel] = entry
        recent = [c for c in changes if c["at"] > end - MEMORY_SECONDS * 1000]
        listed = [{"at": iso(c["at"]), "age_seconds": max(0, end - c["at"]) / 1000, "channel": c["channel"],
                   "key": c["key"], "from": c["from"], "to": c["to"], "owner": c["owner"]}
                  for c in reversed(recent)]
        return {"at": iso(end), "period_ms": self.period_ms, "channels": channels, "changes": listed,
                "error": None if error is None else {"at": iso(error[0]), "message": error[1]}}

    def recent_bytes(self):
        document = self.recent_document()
        return None if document is None else encode(document)

    def format_value(self, channel, key, value):
        volts, amps, _ = self.decimals[channel]
        if key == "owner":
            return owner_text(value)
        if key == "tripped":
            return ", ".join(value) if value else "none"
        if isinstance(value, float) or (isinstance(value, int) and key in ("voltage", "current", "ovp", "ocp")):
            return f"{value:.{volts if key in ('voltage', 'ovp') else amps}f}"
        return "none" if value is None else str(value)

    def table(self, channel, entry):
        header = ["quantity", "window", "n/exp", *STATISTICS]
        rows = [header]
        for index, (quantity, unit) in enumerate(QUANTITIES):
            places = self.decimals[channel][index]
            for seconds in WINDOWS:
                stats = entry[quantity]["windows"][str(seconds)]
                cells = ["-" if stats[name] is None else f"{stats[name]:.{places}f}" for name in STATISTICS]
                rows.append([f"{quantity} {unit}", f"{seconds} s", f"{stats['n']}/{stats['expected']}", *cells])
        widths = [max(len(row[column]) for row in rows) for column in range(len(header))]
        return ["  ".join(cell.ljust(widths[i]) if i < 2 else cell.rjust(widths[i]) for i, cell in enumerate(row))
                for row in rows]

    def recent_text(self, document):
        lines = [f"Supply {self.name}, latest sample {document['at']}, period {document['period_ms']} ms."]
        for channel in self.channels:
            lines += ["", f"{channel} ({self.labels[channel]})", *self.table(channel, document["channels"][channel])]
        lines += ["", f"Changes in the last {MEMORY_SECONDS} s:"]
        for change in document["changes"]:
            channel, key = change["channel"], change["key"]
            lines.append(f"{change['age_seconds']:.2f} s ago, {channel} {key}: "
                         f"{self.format_value(channel, key, change['from'])} to "
                         f"{self.format_value(channel, key, change['to'])}. "
                         f"Driven by: {owner_text(change['owner'])}.")
        if not document["changes"]:
            lines.append("none")
        if document["error"]:
            lines += ["", f"The last read failed at {document['error']['at']}: {document['error']['message']}."]
        return "\n".join(lines)

    def recent_latest(self):
        document = self.recent_document()
        if document is None:
            return []
        content = encode(document)
        digest = hashlib.sha256(content).hexdigest()
        store_blob(self.data, digest, content)
        return [{"at": document["at"], "parts": [
            {"kind": "text", "text": self.recent_text(document)},
            {"kind": "file", "file": digest, "name": "recent.json", "mediaType": "application/json"}]}]

    def channel_line(self, channel, snapshot):
        text = f"{channel} ({snapshot['label']}): output {snapshot['output']}"
        if snapshot["mode"]:
            text += f", {snapshot['mode'].upper()}"
        volts = self.format_value(channel, "voltage", snapshot["voltage"])
        amps = self.format_value(channel, "current", snapshot["current"])
        text += f". Setpoints {volts} V, {amps} A."
        limits = []
        if snapshot["ovp"] is not None:
            limits.append(f"OVP {self.format_value(channel, 'ovp', snapshot['ovp'])} V")
        if snapshot["ocp"] is not None:
            limits.append(f"OCP {self.format_value(channel, 'ocp', snapshot['ocp'])} A")
        if limits:
            text += f" {', '.join(limits)}."
        tripped = self.format_value(channel, "tripped", snapshot["tripped"])
        return f"{text} Tripped: {tripped}. Driven by: {owner_text(snapshot['owner'])}."

    def settings_latest(self):
        with self.lock:
            latest, error = self.latest, self.last_error
        if latest is None:
            return []
        at, snapshot = latest
        lines = [f"Supply {self.name}, {self.description.model}, snapshot at {iso(at)}."]
        lines += [self.channel_line(channel, snapshot[channel]) for channel in self.channels]
        if error:
            lines.append(f"The last read failed at {iso(error[0])}: {error[1]}.")
        return [{"at": iso(at), "parts": [{"kind": "text", "text": "\n".join(lines)}]}]

    def observe(self, name, span=None):
        """The observations of a sensor. A span exists for output only."""
        if span is None:
            return {"output": self.output_latest, "recent": self.recent_latest,
                    "settings": self.settings_latest}[name]()
        return self.output_span(parse_iso(span["from"]), parse_iso(span["to"]))


def owner_text(owner):
    if not owner:
        return "nobody"
    return f"{owner['actuator']} (pid {owner['pid']}, since {owner['started']})"


def open_server(sensor, port=0, timeout=10):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, status, data, kind="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def json(self, status, body):
            self.send(status, json.dumps(body).encode())

        def error(self, status, code, message):
            self.json(status, {"api": 1, "code": code, "message": message})

        def do_GET(self):
            if self.path == "/":
                return self.json(200, {"api": 1, "source": sensor.source, "sensors": [
                    {"name": name, "description": description, "spans": spans}
                    for name, description, spans in SENSORS]})
            if re.fullmatch(r"/files/[a-f0-9]{64}", self.path):
                try:
                    data = (sensor.data / "blobs" / self.path[7:]).read_bytes()
                except FileNotFoundError:
                    return self.error(404, "unknown", "Unknown file.")
                return self.send(200, data)
            self.error(404, "unknown", "Unknown path.")

        def do_POST(self):
            match = re.fullmatch(r"/([a-z]+)/observe", self.path)
            if not match or match[1] not in [name for name, _, _ in SENSORS]:
                return self.error(404, "unknown", "Unknown sensor.")
            name = match[1]
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("Invalid body length.")
                body = json.loads(self.rfile.read(length))
                if not valid_request(body):
                    raise ValueError("Invalid request.")
            except (ValueError, OSError):
                return self.error(400, "invalid", "Invalid observation request.")
            if "span" in body and name != "output":
                return self.error(422, "unavailable", f"The sensor {name} has no history. Use output for a span.")
            try:
                observations = sensor.observe(name, body.get("span"))
            except SpanTooLarge as error:
                return self.error(422, "unavailable", str(error))
            except OSError:
                return self.error(503, "unavailable", "The sensor cannot read its data directory.")
            self.json(200, {"api": 1, "observations": observations})

    # StreamRequestHandler applies this timeout to the socket before it reads the headers.
    Handler.timeout = timeout
    # Single request at a time. The sampler is the only other thread.
    return HTTPServer(("127.0.0.1", port), Handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=str(HERE / "psu.json"), help="the file of the supply and its limits")
    parser.add_argument("--sim", metavar="FILE", help="use the simulated supply, with its state in FILE")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)
    data = Path(os.environ.get("AMBION_SENSOR_DATA_DIR", "")).expanduser()
    if not data.is_absolute() or data.resolve().is_relative_to(HERE):
        parser.error("Set AMBION_SENSOR_DATA_DIR to an absolute directory outside the checkout.")
    guard = None
    try:
        try:
            source = launch_source(HERE, os.environ.get("AMBION_SENSOR_REPOSITORY", ""))
        except CheckoutError as error:
            print(error, file=sys.stderr)
            return 2
        except ValueError as error:
            parser.error(str(error))
        config = load_config(args.config)
        guard = Guard(open_driver(config, args.sim), config, actuator="sensor.py")
        sensor = Sensor(guard, config, data, source)
        now = sensor.clock() // sensor.period_ms * sensor.period_ms
        sensor.sample(now)  # No READY before a usable read.
        sensor.observe_settings(now)
    except (SupplyError, OSError, subprocess.SubprocessError) as error:
        print(f"The sensor cannot start: {error}", file=sys.stderr)
        if guard:
            guard.close()
        return 1
    server = open_server(sensor, args.port)
    stop = threading.Event()
    sampler = threading.Thread(target=sensor.run, args=(stop,), daemon=True)

    def interrupt(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    sampler.start()
    print("READY " + json.dumps({"port": server.server_port, "source": source}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        sampler.join(timeout=5)
        server.server_close()
        guard.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
