"""The sensor: period, statistics, runs, memory, settings, spans, the sampler, and the process."""

import hashlib
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from unittest import mock

import sensor as sensor_module
from drivers import ChannelRating, Description
from drivers.hm310p import Hm310p
from guard import DriveLocks, Guard, lock_directory
from sensor import Sensor, iso, open_server, period_ms

from .fake_hm310p import FakeBus
from .support import CONFIG_ONE, CONFIG_TWO, Isolated

ROOT = Path(__file__).resolve().parent.parent
T0 = 1767225600000  # 2026-01-01T00:00:00.000Z
SOURCE = {"repository": "engineer/bench-psu", "commit": "a" * 40, "dirty": False}


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now


class Stop:
    """A stop event that advances the clock by the time of each wait, and stops after a count."""

    def __init__(self, clock, waits):
        self.clock, self.waits = clock, waits

    def wait(self, timeout):
        if self.waits == 0:
            return True
        self.waits -= 1
        self.clock.now += round(timeout * 1000)
        return False


class Wrapped:
    """A guard that can fail, or advance the clock, in measure()."""

    def __init__(self, guard, clock):
        self.guard, self.clock = guard, clock
        self.fail = None
        self.delay = []  # the time that each read takes, in milliseconds
        self.settings_delay = 0

    def describe(self):
        return self.guard.describe()

    def measure(self):
        if self.fail:
            raise RuntimeError(self.fail)
        self.clock.now += self.delay.pop(0) if self.delay else 0
        return self.guard.measure()

    def settings(self):
        self.clock.now += self.settings_delay
        return self.guard.settings()

    def mode(self, setting, reading):
        return self.guard.mode(setting, reading)


def description(measure_seconds, refresh_hz=None):
    rating = ChannelRating(30.0, 10.0, 0.01, 0.001)
    return Description("test", {"ch1": rating}, frozenset(), measure_seconds, refresh_hz)


class Sensed(Isolated):
    def make(self, config=CONFIG_TWO, guard=None, clock=None):
        self.clock = clock or Clock()
        self.guard = Guard(self.sim(), config, actuator="sensor.py")
        return Sensor(guard or self.guard, config, self.directory / "data", SOURCE, self.clock)

    def put(self, sensor, k, volts, period=250):
        """Store a synthetic sample at slot k, without a read of the supply."""
        sensor.store({"at": T0 + k * period, "period_ms": period,
                      "channels": {"ch1": [volts, 0.0, 0.0], "ch2": [0.0, 0.0, 0.0]}})

    def serve(self, sensor):
        server = open_server(sensor)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join()))
        return server.server_port

    def call(self, port, path, method="GET"):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request(method, path)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, data


class Period(Sensed):
    def test_the_period_follows_the_cost_of_a_read(self):
        self.assertEqual(period_ms(description(0.075)), 250)  # the HM310P
        self.assertEqual(period_ms(description(0.0)), 250)  # the simulator
        self.assertEqual(period_ms(description(0.2)), 600)  # three reads share the bus
        self.assertEqual(period_ms(description(0.075, refresh_hz=2)), 500)  # a slow display
        self.assertEqual(period_ms(description(0.075, refresh_hz=100)), 250)

    def test_the_decimals_follow_the_rating_of_each_channel(self):
        self.assertEqual(self.make().decimals["ch1"], (3, 3, 3))
        guard = Guard(Hm310p(FakeBus()), CONFIG_ONE, actuator="sensor.py")
        sensor = Sensor(guard, CONFIG_ONE, self.directory / "hm", SOURCE, Clock())
        self.assertEqual(sensor.decimals["ch1"], (2, 3, 3))
        self.assertEqual(sensor.period_ms, 250)


