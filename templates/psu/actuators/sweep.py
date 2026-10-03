"""Step a channel through a list of voltages under a current limit, and log each point."""

from .common import finite, judge_trip, least_period, off_reason, power_on, refuse_limits, refuse_unless

CHANNELS = (1, 1)


def add_arguments(parser):
    parser.add_argument("--voltages", type=float, nargs="+", required=True, help="the setpoints, in V, in the order to visit")
    parser.add_argument("--current", type=float, required=True, help="the current limit, in A")
    parser.add_argument("--dwell", type=float, default=1, help="the time at each point before the reading, in s")
    parser.add_argument("--trip", type=float, help="an abnormal current below the limit, in A")


def check_numbers(args):
    finite(args, ("voltages", "current", "dwell", "trip"))
    refuse_unless(args.voltages, "The option --voltages needs at least one value.")
    refuse_unless(min(args.voltages) >= 0, "The option --voltages must not hold a negative value.")
    refuse_unless(args.current > 0, "The option --current must be above 0.")
    refuse_unless(args.trip is None or 0 < args.trip <= args.current, "The option --trip must be above 0 and at or below --current.")


class Sweep:
    def __init__(self, controller, guard, args):
        self.controller, self.guard, self.args = controller, guard, args
        self.channel = args.channel
        self.points = [guard.quantize(self.channel, voltage, "voltage_step") for voltage in args.voltages]
        self.current = guard.quantize(self.channel, args.current, "current_step")
        self.setting = guard.settings()[self.channel]

    def validate(self):
        """Refuse before any write: the dwell, and the highest point against the limits."""
        floor = least_period(self.guard)
        refuse_unless(self.args.dwell >= floor, f"The option --dwell {self.args.dwell:g} s is below the least period {floor:g} s.")
        refuse_limits(self.guard, self.channel, max(self.points), self.current)

    def announce(self):
        self.controller.emit(
            "target", channel=self.channel, voltages=self.points, current=self.current, dwell=self.args.dwell,
            trip=self.args.trip, interval=self.controller.interval,
        )

    def power_on(self):
        self.setting = power_on(self.guard, self.channel, self.current, self.setting)

    def point(self, number, voltage):
        """Set one point, wait the dwell, and log the reading. A point in constant current is a valid point."""
        self.controller.check()
        where = f"point {number} of {len(self.points)}, {voltage:g} V"
        self.setting = self.guard.set(self.channel, voltage=voltage)
        reason = off_reason(self.setting)
        refuse_unless(not reason, f"The channel stopped at {where}. {reason}")
        self.controller.wait(self.args.dwell)
        reading = self.guard.measure()[self.channel]
        self.setting = self.guard.settings()[self.channel]
        self.controller.record(self.channel, reading, self.setting, force=True)
        reason = off_reason(self.setting)
        refuse_unless(not reason, f"The channel stopped at {where}. {reason}")
        judge_trip(reading, self.args.trip)
        return reading


def run(controller, guard, args):
    controller.check()
    check_numbers(args)
    sweep = Sweep(controller, guard, args)
    sweep.validate()
    sweep.announce()
    sweep.power_on()
    controller.claim("acting")
    for number, voltage in enumerate(sweep.points, 1):
        reading = sweep.point(number, voltage)
    controller.claim("reached", f"{len(sweep.points)} points, the last at {reading.voltage:g} V, {reading.current:g} A")
