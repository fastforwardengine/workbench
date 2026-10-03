"""The sweep, hold, and sequence actuators, and the channel options of the harness, as real processes on the simulated supply."""

import argparse
import contextlib
import io
import os
import signal
import time
from unittest import mock

import controller

from .test_controller import Controllers

LOAD_10 = {"kind": "resistor", "ohms": 10}


class Actuators(Controllers):
    def outputs(self):
        """The turn-on and turn-off writes, in order, as (channel, 1 or 0)."""
        return [(channel, value) for channel, key, value in self.sim_writes() if key == "output"]

    def observed(self, channel="ch1"):
        return [event for event in self.read() if event["kind"] == "observe" and event["channel"] == channel]

    def ends_safe(self, process, states):
        self.assertEqual(self.finish(process), 0, process.stderr.read())
        self.assertEqual(self.states(), states)
        self.assertFalse(self.channel_on("ch1"))
        self.assertFalse(self.channel_on("ch2"))

    def refused(self, process, text):
        """The process gave up before any write. The note holds text."""
        self.assertEqual(self.finish(process), 0)
        self.assertEqual(self.states(), ["gave_up", "safe"])
        self.assertIn(text, self.note("gave_up"))
        self.assertNotIn(1, [value for _, value in self.outputs()])

    def terminate(self, process):
        """Send SIGTERM, wait for the end in under a second, and return the exit code."""
        started = time.monotonic()
        process.send_signal(signal.SIGTERM)
        code = self.finish(process)
        self.assertLess(time.monotonic() - started, 1.0)
        return code


class Sweep(Actuators):
    def sweep(self, *arguments, **options):
        return self.launch("--current", "0.1", "--dwell", "0.1", *arguments, actuator="sweep", **options)

    def test_a_sweep_logs_one_point_for_each_voltage_and_ends_off(self):
        process = self.sweep("--voltages", "1", "2", "3")
        self.ends_safe(process, ["acting", "reached", "safe"])
        self.assertEqual([event["voltage"] for event in self.observed()], [1.0, 2.0, 3.0])
        self.assertEqual(self.voltages(), [0.0, 1.0, 2.0, 3.0])
        self.assertEqual({event["kind"] for event in self.read()}, {"target", "observe", "drive", "state"})
        self.assertEqual(self.outputs(), [("ch1", 1), ("ch1", 0)])

    def test_a_point_in_constant_current_is_a_valid_point(self):
        self.write_config({"ch1": LOAD_10})
        process = self.sweep("--voltages", "0.5", "3")
        self.ends_safe(process, ["acting", "reached", "safe"])
        self.assertEqual([event["current"] for event in self.observed()], [0.05, 0.1])

    def test_a_trip_current_ends_the_sweep_after_the_point_is_logged(self):
        process = self.sweep("--voltages", "1", "3", "4", "--trip", "0.02")
        self.ends_safe(process, ["acting", "gave_up", "safe"])
        self.assertIn("trip", self.note("gave_up"))
        self.assertEqual([event["voltage"] for event in self.observed()], [1.0, 3.0])
        self.assertNotIn(4.0, self.voltages())

    def test_a_point_above_the_limit_writes_nothing_on(self):
        self.refused(self.sweep("--voltages", "1", "6"), "limit")
        self.assertEqual(self.sim_writes(), [])

    def test_a_dwell_below_the_least_period_is_refused(self):
        process = self.launch("--voltages", "1", "--current", "0.1", "--dwell", "0.01", actuator="sweep")
        self.refused(process, "least period")
        self.assertEqual(self.sim_writes(), [])


