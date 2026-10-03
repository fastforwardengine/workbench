"""The rails of hold and sequence: one setpoint, current limit, and trip for each channel.

A rail is a channel with its own setpoints. This module expands the options
to one value for each rail, brings a rail up, and judges the readings of the
rails. It is not an actuator, and ACTUATORS does not list it.
"""

import time
from dataclasses import dataclass

from controller import GaveUp

from .common import finite, judge_current, judge_trip, least_period, off_reason, refuse_limits, refuse_unless

PERIOD = 0.25


@dataclass
class Rail:
    channel: str
    voltage: float
    current: float
    trip: float | None


def add_arguments(parser):
    """The options that hold and sequence share. A value for each channel, in --channel order."""
    parser.add_argument("--voltage", type=float, nargs="+", required=True, help="the voltage of each channel, in V. One value serves every channel")
    parser.add_argument("--current", type=float, nargs="+", required=True, help="the current limit of each channel, in A. One value serves every channel")
    parser.add_argument("--trip", type=float, nargs="+", help="an abnormal current below the limit, in A. One value serves every channel")
    parser.add_argument("--tolerance", type=float, default=0.05, help="the allowed distance from the voltage, in V")


def spread(args, name, count):
    """One value for each of count channels. A single value serves every channel."""
    values = getattr(args, name)
    if values is None:
        return [None] * count
    refuse_unless(len(values) in (1, count), f"The option --{name} takes one value, or one for each of the {count} channels in --channel order.")
    return values * count if len(values) == 1 else values


def check_numbers(args):
    finite(args, ("voltage", "current", "trip", "tolerance"))
    refuse_unless(min(args.voltage) >= 0, "The option --voltage must not hold a negative value.")
    refuse_unless(min(args.current) > 0 and args.tolerance > 0, "The options --current and --tolerance must be above 0.")


class Rails:
    def __init__(self, controller, guard, args):
        self.controller, self.guard, self.args = controller, guard, args
        names = args.channels
        volts, amps, trips = (spread(args, name, len(names)) for name in ("voltage", "current", "trip"))
        self.rails = [
            Rail(name, guard.quantize(name, volt, "voltage_step"), guard.quantize(name, amp, "current_step"), trip)
            for name, volt, amp, trip in zip(names, volts, amps, trips)
        ]
        refuse_unless(all(rail.trip is None or 0 < rail.trip <= rail.current for rail in self.rails), "The option --trip must be above 0 and at or below --current.")
        self.period = max(least_period(guard), PERIOD)
        self.settings = guard.settings()

    def validate(self):
        """Refuse before any write: the limits, and a channel that is on already."""
        for rail in self.rails:
            refuse_limits(self.guard, rail.channel, rail.voltage, rail.current)
            refuse_unless(not self.settings[rail.channel].on, f"The channel {rail.channel} is on already. The controller drives a channel that is off.")

    def announce(self, **fields):
        for rail in self.rails:
            self.controller.emit(
                "target", channel=rail.channel, voltage=rail.voltage, current=rail.current, trip=rail.trip,
                tolerance=self.args.tolerance, interval=self.controller.interval, **fields,
            )

    def power_on(self, rail):
        """Set the voltage and the current limit with the output off, and then turn the output on."""
        self.guard.set(rail.channel, voltage=rail.voltage, current=rail.current)
        setting = self.guard.output(rail.channel, True)
        reason = off_reason(setting)
        refuse_unless(not reason, f"The channel {rail.channel} did not turn on. {reason}")

    def inside(self, rail, reading):
        return abs(reading.voltage - rail.voltage) <= self.args.tolerance

    def judge(self, rail, reading, setting, settling):
        """Give up on a rail that is off, above its trip current, and, once up, at the current limit or outside the band."""
        refuse_unless(setting.on, self.went_off(rail, setting))
        if settling:
            return judge_trip(reading, rail.trip, rail.channel)
        judge_current(reading, setting, rail.trip, rail.channel)
        refuse_unless(self.inside(rail, reading), f"The measured voltage of {rail.channel}, {reading.voltage:g} V, is outside {rail.voltage:g} V, with tolerance {self.args.tolerance:g} V.")

    def went_off(self, rail, setting):
        if setting.tripped:
            return f"The channel {rail.channel} stopped. {off_reason(setting)}"
        return f"The output of {rail.channel} went off outside the controller."

    def measure(self, up, pending=()):
        """Read every channel once, log the rails, and judge them. The rails in pending are not up yet."""
        readings, settings = self.guard.measure(), self.guard.settings()
        for rail in (*up, *pending):
            self.controller.record(rail.channel, readings[rail.channel], settings[rail.channel])
        for rail in (*up, *pending):
            self.judge(rail, readings[rail.channel], settings[rail.channel], rail in pending)
        return readings

    def settle(self, up, pending, seconds):
        """Measure each period until every rail in pending is inside its band. Give up after seconds."""
        end = time.monotonic() + seconds
        while True:
            readings = self.measure(up, pending)
            late = [rail for rail in pending if not self.inside(rail, readings[rail.channel])]
            if not late:
                return readings
            if time.monotonic() >= end:
                raise GaveUp(self.unsettled(late[0], readings, seconds))
            self.controller.wait(self.period)

    def unsettled(self, rail, readings, seconds):
        reading = readings[rail.channel]
        mode = " The channel is in constant current." if self.guard.mode(self.guard.settings()[rail.channel], reading) == "cc" else ""
        return f"The rail {rail.channel} did not settle in {seconds:g} s: {reading.voltage:g} V, and the target is {rail.voltage:g} V, with tolerance {self.args.tolerance:g} V.{mode}"

    def watch(self, seconds):
        """Judge every rail each period until the deadline."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.controller.wait(min(self.period, end - time.monotonic()))
            self.measure(self.rails)

    def summary(self, readings):
        return ", ".join(f"{rail.channel} {readings[rail.channel].voltage:g} V {readings[rail.channel].current:g} A" for rail in self.rails)
