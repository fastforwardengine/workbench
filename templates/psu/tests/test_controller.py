"""The controller harness and the ramp, as real processes on the simulated supply."""

import argparse
import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from unittest import mock

import controller

from .support import CONFIG_TWO, Isolated

ROOT = Path(__file__).resolve().parent.parent
RAMP = ["--seconds", "0.5", "--steps", "5"]


class Controllers(Isolated):
    def setUp(self):
        super().setUp()
        self.processes = []
        self.addCleanup(self.stop_all)
        self.events = self.directory / "events.jsonl"
        self.write_config()

    def stop_all(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stderr.close()

    def write_config(self, loads=None):
        config = dict(CONFIG_TWO)
        if loads:
            config["sim"] = {"loads": loads}
        self.config = self.directory / "psu.json"
        self.config.write_text(json.dumps(config))

    def environment(self, events):
        return {"PATH": "/usr/bin:/bin", "PSU_LOCK_DIR": str(self.locks), "ACTUATOR_EVENTS": str(events)}

    def launch(self, *arguments, channel="ch1", events=None, actuator="ramp", channels=None):
        """Start an actuator as a process. channels lists the --channel options, and replaces channel."""
        options = [part for name in (channels if channels is not None else [channel]) for part in ("--channel", name)]
        command = ["start.py", "--config", str(self.config), "--sim", str(self.state), actuator, *options, *arguments]
        process = subprocess.Popen([sys.executable, "-B", *command], cwd=ROOT, env=self.environment(events or self.events), stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        return process

    def finish(self, process):
        """Wait for the process to end, and return its exit code."""
        self.assertIsNotNone(process.wait(timeout=20))
        return process.returncode

    def read(self, events=None):
        path = events or self.events
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def states(self, events=None):
        return [event["value"] for event in self.read(events) if event["kind"] == "state"]

    def wait_for_state(self, value, events=None):
        end = time.monotonic() + 10
        while time.monotonic() < end:
            if value in self.states(events):
                return
            time.sleep(0.02)
        self.fail(f"No state {value}. The log: {self.read(events)}")

    def note(self, value, events=None):
        return next(event["note"] for event in self.read(events) if event["kind"] == "state" and event["value"] == value)

    def channel_on(self, channel="ch1"):
        return json.loads(self.state.read_text())["channels"][channel]["on"]

    def voltages(self):
        return [value for channel, key, value in self.sim_writes() if channel == "ch1" and key == "voltage"]

    def run_finally(self, *arguments):
        command = ["finally.py", "--config", str(self.config), "--sim", str(self.state), *arguments]
        return subprocess.run([sys.executable, "-B", *command], cwd=ROOT, env=self.environment(self.events), capture_output=True, text=True, timeout=20, check=False)


class Ramp(Controllers):
    def test_a_ramp_reaches_the_target_and_turns_off(self):
        process = self.launch("--voltage", "5", "--current", "0.1", *RAMP)
        self.assertEqual(self.finish(process), 0, process.stderr.read())
        self.assertEqual(self.states(), ["acting", "reached", "safe"])
        self.assertEqual(self.note("safe"), "done")
        writes = self.sim_writes()
        self.assertLess(writes.index(("ch1", "current", 0.1)), writes.index(("ch1", "output", 1)))
        voltages = self.voltages()
        self.assertEqual(voltages, sorted(voltages))
        self.assertEqual(voltages[-1], 5.0)
        self.assertEqual(writes[-1], ("ch1", "output", 0))
        first = self.read()[0]
        self.assertEqual((first["v"], first["kind"], first["actuator"]), (1, "target", "ramp"))
        self.assertRegex(first["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        kinds = {event["kind"] for event in self.read()}
        self.assertEqual(kinds, {"target", "observe", "drive", "state"})

    def test_a_load_at_the_current_limit_ends_the_ramp(self):
        self.write_config({"ch1": {"kind": "resistor", "ohms": 10}})
        process = self.launch("--voltage", "5", "--current", "0.1", *RAMP)
        self.assertEqual(self.finish(process), 0)
        self.assertEqual(self.states(), ["acting", "gave_up", "safe"])
        self.assertIn("constant current", self.note("gave_up"))
        self.assertFalse(self.channel_on())
        self.assertLess(max(self.voltages()), 5.0)

    def test_a_trip_current_ends_the_ramp(self):
        process = self.launch("--voltage", "5", "--current", "0.1", "--trip", "0.02", *RAMP)
        self.assertEqual(self.finish(process), 0)
        self.assertEqual(self.states(), ["acting", "gave_up", "safe"])
        self.assertIn("trip", self.note("gave_up"))
        self.assertLess(max(self.voltages()), 5.0)
        self.assertFalse(self.channel_on())

    def test_a_target_above_the_limit_writes_nothing_on(self):
        process = self.launch("--voltage", "6", "--current", "0.1", *RAMP)
        self.assertEqual(self.finish(process), 0)
        self.assertEqual(self.states(), ["gave_up", "safe"])
        self.assertIn("limit", self.note("gave_up"))
        self.assertNotIn(("ch1", "output", 1), self.sim_writes())

    def test_a_period_below_the_least_period_is_refused(self):
        process = self.launch("--voltage", "5", "--current", "0.1", "--seconds", "0.1", "--steps", "10")
        self.assertEqual(self.finish(process), 0)
        self.assertEqual(self.states(), ["gave_up", "safe"])
        self.assertEqual(self.sim_writes(), [])


class Ends(Controllers):
    def hold(self, *extra, channel="ch1", events=None):
        process = self.launch("--voltage", "3", "--current", "0.1", "--hold", "30", *RAMP, *extra, channel=channel, events=events)
        self.wait_for_state("holding", events)
        return process

    def test_sigterm_makes_the_channel_safe_in_under_a_second(self):
        process = self.hold()
        started = time.monotonic()
        process.send_signal(signal.SIGTERM)
        self.assertEqual(self.finish(process), 0)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(self.states(), ["acting", "reached", "holding", "stopping", "safe"])
        self.assertFalse(self.channel_on())

    def test_finally_turns_off_a_killed_controller_and_changes_nothing_twice(self):
        process = self.hold()
        process.kill()
        process.wait()
        self.assertTrue(self.channel_on())
        done = self.run_finally("--channel", "ch1")
        self.assertEqual((done.returncode, done.stdout), (0, "ch1: off\n"))
        self.assertFalse(self.channel_on())
        writes = self.sim_writes()
        self.assertEqual(self.run_finally("--channel", "ch1").returncode, 0)
        self.assertEqual(self.sim_writes(), writes)
        self.assertEqual(self.note("safe"), "finally")

    def test_a_busy_channel_refuses_and_another_channel_runs(self):
        first = self.hold()
        second_events = self.directory / "second.jsonl"
        second = self.launch("--voltage", "3", "--current", "0.1", *RAMP, events=second_events)
        self.assertEqual(self.finish(second), 0)
        self.assertEqual(self.states(second_events), ["gave_up"])
        note = self.note("gave_up", second_events)
        self.assertIn("ramp", note)
        self.assertIn(str(first.pid), note)
        self.assertIn(str(first.pid), second.stderr.read())
        other_events = self.directory / "other.jsonl"
        other = self.launch("--voltage", "1", "--current", "0.02", *RAMP, channel="ch2", events=other_events)
        self.assertEqual(self.finish(other), 0)
        self.assertEqual(self.states(other_events), ["acting", "reached", "safe"])
        self.assertIsNone(first.poll())
        self.assertTrue(self.channel_on())


class Errors(Controllers):
    def run_body(self, body):
        args = argparse.Namespace(config=str(self.config), sim=str(self.state), channel="ch1")
        errors = io.StringIO()
        for number in (signal.SIGTERM, signal.SIGINT):
            self.addCleanup(signal.signal, number, signal.getsignal(number))
        with mock.patch.dict(os.environ, {"ACTUATOR_EVENTS": str(self.events)}), contextlib.redirect_stderr(errors):
            return controller.run("ramp", args, body), errors.getvalue()

    def test_an_error_makes_the_channel_safe_and_exits_1(self):
        def body(control, guard, args):
            guard.set("ch1", voltage=1.0, current=0.1)
            guard.output("ch1", True)
            raise RuntimeError("The read failed.")

        code, errors = self.run_body(body)
        self.assertEqual(code, 1)
        self.assertEqual(self.states(), ["safe"])
        self.assertIn("The read failed.", self.note("safe"))
        self.assertIn("The read failed.", errors)
        self.assertFalse(self.channel_on())

    def test_a_failed_safe_action_logs_no_safe_claim(self):
        def body(control, guard, args):
            self.state.write_text("not JSON")
            raise RuntimeError("The read failed.")

        code, errors = self.run_body(body)
        self.assertEqual(code, 1)
        self.assertEqual(self.states(), [])
        self.assertIn("The read failed.", errors)
        self.assertIn("safe action failed", errors)

    def test_a_channel_that_stays_on_after_the_turn_off_is_not_safe(self):
        def body(control, guard, args):
            guard.set("ch1", voltage=1.0, current=0.1)
            guard.output("ch1", True)
            guard.driver.off = lambda channels=None: None  # a supply that ignores the turn-off

        code, errors = self.run_body(body)
        self.assertEqual(code, 1)
        self.assertNotIn("safe", self.states())
        self.assertIn("ch1", errors)
        self.assertTrue(self.channel_on())

    def test_an_unknown_channel_takes_no_lock_and_touches_nothing(self):
        args = argparse.Namespace(config=str(self.config), sim=str(self.state), channel="ch9")
        errors = io.StringIO()
        for number in (signal.SIGTERM, signal.SIGINT):
            self.addCleanup(signal.signal, number, signal.getsignal(number))
        with mock.patch.dict(os.environ, {"ACTUATOR_EVENTS": str(self.events)}), contextlib.redirect_stderr(errors):
            code = controller.run("ramp", args, lambda *_: self.fail("the body ran"))
        self.assertEqual(code, 1)
        self.assertIn("There is no channel ch9", errors.getvalue())
        self.assertNotIn("may be on", errors.getvalue())
        self.assertFalse((self.locks / "psu.ch9.drive").exists())
        self.assertEqual(self.sim_writes(), [])
