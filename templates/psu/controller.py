"""The controller harness: the stop flag, the event log, and the safe end.

An actuator (a module in actuators/) drives one channel or several under a
law. The module declares how many in CHANNELS, and the harness resolves the
--channel options before it takes any lock. The harness holds the contract
of a controller:

1. The handlers of SIGTERM and SIGINT only set a flag. The actuator calls
   check() and wait() between device calls, so a call in progress ends
   before the safe action. A wait sleeps in slices of 50 ms.
2. Exit 0 means safe: every channel that this process holds is off. An
   error makes the channels safe if it can, and exits 1.
3. The process takes the drive lock of each of its channels without
   waiting. A busy lock logs gave_up with the holder, and touches nothing.
4. The event log is one JSON line for each event. ACTUATOR_EVENTS names the
   file, else it is events.jsonl in the working directory.

The claims in a state event are acting, reached, holding, stopping, safe,
and gave_up. An actuator can set stop_order and stop_dwell. The safe action
then turns the channels off one at a time in that order, with the dwell
between them, before it turns off every channel that the process holds.
finally.py makes the channels safe after an unclean end.
"""

import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

from drivers import SupplyError, open_driver
from guard import Guard, choose_channel, hold_drive_locks, load_config

SLICE = 0.05
INTERVAL = 1.0


class Stopped(Exception):
    """A signal asked the controller to stop."""


class GaveUp(Exception):
    """The controller ends its work, and makes the channels safe."""

    def __init__(self, note):
        super().__init__(note)
        self.note = note


def events_path():
    return os.environ.get("ACTUATOR_EVENTS") or os.path.join(os.getcwd(), "events.jsonl")


def emit(actuator, kind, **fields):
    """Append one line to the event log. The file closes before the call returns."""
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    line = json.dumps({"v": 1, "at": at, "kind": kind, "actuator": actuator, **fields})
    with open(events_path(), "a") as log:
        log.write(line + "\n")


def describe(error):
    return str(error) if isinstance(error, SupplyError) else f"{type(error).__name__}: {error}"


class Controller:
    def __init__(self, actuator):
        self.actuator = actuator
        self.interval = INTERVAL
        self.stop = None  # the name of the first signal
        self.claimed = None
        self.latest = {}  # the last (reading, setting) of each channel
        self.pending = False  # the latest values are not in the log yet
        self.logged_at = None
        self.stop_order = None  # the channels to turn off first, in order
        self.stop_dwell = 0.0  # the seconds between two steps of stop_order

    def install(self):
        for number in (signal.SIGTERM, signal.SIGINT):
            signal.signal(number, self._signal)

    def _signal(self, number, _frame):
        if self.stop is None:
            self.stop = signal.Signals(number).name

    def check(self):
        if self.stop:
            raise Stopped(self.stop)

    def wait(self, seconds):
        """Sleep in short slices, and raise Stopped when a signal comes."""
        end = time.monotonic() + seconds
        while True:
            self.check()
            left = end - time.monotonic()
            if left <= 0:
                return
            time.sleep(min(SLICE, left))

    def emit(self, kind, **fields):
        emit(self.actuator, kind, **fields)

    def _drive(self, channel, setting):
        self.emit("drive", channel=channel, voltage=setting.voltage, current=setting.current, output="on" if setting.on else "off")

    def _pair(self):
        for channel, (reading, setting) in self.latest.items():
            self.emit("observe", channel=channel, voltage=reading.voltage, current=reading.current, power=reading.power)
            self._drive(channel, setting)
        self.pending = False
        self.logged_at = time.monotonic()

    def record(self, channel, reading, setting, force=False):
        """Keep the latest values of the channel. Log the values of every channel once for each interval, or at once with force."""
        self.latest[channel] = (reading, setting)
        self.pending = True
        if force or self.logged_at is None or time.monotonic() - self.logged_at >= self.interval:
            self._pair()

    def claim(self, value, note=None):
        """Log a claim when it changes, with the latest values beside it."""
        if self.claimed == value:
            return
        self.claimed = value
        self.emit("state", value=value, **({"note": note} if note else {}))
        if self.pending and value != "safe":
            self._pair()

    def _ordered_off(self, guard, held):
        """Turn off the held channels of stop_order one at a time. An error ends the steps, and the sweep that follows is the safe action."""
        try:
            for step, channel in enumerate([name for name in self.stop_order or [] if name in held]):
                if step:
                    time.sleep(self.stop_dwell)  # a plain sleep: the stop flag is already set
                for name, setting in guard.off([channel]).items():
                    self._drive(name, setting)
        except Exception:
            pass

    def safe(self, guard, channels):
        """Turn off the channels that this process holds, log their drive lines, and return the channels that stay on."""
        self._ordered_off(guard, channels)
        settings = guard.off(channels)
        for channel, setting in settings.items():
            self._drive(channel, setting)
        return [channel for channel, setting in settings.items() if setting.on]


