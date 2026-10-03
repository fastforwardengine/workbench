"""Bring a channel to a voltage in steps under a current limit, hold, and turn off."""

import math
import time

from controller import GaveUp
from drivers import SupplyError
from guard import CC_BAND

MIN_PERIOD = 0.05
SETTLE_PERIODS = 3


def add_arguments(parser):
    parser.add_argument("--voltage", type=float, required=True, help="the target voltage, in V")
    parser.add_argument("--current", type=float, required=True, help="the current limit, in A")
    parser.add_argument("--seconds", type=float, default=10, help="the ramp time, in s")
    parser.add_argument("--steps", type=int, default=20, help="the number of voltage steps")
    parser.add_argument("--hold", type=float, default=0, help="the time at the target after reached, in s")
    parser.add_argument("--trip", type=float, help="an abnormal current below the limit, in A")
    parser.add_argument("--tolerance", type=float, default=0.05, help="the allowed distance from the target, in V")


def refuse_unless(condition, note):
    if not condition:
        raise GaveUp(note)


def check_numbers(args):
    for name in ("voltage", "current", "seconds", "hold", "tolerance"):
        refuse_unless(math.isfinite(getattr(args, name)), f"The option --{name} must be a finite number.")
    refuse_unless(args.trip is None or math.isfinite(args.trip), "The option --trip must be a finite number.")
    for name in ("current", "seconds", "steps", "tolerance"):
        refuse_unless(getattr(args, name) > 0, f"The option --{name} must be above 0.")
    refuse_unless(args.voltage >= 0 and args.hold >= 0, "The options --voltage and --hold must not be negative.")
    refuse_unless(args.trip is None or 0 < args.trip <= args.current, "The option --trip must be above 0 and at or below --current.")


def off_reason(setting):
    """Why a channel is off, or None when it is on."""
    if setting.on:
        return None
    return f"The output is off ({', '.join(setting.tripped)} tripped)." if setting.tripped else "The output is off."


class Ramp:
    def __init__(self, controller, guard, args):
        self.controller, self.guard, self.args = controller, guard, args
        self.channel = args.channel
        try:
            guard.known(self.channel)
        except SupplyError as error:
            raise GaveUp(str(error)) from error
        self.target = guard.quantize(self.channel, args.voltage, "voltage_step")
        self.current = guard.quantize(self.channel, args.current, "current_step")
        self.period = args.seconds / args.steps
        self.setting = guard.settings()[self.channel]
        self.start = self.setting.voltage if self.setting.on else 0.0

    def validate(self):
        """Refuse before any write: the limits, and a period that the supply can follow."""
        floor = max(4 * self.guard.describe().measure_seconds, MIN_PERIOD)
        refuse_unless(self.period >= floor, f"The period {self.period:g} s (--seconds / --steps) is below the least period {floor:g} s.")
        try:
            self.guard.check(self.channel, max(self.start, self.target), self.current)
        except SupplyError as error:
            raise GaveUp(str(error)) from error

    def announce(self):
        args = self.args
        self.controller.emit(
            "target", channel=self.channel, voltage=self.target, current=self.current, seconds=args.seconds,
            steps=args.steps, hold=args.hold, trip=args.trip, tolerance=args.tolerance, interval=self.controller.interval,
        )

    def power_on(self):
        """Set the current limit first. An output that is off starts at 0 V."""
        if self.setting.on:
            if self.setting.current != self.current:
                self.setting = self.guard.set(self.channel, current=self.current)
            return
        self.guard.set(self.channel, voltage=0.0, current=self.current)
        self.setting = self.guard.output(self.channel, True)

    def judge(self, reading):
        """Give up on a reading at the current limit, or above the trip current."""
        where = f"{reading.current:g} A at {reading.voltage:g} V"
        if reading.current >= self.current * (1 - CC_BAND):
            raise GaveUp(f"The channel is in constant current: {where}, at the limit {self.current:g} A.")
        if self.args.trip is not None and reading.current > self.args.trip:
            raise GaveUp(f"The current is abnormal: {where}, above the trip current {self.args.trip:g} A.")

    def measure(self):
        reading = self.guard.measure()[self.channel]
        self.controller.record(self.channel, reading, self.setting)
        self.judge(reading)
        return reading

    def inside(self, reading):
        return abs(reading.voltage - self.target) <= self.args.tolerance

    def lost(self, reading):
        """Give up on a reading outside the tolerance."""
        why = off_reason(self.guard.settings()[self.channel]) or ""
        raise GaveUp(f"The measured voltage {reading.voltage:g} V is outside {self.target:g} V, with tolerance {self.args.tolerance:g} V. {why}".strip())

    def step(self, k):
        self.controller.check()
        voltage = self.start + (self.target - self.start) * k / self.args.steps
        self.setting = self.guard.set(self.channel, voltage=voltage)
        reason = off_reason(self.setting)
        if reason:
            raise GaveUp(f"The channel stopped at step {k} of {self.args.steps}. {reason}")
        self.controller.wait(self.period)
        return self.measure()

    def settle(self, reading):
        """Wait up to three periods for the voltage to reach the target."""
        for _ in range(SETTLE_PERIODS):
            if self.inside(reading):
                return reading
            self.controller.wait(self.period)
            reading = self.measure()
        if not self.inside(reading):
            self.lost(reading)
        return reading

    def hold(self):
        end = time.monotonic() + self.args.hold
        while time.monotonic() < end:
            self.controller.wait(min(self.period, end - time.monotonic()))
            reading = self.measure()
            if not self.inside(reading):
                self.lost(reading)


def run(controller, guard, args):
    controller.check()
    check_numbers(args)
    ramp = Ramp(controller, guard, args)
    ramp.validate()
    ramp.announce()
    ramp.power_on()
    controller.claim("acting")
    for k in range(1, args.steps + 1):
        reading = ramp.step(k)
    reading = ramp.settle(reading)
    controller.claim("reached", f"{reading.voltage:g} V, {reading.current:g} A")
    if args.hold > 0:
        controller.claim("holding")
        ramp.hold()