class Hold(Actuators):
    def hold(self, *arguments, **options):
        return self.launch(*arguments, actuator="hold", **options)

    def test_a_hold_watches_to_the_deadline_and_ends_off(self):
        process = self.hold("--voltage", "3", "--current", "0.1", "--seconds", "0.6")
        self.ends_safe(process, ["acting", "reached", "holding", "safe"])
        self.assertEqual(self.note("safe"), "done")
        self.assertEqual(self.outputs(), [("ch1", 1), ("ch1", 0)])

    def test_two_channels_hold_and_both_end_off(self):
        process = self.hold("--voltage", "3", "1", "--current", "0.1", "0.02", "--seconds", "0.5", channels=["ch1", "ch2"])
        self.ends_safe(process, ["acting", "reached", "holding", "safe"])
        self.assertEqual(sorted(self.outputs()), [("ch1", 0), ("ch1", 1), ("ch2", 0), ("ch2", 1)])
        self.assertEqual({event["channel"] for event in self.read() if event["kind"] == "observe"}, {"ch1", "ch2"})

    def test_one_value_serves_every_channel(self):
        process = self.hold("--voltage", "1", "--current", "0.02", "--seconds", "0.3", channels=["ch1", "ch2"])
        self.ends_safe(process, ["acting", "reached", "holding", "safe"])
        self.assertEqual([(channel, value) for channel, key, value in self.sim_writes() if key == "voltage"], [("ch1", 1.0), ("ch2", 1.0)])

    def test_a_count_of_values_that_fits_no_channel_is_refused(self):
        process = self.hold("--voltage", "1", "2", "3", "--current", "0.02", "--seconds", "1", channels=["ch1", "ch2"])
        self.refused(process, "--voltage")
        self.assertEqual(self.sim_writes(), [])

    def test_a_channel_that_is_on_already_is_refused_and_ends_off(self):
        sim = self.sim()
        sim.set("ch1", voltage=1.0, current=0.1)
        sim.output("ch1", True)
        process = self.hold("--voltage", "3", "--current", "0.1", "--seconds", "1")
        self.ends_safe(process, ["gave_up", "safe"])
        self.assertIn("on already", self.note("gave_up"))
        self.assertEqual(self.voltages(), [1.0])

    def test_a_load_in_constant_current_ends_the_hold(self):
        self.write_config({"ch1": LOAD_10})
        process = self.hold("--voltage", "3", "--current", "0.1", "--seconds", "1")
        self.ends_safe(process, ["acting", "gave_up", "safe"])
        self.assertIn("did not settle", self.note("gave_up"))
        self.assertIn("constant current", self.note("gave_up"))

    def test_a_trip_current_ends_the_hold(self):
        process = self.hold("--voltage", "3", "--current", "0.1", "--trip", "0.02", "--seconds", "1")
        self.ends_safe(process, ["acting", "gave_up", "safe"])
        self.assertIn("abnormal", self.note("gave_up"))

    def test_an_output_turned_off_from_another_process_ends_the_hold(self):
        process = self.hold("--voltage", "3", "--current", "0.1", "--seconds", "30")
        self.wait_for_state("holding")
        self.assertEqual(self.run_finally("--channel", "ch1").returncode, 0)
        self.assertEqual(self.finish(process), 0)
        mine = [event["value"] for event in self.read() if event["kind"] == "state" and event["actuator"] == "hold"]
        self.assertEqual(mine, ["acting", "reached", "holding", "gave_up", "safe"])
        self.assertIn("outside the controller", self.note("gave_up"))
        self.assertFalse(self.channel_on())

    def test_sigterm_makes_the_channels_safe_in_under_a_second(self):
        process = self.hold("--voltage", "3", "1", "--current", "0.1", "0.02", "--seconds", "30", channels=["ch1", "ch2"])
        self.wait_for_state("holding")
        self.assertEqual(self.terminate(process), 0)
        self.assertEqual(self.states(), ["acting", "reached", "holding", "stopping", "safe"])
        self.assertFalse(self.channel_on("ch1") or self.channel_on("ch2"))