class Statistics(Sensed):
    def test_percentiles_and_counts_with_a_gap(self):
        sensor = self.make()
        for k in range(15):
            if k != 5:
                self.put(sensor, k, float(k))
        windows = sensor.recent_document()["channels"]["ch1"]["voltage"]["windows"]
        self.assertEqual(windows["3"], {
            "n": 11, "expected": 12, "min": 3.0, "p5": 3.0, "p25": 6.0, "p50": 9.0, "p75": 12.0,
            "p95": 14.0, "max": 14.0, "mean": 8.818})
        self.assertEqual((windows["5"]["n"], windows["5"]["expected"]), (14, 20))
        self.assertEqual((windows["60"]["n"], windows["60"]["expected"]), (14, 240))

    def test_a_window_without_samples_has_null_statistics(self):
        sensor = self.make()
        self.assertIsNone(sensor.recent_document())
        self.assertEqual(sensor.recent_latest(), [])
        empty = sensor_module.window_statistics([], 3)
        self.assertEqual(empty, {"n": 0, **{name: None for name in sensor_module.STATISTICS}})
        self.put(sensor, 0, 1.0)
        self.put(sensor, 100, 2.0)  # 25 s later: the 3 s window holds one sample
        windows = sensor.recent_document()["channels"]["ch1"]["voltage"]["windows"]
        self.assertEqual((windows["3"]["n"], windows["3"]["p5"], windows["3"]["p95"]), (1, 2.0, 2.0))
        self.assertEqual((windows["15"]["n"], windows["30"]["n"]), (1, 2))
        self.assertEqual(windows["60"]["n"], 2)

    def test_the_memory_keeps_the_last_minute_by_the_latest_sample(self):
        sensor = self.make()
        for k in (0, 1, 240, 241):
            self.put(sensor, k, 1.0)
        self.assertEqual([s["at"] - T0 for s in sensor.ring], [60000, 60250])


class Runs(Sensed):
    def test_a_gap_and_a_period_change_split_the_runs(self):
        sensor = self.make()
        for k in (0, 1, 2, 4, 5):
            self.put(sensor, k, float(k))
        for k in (3, 4):
            self.put(sensor, k, 7.0, period=500)  # at 1500 and 2000
        found = sensor.output_latest()
        self.assertEqual([o["at"] for o in found], [iso(T0 + 500), iso(T0 + 1250), iso(T0 + 2000)])
        first = found[0]["parts"]
        self.assertEqual([p["channel"] for p in first], [f"{c}/{q}" for c in ("ch1", "ch2") for q in ("voltage", "current", "power")])
        self.assertEqual([p["unit"] for p in first[:3]], ["V", "A", "W"])
        self.assertEqual(first[0]["values"], [0.0, 1.0, 2.0])
        self.assertEqual(found[1]["parts"][0]["from"], iso(T0 + 1000))
        self.assertEqual(found[2]["parts"][0]["intervalMs"], 500)
        self.assertEqual(found[2]["parts"][0]["from"], iso(T0 + 1500))

    def test_an_empty_ring_gives_no_observation(self):
        sensor = self.make()
        self.assertEqual(sensor.observe("output"), [])
        self.assertEqual(sensor.observe("settings"), [])


class Restart(Sensed):
    def test_the_memory_returns_from_both_logs(self):
        first = self.make()
        self.clock.now = T0 - 100000
        for at in (T0 - 60000, T0 - 59750, T0):
            first.sample(at)
        first.observe_settings(T0 - 100000)
        for volts, at in ((1.0, T0 - 90000), (2.0, T0 - 10000)):
            self.guard.set("ch1", voltage=volts)
            first.observe_settings(at)
        with (self.directory / "data" / "samples.jsonl").open("a") as output:
            output.write('{"at": "2026-01-01T00:0')  # a crash cut the last line
        second = self.make(clock=Clock(T0))
        self.assertEqual([s["at"] for s in second.ring], [T0 - 59750, T0])
        self.assertEqual([(c["at"], c["channel"], c["key"], c["from"], c["to"]) for c in second.changes],
                         [(T0 - 10000, "ch1", "voltage", 1.0, 2.0)])
        self.assertIsNone(second.latest)
        lines = (self.directory / "data" / "settings.jsonl").read_text().splitlines()
        second.observe_settings(T0 + 250)  # the same settings: no new record
        self.assertEqual((self.directory / "data" / "settings.jsonl").read_text().splitlines(), lines)
        self.assertEqual(second.latest[0], T0 + 250)


