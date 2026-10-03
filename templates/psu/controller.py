"""The controller harness: the stop flag, the event log, and the safe end.

An actuator (a module in actuators/) drives channels under a law. The
harness holds the contract of a controller:

1. The handlers of SIGTERM and SIGINT only set a flag. The actuator calls
   check() and wait() between device calls, so a call in progress ends
   before the safe action. A wait sleeps in slices of 50 ms.
2. Exit 0 means safe: every channel that this process holds is off. An
   error makes the channels safe if it can, and exits 1.
3. The process takes the drive lock of its channel without waiting. A busy
   lock logs gave_up with the holder, and touches nothing.
4. The event log is one JSON line for each event. ACTUATOR_EVENTS names the
   file, else it is events.jsonl in the working directory.

The claims in a state event are acting, reached, holding, stopping, safe,
and gave_up. finally.py makes the channels safe after an unclean end.
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
        self.latest = None  # the last (channel, reading, setting)
        self.pending = False  # the latest values are not in the log yet
        self.logged_at = None

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

    def _pair(self):
        channel, reading, setting = self.latest
        self.emit("observe", channel=channel, voltage=reading.voltage, current=reading.current, power=reading.power)
        self.emit("drive", channel=channel, voltage=setting.voltage, current=setting.current, output="on" if setting.on else "off")
        self.pending = False
        self.logged_at = time.monotonic()

    def record(self, channel, reading, setting):
        """Keep the latest values. Log them once for each interval."""
        self.latest = (channel, reading, setting)
        self.pending = True
        if self.logged_at is None or time.monotonic() - self.logged_at >= self.interval:
            self._pair()

    def claim(self, value, note=None):
        """Log a claim when it changes, with the latest values beside it."""
        if self.claimed == value:
            return
        self.claimed = value
        self.emit("state", value=value, **({"note": note} if note else {}))
        if self.pending and value != "safe":
            self._pair()

    def safe(self, guard, channels):
        """Turn off the channels that this process holds, log their drive lines, and return the channels that stay on."""
        settings = guard.off(channels)
        for channel, setting in settings.items():
            self.emit("drive", channel=channel, voltage=setting.voltage, current=setting.current, output="on" if setting.on else "off")
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


def run(actuator, args, body):
    """Run body(control, guard, args) as a controller, and return the exit code.

    args holds config, sim, and channel. The harness sets args.channel to the
    channel that it drives.
    """
    control = Controller(actuator)
    control.install()
    try:
        config = load_config(args.config)
        if args.sim:
            config["driver"] = "sim"
        args.channel = choose_channel(list(config["channels"]), args.channel)
    except SupplyError as error:
        print(f"{actuator}: {error}", file=sys.stderr)
        return 1
    try:
        locks = hold_drive_locks(config, [args.channel], actuator)
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