def _give_up(control, note):
    control.claim("gave_up", note)
    print(f"{control.actuator}: {note}", file=sys.stderr)


def _end(control, guard, channels, body, args):
    """Run the body, then make the channels safe. Return the exit code."""
    problem = None
    note = None
    try:
        body(control, guard, args)
        note = "done"
    except Stopped:
        control.claim("stopping", control.stop)
    except GaveUp as stop:
        _give_up(control, stop.note)
    except Exception as error:
        problem = describe(error)
        note = problem
    try:
        still_on = control.safe(guard, channels)
        failure = f"The supply reports these channels on after the turn-off: {', '.join(still_on)}." if still_on else None
    except Exception as error:
        failure = describe(error)
    if failure:
        if problem:
            print(f"{control.actuator}: {problem}", file=sys.stderr)
        print(f"{control.actuator}: The channels may be on. The safe action failed: {failure}", file=sys.stderr)
        return 1
    control.claim("safe", note)
    if problem:
        print(f"{control.actuator}: {problem}", file=sys.stderr)
    return 1 if problem else 0


def _count(number):
    return f"{number} channel" + ("" if number == 1 else "s")


def resolve_channels(actuator, args, available, bounds):
    """The channels of the command in the order given, or a SupplyError.

    args.channels is a list, and args.channel is one name. With neither, a
    supply of one channel gives that channel.
    """
    least, most = bounds
    given = getattr(args, "channels", None) or ([args.channel] if getattr(args, "channel", None) else [])
    if not given and least == 1:
        given = [choose_channel(available, None)]
    chosen = [choose_channel(available, name) for name in given]
    for name in chosen:
        if chosen.count(name) > 1:
            raise SupplyError(f"The channel {name} is given twice.")
    if len(chosen) < least:
        raise SupplyError(f"The actuator {actuator} needs at least {_count(least)}, and {_count(len(chosen))} given: use --channel for each one.")
    if most is not None and len(chosen) > most:
        raise SupplyError(f"The actuator {actuator} takes at most {_count(most)}, and {_count(len(chosen))} given.")
    return chosen


def run(actuator, args, body, channels=(1, 1)):
    """Run body(control, guard, args) as a controller, and return the exit code.

    channels is (least, most) for the number of channels, and most can be
    None. args holds config, sim, and channels (a list) or channel (a name).
    The harness sets args.channels to the channels that it drives, in the
    order given, and args.channel to the only one when there is one.
    """
    control = Controller(actuator)
    control.install()
    try:
        config = load_config(args.config)
        if args.sim:
            config["driver"] = "sim"
        args.channels = resolve_channels(actuator, args, list(config["channels"]), channels)
        if len(args.channels) == 1:
            args.channel = args.channels[0]
    except SupplyError as error:
        print(f"{actuator}: {error}", file=sys.stderr)
        return 1
    try:
        locks = hold_drive_locks(config, args.channels, actuator)
    except SupplyError as busy:
        _give_up(control, str(busy))
        return 0
    guard = None
    try:
        guard = Guard(open_driver(config, args.sim), config, locks=locks, actuator=actuator)
        return _end(control, guard, list(locks.held), body, args)
    except (SupplyError, OSError) as error:
        print(f"{actuator}: {error}", file=sys.stderr)
        return 1
    finally:
        if guard is not None:
            guard.close()
        locks.release()