class Settings(Sensed):
    def test_a_change_joins_the_memory_and_ages_out(self):
        sensor = self.make()
        sensor.sample(T0)
        sensor.observe_settings(T0)
        self.assertEqual(len(sensor.changes), 0)
        sensor.observe_settings(T0 + 1000)
        self.assertEqual((self.directory / "data" / "settings.jsonl").read_text().count("\n"), 1)
        self.guard.set("ch1", voltage=4.0, current=0.2)
        sensor.observe_settings(T0 + 2000)
        self.guard.output("ch1", True)
        sensor.sample(T0 + 3000)
        sensor.observe_settings(T0 + 3000)
        changes = [(c["at"] - T0, c["key"], c["from"], c["to"], c["owner"]) for c in sensor.changes]
        self.assertEqual(changes, [(2000, "voltage", 0.0, 4.0, None), (2000, "current", 0.0, 0.2, None),
                                   (3000, "output", "off", "on", None)])
        self.assertEqual(sensor.latest[1]["ch1"]["mode"], "cv")
        document = sensor.recent_document()
        self.assertEqual([c["age_seconds"] for c in document["changes"]], [0.0, 1.0, 1.0])
        self.assertIn("Changes in the last 60 s:\n0.00 s ago, ch1 output: off to on. Driven by: nobody.", sensor.recent_text(document))
        self.guard.set("ch1", voltage=3.0)
        sensor.observe_settings(T0 + 64000)
        self.assertEqual([c["at"] - T0 for c in sensor.changes], [64000])

    def test_the_drive_owner_comes_from_a_held_lock(self):
        sensor = self.make()
        sensor.sample(T0)
        locks = DriveLocks(lock_directory(), "psu")
        locks.acquire(["ch1"], "ramp")
        self.addCleanup(locks.release)
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        (self.locks / "psu.ch2.drive").write_text(json.dumps({"actuator": "old", "pid": dead.pid, "started": "x"}) + "\n")
        sensor.observe_settings(T0)
        owners = {name: channel["owner"] for name, channel in sensor.latest[1].items()}
        self.assertEqual(owners["ch1"], {"actuator": "ramp", "pid": os.getpid(), "started": locks.holder("ch1")["started"]})
        self.assertIsNone(owners["ch2"])
        text = sensor.settings_latest()[0]["parts"][0]["text"]
        self.assertIn(f"Driven by: ramp (pid {os.getpid()}, since {owners['ch1']['started']}).", text)
        self.assertIn("ch2 (led): output off. Setpoints 0.000 V, 0.000 A. OVP 33.000 V, OCP 10.500 A. Tripped: none. Driven by: nobody.", text)
        self.assertTrue(text.startswith("Supply psu, Simulated supply, 2 channels, snapshot at 2026-01-01T00:00:00.000Z.\n"))


def query(start, end):
    """The query string of a span, from `start` in milliseconds to `end` in milliseconds."""
    return f"from={iso(start)}&to={iso(end)}"


class Spans(Sensed):
    def test_a_span_that_holds_too_many_samples_gets_422(self):
        sensor = self.make()
        for k in range(5):
            self.put(sensor, k, float(k))
        port = self.serve(sensor)
        with mock.patch.object(sensor_module, "MAX_SPAN_SAMPLES", 4):
            status, data = self.call(port, f"/output/observe?{query(T0, T0 + 10000)}")
        error = json.loads(data)
        self.assertEqual((status, error["code"], error["api"]), (422, "unavailable", 2))
        self.assertIn("5 samples", error["message"])
        self.assertIn("limit is 4", error["message"])
        status, data = self.call(port, f"/output/observe?{query(T0 + 250, T0 + 750)}")
        self.assertEqual(status, 200)
        body = json.loads(data)
        self.assertEqual(body["api"], 2)
        self.assertEqual(body["observations"][0]["parts"][0]["values"], [1.0, 2.0])

    def test_recent_and_settings_have_no_history(self):
        port = self.serve(self.make())
        for name in ("recent", "settings"):
            status, data = self.call(port, f"/{name}/observe?{query(T0, T0 + 1000)}")
            self.assertEqual((status, json.loads(data)["code"]), (422, "unavailable"))
        status, data = self.call(port, "/")
        index = json.loads(data)
        self.assertEqual(index["api"], 2)
        self.assertEqual([(s["name"], s["spans"]) for s in index["sensors"]],
                         [("output", True), ("recent", False), ("settings", False)])

    def test_a_bad_query_gets_400(self):
        port = self.serve(self.make())
        first, second = iso(T0), iso(T0 + 1000)
        for bad in [f"from={second}&to={first}", f"from={first}&to={first}", f"from={first}", f"to={second}",
                    "from=x&to=y", "from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:01Z",
                    "from=2026-02-30T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
                    f"from={first}&to={second}&limit=1", f"from={first}&from={first}&to={second}", "from&to", "x=1"]:
            status, data = self.call(port, "/output/observe?" + bad)
            error = json.loads(data)
            self.assertEqual((status, error["code"], error["api"]), (400, "invalid", 2), bad)
            self.assertIsInstance(error["message"], str)

    def test_unknown_paths_get_404_as_json(self):
        port = self.serve(self.make())
        for path, method in [("/other/observe", "GET"), ("/missing", "GET"), ("/output", "GET"),
                             ("/files/" + "0" * 64, "GET"), ("/files/../sensor.py", "GET"),
                             ("/output/observe", "POST"), ("/", "DELETE")]:
            status, data = self.call(port, path, method)
            error = json.loads(data)
            self.assertEqual((status, error["code"], error["api"]), (404, "unknown", 2), f"{method} {path}")

    def test_the_recent_file_is_a_blob_with_its_digest(self):
        sensor = self.make()
        self.put(sensor, 0, 1.0)
        port = self.serve(sensor)
        status, data = self.call(port, "/recent/observe")
        body = json.loads(data)
        self.assertEqual((status, body["api"]), (200, 2))
        parts = body["observations"][0]["parts"]
        self.assertEqual([p["kind"] for p in parts], ["text", "file"])
        status, content = self.call(port, f"/files/{parts[1]['file']}")
        self.assertEqual((status, hashlib.sha256(content).hexdigest()), (200, parts[1]["file"]))
        self.assertEqual(json.loads(content)["period_ms"], 250)