class Sequence(Actuators):
    def sequence(self, *arguments, order=("ch2", "ch1"), **options):
        volts, amps = {"ch1": "3", "ch2": "1.8"}, {"ch1": "0.1", "ch2": "0.02"}
        values = ["--voltage", *(volts[name] for name in order), "--current", *(amps[name] for name in order)]
        return self.launch(*values, *arguments, actuator="sequence", channels=list(order), **options)

    def test_rails_come_up_in_the_given_order_and_go_off_in_reverse(self):
        process = self.sequence("--seconds", "0.3")
        self.ends_safe(process, ["acting", "reached", "holding", "safe"])
        self.assertEqual(self.outputs(), [("ch2", 1), ("ch1", 1), ("ch1", 0), ("ch2", 0)])

    def test_a_sequence_without_a_hold_time_ends_at_reached(self):
        self.ends_safe(self.sequence(order=("ch1", "ch2")), ["acting", "reached", "safe"])
        self.assertEqual(self.outputs(), [("ch1", 1), ("ch2", 1), ("ch2", 0), ("ch1", 0)])

    def test_a_rail_that_does_not_settle_ends_the_sequence_with_every_rail_off(self):
        self.write_config({"ch2": LOAD_10})
        process = self.sequence("--settle", "0.5", order=("ch1", "ch2"))
        self.ends_safe(process, ["acting", "gave_up", "safe"])
        self.assertIn("The rail ch2 did not settle in 0.5 s", self.note("gave_up"))
        self.assertEqual(self.outputs(), [("ch1", 1), ("ch2", 1), ("ch2", 0), ("ch1", 0)])

    def test_sigterm_turns_the_rails_off_in_reverse_order(self):
        process = self.sequence("--seconds", "30", order=("ch1", "ch2"))
        self.wait_for_state("holding")
        self.assertEqual(self.terminate(process), 0)
        self.assertEqual(self.states(), ["acting", "reached", "holding", "stopping", "safe"])
        self.assertEqual(self.outputs()[-2:], [("ch2", 0), ("ch1", 0)])

    def test_fewer_than_two_channels_are_refused_before_any_lock(self):
        for order in (["ch1"], []):
            process = self.launch("--voltage", "3", "--current", "0.1", actuator="sequence", channels=order)
            self.assertEqual(self.finish(process), 1)
            self.assertIn("at least 2 channels", process.stderr.read())
        self.assertFalse(list(self.locks.glob("*.drive")))
        self.assertEqual((self.sim_writes(), self.read()), ([], []))

    def test_a_down_dwell_above_the_cap_is_refused(self):
        self.refused(self.sequence("--down-dwell", "3"), "--down-dwell")

    def test_a_failed_ordered_step_still_turns_every_channel_off(self):
        def body(control, guard, args):
            control.stop_order, control.stop_dwell = ["ch2", "ch1"], 0
            for channel in ("ch1", "ch2"):
                guard.set(channel, voltage=1.0, current=0.02)
                guard.output(channel, True)
            real = guard.off
            guard.off = lambda channels=None: real(channels) if channels is None or len(channels) > 1 else self.fail_step()

        code, _ = self.run_in_process("sequence", argparse.Namespace(channels=["ch1", "ch2"]), body, (2, None))
        self.assertEqual(code, 0)
        self.assertEqual(self.states(), ["safe"])
        self.assertFalse(self.channel_on("ch1") or self.channel_on("ch2"))

    def fail_step(self):
        raise RuntimeError("The ordered step failed.")

    def run_in_process(self, actuator, args, body, bounds):
        args.config, args.sim = str(self.config), str(self.state)
        errors = io.StringIO()
        for number in (signal.SIGTERM, signal.SIGINT):
            self.addCleanup(signal.signal, number, signal.getsignal(number))
        with mock.patch.dict(os.environ, {"ACTUATOR_EVENTS": str(self.events)}), contextlib.redirect_stderr(errors):
            return controller.run(actuator, args, body, bounds), errors.getvalue()


class Channels(Actuators):
    def test_a_channel_given_twice_is_refused_before_any_lock(self):
        process = self.launch("--voltage", "1", "--current", "0.02", "--seconds", "0.3", channels=["ch1", "ch1"])
        self.assertEqual(self.finish(process), 1)
        self.assertIn("The channel ch1 is given twice", process.stderr.read())
        self.assertFalse(list(self.locks.glob("*.drive")))
        self.assertEqual(self.sim_writes(), [])

    def test_more_channels_than_the_actuator_allows_are_refused_before_any_lock(self):
        process = self.launch("--voltage", "1", "--current", "0.02", "--seconds", "0.3", channels=["ch1", "ch2"])
        self.assertEqual(self.finish(process), 1)
        self.assertIn("at most 1 channel", process.stderr.read())
        self.assertFalse(list(self.locks.glob("*.drive")))
        self.assertEqual(self.sim_writes(), [])

    def test_a_channel_that_the_supply_lacks_is_refused_for_a_list(self):
        process = self.launch("--voltage", "1", "--current", "0.02", "--seconds", "1", actuator="hold", channels=["ch1", "ch9"])
        self.assertEqual(self.finish(process), 1)
        self.assertIn("There is no channel ch9", process.stderr.read())
        self.assertEqual(self.sim_writes(), [])
