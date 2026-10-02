"""The sensor: period, statistics, runs, memory, settings, spans, the sampler, and the process."""

import hashlib
import http.client
import json
import os
import subprocess
import sys
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
SOURCE = {"repository": "instruments/bench-psu", "commit": "a" * 40, "dirty": False}


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

    def describe(self):
        return self.guard.describe()

    def measure(self):
        if self.fail:
            raise RuntimeError(self.fail)
        self.clock.now += self.delay.pop(0) if self.delay else 0
        return self.guard.measure()

    def settings(self):
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

    def call(self, port, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request(method, path, None if body is None else json.dumps(body))
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


class Spans(Sensed):
    def test_a_span_that_holds_too_many_samples_gets_422(self):
        sensor = self.make()
        for k in range(5):
            self.put(sensor, k, float(k))
        port = self.serve(sensor)
        span = {"from": iso(T0), "to": iso(T0 + 10000)}
        with mock.patch.object(sensor_module, "MAX_SPAN_SAMPLES", 4):
            status, data = self.call(port, "POST", "/output/observe", {"api": 1, "span": span})
        error = json.loads(data)
        self.assertEqual((status, error["code"]), (422, "unavailable"))
        self.assertIn("5 samples", error["message"])
        self.assertIn("limit is 4", error["message"])
        status, data = self.call(port, "POST", "/output/observe", {"api": 1, "span": {"from": iso(T0 + 250), "to": iso(T0 + 750)}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["observations"][0]["parts"][0]["values"], [1.0, 2.0])

    def test_recent_and_settings_have_no_history(self):
        port = self.serve(self.make())
        span = {"from": iso(T0), "to": iso(T0 + 1000)}
        for name in ("recent", "settings"):
            self.assertEqual(self.call(port, "POST", f"/{name}/observe", {"api": 1, "span": span})[0], 422)
        self.assertEqual(self.call(port, "POST", "/other/observe", {"api": 1})[0], 404)
        self.assertEqual(self.call(port, "POST", "/output/observe", {"api": 2})[0], 400)
        status, data = self.call(port, "GET", "/")
        self.assertEqual([(s["name"], s["spans"]) for s in json.loads(data)["sensors"]],
                         [("output", True), ("recent", False), ("settings", False)])

    def test_the_recent_file_is_a_blob_with_its_digest(self):
        sensor = self.make()
        self.put(sensor, 0, 1.0)
        port = self.serve(sensor)
        status, data = self.call(port, "POST", "/recent/observe", {"api": 1})
        parts = json.loads(data)["observations"][0]["parts"]
        self.assertEqual([p["kind"] for p in parts], ["text", "file"])
        status, content = self.call(port, "GET", f"/files/{parts[1]['file']}")
        self.assertEqual((status, hashlib.sha256(content).hexdigest()), (200, parts[1]["file"]))
        self.assertEqual(json.loads(content)["period_ms"], 250)


class Sampler(Sensed):
    def test_a_late_reading_is_dropped(self):
        clock = Clock(T0 + 10)
        sensor = self.make(clock=clock)
        wrapped = Wrapped(self.guard, clock)
        sensor.guard = wrapped
        wrapped.delay = [0, 300]  # the second read ends past its slot plus one period
        sensor.run(Stop(clock, 3))
        self.assertEqual([s["at"] - T0 for s in sensor.ring], [250, 1000])
        self.assertEqual(sensor.latest[0], T0 + 1000)
        self.assertEqual((self.directory / "data" / "samples.jsonl").read_text().count("\n"), 2)

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


class Process(Isolated):
    def run_sensor(self, data, *args):
        config = self.directory / "psu.json"
        config.write_text(json.dumps(CONFIG_TWO))
        env = {**os.environ, "AMBION_SENSOR_REPOSITORY": "instruments/bench-psu", "AMBION_SENSOR_DATA_DIR": str(data)}
        command = [sys.executable, "-u", "-B", "sensor.py", "--config", str(config), "--sim", str(self.state), *args]
        return subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_main_prints_ready_and_serves(self):
        process = self.run_sensor(self.directory / "data")
        timer = threading.Timer(30, process.kill)
        timer.start()
        try:
            line = process.stdout.readline()
            self.assertTrue(line.startswith("READY "), line + process.stderr.read() if process.poll() is not None else line)
            ready = json.loads(line[6:])
            connection = http.client.HTTPConnection("127.0.0.1", ready["port"], timeout=5)
            connection.request("GET", "/")
            response = connection.getresponse()
            body = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(body["source"]["repository"], "instruments/bench-psu")
            self.assertEqual([s["name"] for s in body["sensors"]], ["output", "recent", "settings"])
            connection.request("POST", "/output/observe", json.dumps({"api": 1}))
            self.assertEqual(len(json.loads(connection.getresponse().read())["observations"]), 1)
        finally:
            process.terminate()
            process.wait(timeout=10)
            timer.cancel()
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(process.returncode, 0)

    def test_main_refuses_a_data_directory_inside_the_checkout(self):
        process = self.run_sensor(ROOT / "sensor-data-refused")
        _, error = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 2)
        self.assertIn("outside the checkout", error)
        self.assertFalse((ROOT / "sensor-data-refused").exists())