class Sampler(Sensed):
    def test_a_late_reading_is_dropped(self):
        clock = Clock(T0 + 10)
        sensor = self.make(clock=clock)
        wrapped = Wrapped(self.guard, clock)
        sensor.guard = wrapped
        wrapped.delay = [0, 300]  # the second read ends past the end of its slot
        sensor.run(Stop(clock, 3))
        # The slot at 500 is dropped. The slot at 750 has started, and its read ends in time.
        self.assertEqual([s["at"] - T0 for s in sensor.ring], [250, 750])
        self.assertEqual(sensor.latest[0], T0 + 250)
        self.assertEqual((self.directory / "data" / "samples.jsonl").read_text().count("\n"), 2)

    def test_a_slow_settings_read_loses_no_slot(self):
        # The HM310P takes 75 ms for measure and about 225 ms for settings. 300 ms adds a margin.
        clock = Clock(T0 + 10)
        sensor = self.make(clock=clock)
        wrapped = Wrapped(self.guard, clock)
        sensor.guard = wrapped
        wrapped.delay = [75] * 100
        wrapped.settings_delay = 300
        sensor.run(Stop(clock, 40))
        slots = [s["at"] - T0 for s in sensor.ring]
        self.assertEqual(slots, list(range(250, 250 * (len(slots) + 1), 250)))
        self.assertGreaterEqual(len(slots), 36)

    def test_a_failed_read_sets_and_clears_the_error(self):
        clock = Clock()
        sensor = self.make(clock=clock)
        wrapped = Wrapped(self.guard, clock)
        sensor.guard = wrapped
        wrapped.fail = "the bus timed out"
        sensor.tick(T0)
        self.assertEqual(sensor.last_error, (T0, "the bus timed out"))
        self.assertEqual(len(sensor.ring), 0)
        self.assertIsNotNone(sensor.latest)  # the settings read still works
        text = sensor.settings_latest()[0]["parts"][0]["text"]
        self.assertTrue(text.endswith(f"The last read failed at {iso(T0)}: the bus timed out."))
        wrapped.fail = None
        sensor.tick(T0 + 250)
        self.assertIsNone(sensor.last_error)
        self.assertEqual(len(sensor.ring), 1)

    def test_the_error_shows_in_the_recent_document(self):
        sensor = self.make()
        self.put(sensor, 0, 1.0)
        sensor.fail("sample", T0 + 250, RuntimeError("boom"))
        document = sensor.recent_document()
        self.assertEqual(document["error"], {"at": iso(T0 + 250), "message": "boom"})
        self.assertIn(f"The last read failed at {iso(T0 + 250)}: boom.", sensor.recent_text(document))


def free_port():
    """A port that no process holds now."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Process(Isolated):
    def run_sensor(self, data, *args, port=None, **env):
        """Start sensor.py as bash does: with PORT set, and with no READY line to wait for."""
        config = self.directory / "psu.json"
        config.write_text(json.dumps(CONFIG_TWO))
        port = free_port() if port is None else port
        variables = {**os.environ, "AMBION_SENSOR_REPOSITORY": "engineer/bench-psu",
                     "AMBION_SENSOR_DATA_DIR": str(data), "PORT": str(port), **env}
        command = [sys.executable, "-u", "-B", "sensor.py", "--config", str(config), "--sim", str(self.state), *args]
        process = subprocess.Popen(command, cwd=ROOT, env=variables, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process.port = port
        return process

    def get(self, process, path):
        """Poll until the server answers, as a reader of the process does."""
        for _ in range(600):
            if process.poll() is not None:
                self.fail(f"sensor.py exited with {process.returncode}: {process.stderr.read()}")
            try:
                connection = http.client.HTTPConnection("127.0.0.1", process.port, timeout=5)
                connection.request("GET", path)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            except OSError:
                threading.Event().wait(0.05)
            finally:
                connection.close()
        self.fail("sensor.py did not listen.")

    def test_main_listens_on_port_prints_nothing_and_serves(self):
        process = self.run_sensor(self.directory / "data")
        timer = threading.Timer(30, process.kill)
        timer.start()
        try:
            status, body = self.get(process, "/")
            self.assertEqual(status, 200)
            self.assertEqual(body["api"], 2)
            self.assertEqual(body["source"]["repository"], "engineer/bench-psu")
            self.assertEqual([s["name"] for s in body["sensors"]], ["output", "recent", "settings"])
            status, body = self.get(process, "/output/observe")
            self.assertEqual((status, body["api"]), (200, 2))
            self.assertEqual(len(body["observations"]), 1)
        finally:
            process.terminate()
            process.wait(timeout=10)
            timer.cancel()
            self.assertEqual(process.stdout.read(), "")
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(process.returncode, 0)

    def test_main_stops_when_the_port_is_in_use(self):
        with socket.socket() as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen()
            process = self.run_sensor(self.directory / "data", port=holder.getsockname()[1])
            out, error = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(out, "")
        self.assertIn("The sensor cannot listen on port", error)
        self.assertEqual(len(error.splitlines()), 1)

    def test_main_stops_when_the_port_is_missing_or_bad(self):
        config = self.directory / "psu.json"
        config.write_text(json.dumps(CONFIG_TWO))
        for value in (None, "", "0", "65536", "http", "-1"):
            env = {key: item for key, item in os.environ.items() if key != "PORT"}
            env.update({"AMBION_SENSOR_REPOSITORY": "engineer/bench-psu",
                        "AMBION_SENSOR_DATA_DIR": str(self.directory / "data")})
            if value is not None:
                env["PORT"] = value
            done = subprocess.run([sys.executable, "-B", "sensor.py", "--config", str(config), "--sim", str(self.state)],
                                  cwd=ROOT, env=env, capture_output=True, text=True, timeout=30, check=False)
            self.assertEqual(done.returncode, 2, value)
            self.assertEqual(done.stdout, "")
            self.assertIn("Set PORT to an integer from 1 to 65535", done.stderr)
        self.assertFalse((self.directory / "data").exists())

    def test_main_refuses_a_data_directory_inside_the_checkout(self):
        process = self.run_sensor(ROOT / "sensor-data-refused")
        _, error = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 2)
        self.assertIn("outside the checkout", error)
        self.assertFalse((ROOT / "sensor-data-refused").exists())

    def run_copy(self, **changes):
        with tempfile.TemporaryDirectory() as folder:
            copy = Path(folder) / "bench-psu"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns("tests", "__pycache__"))
            env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            env.update({"AMBION_SENSOR_REPOSITORY": "engineer/bench-psu", "GIT_CEILING_DIRECTORIES": folder,
                        "AMBION_SENSOR_DATA_DIR": str(self.directory / "data"), "PORT": str(free_port()), **changes})
            done = subprocess.run([sys.executable, "-B", "sensor.py", "--sim", str(self.state)], cwd=copy, env=env,
                                  capture_output=True, text=True, timeout=30, check=False)
        return done, copy.resolve()

    def test_main_stops_outside_a_git_checkout(self):
        done, copy = self.run_copy()
        self.assertEqual(done.returncode, 2)
        self.assertEqual(done.stdout, "")
        self.assertTrue(done.stderr.startswith(
            f"psu needs a git checkout of your fork at {copy}. "
            "Clone your fork, then start the sensor from the clone (README, sensor step 1)."), done.stderr)
        self.assertEqual(len(done.stderr.splitlines()), 1)

    def test_main_stops_when_git_is_missing(self):
        with tempfile.TemporaryDirectory() as empty:
            done, copy = self.run_copy(PATH=empty)
        self.assertEqual(done.returncode, 2)
        self.assertEqual(done.stderr, f"psu needs git on PATH to read the commit of your fork at {copy}.\n")
