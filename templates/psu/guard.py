"""The guard: limits and locks around any driver.

The guard reads psu.json and enforces its limits on every call. The limit
of a channel is the smaller of the value in psu.json and the rating of the
driver. Power is the voltage times the current.

Two kinds of lock keep several processes apart. Both use fcntl.flock on a
file in the lock directory.

- The bus lock `<name>.bus` orders the calls to the driver. A call waits
  for it.
- The drive lock `<name>.<channel>.drive` names the one process that
  changes a channel. A call that writes a setpoint or turns an output on
  refuses at once when another process holds the lock. off() takes no drive
  lock, so off always works.

The lock directory is the PSU_LOCK_DIR variable, else /run/lock when the
user can write there, else /tmp. Every account opens the same lock files,
so each lock file is readable and writable by all accounts.
"""

import fcntl
import json
import math
import os
import re
import time
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path

from drivers import SupplyError

NAME = re.compile(r"^[a-z][a-z0-9-]*$")
# A channel is in constant current when its current is within this part of its limit.
CC_BAND = 0.02
EPSILON = 1e-9


def load_config(path):
    """Read psu.json, and check the parts that the guard needs."""
    try:
        config = json.loads(Path(path).read_text())
    except OSError as error:
        raise SupplyError(f"The config {path} cannot be read: {error.strerror}.") from error
    except ValueError as error:
        raise SupplyError(f"The config {path} is not valid JSON: {error}.") from error
    if not isinstance(config.get("name"), str) or not NAME.match(config["name"]):
        raise SupplyError(f"The name in {path} must match {NAME.pattern}.")
    channels = config.get("channels")
    if not isinstance(channels, dict) or not channels:
        raise SupplyError(f"{path} must list at least one channel in channels.")
    for channel, limits in channels.items():
        if not isinstance(limits, dict):
            raise SupplyError(f"The channel {channel} in {path} must be an object.")
        for key in ("max_voltage", "max_current", "max_power"):
            if key == "max_power" and key not in limits:
                continue
            value = limits.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise SupplyError(f"The channel {channel} in {path} needs a number for {key}.")
    return config


def lock_directory():
    """The directory of the lock files."""
    chosen = os.environ.get("PSU_LOCK_DIR")
    if chosen:
        os.makedirs(chosen, exist_ok=True)
        return chosen
    return "/run/lock" if os.access("/run/lock", os.W_OK) else "/tmp"


def natural(channel):
    """A sort key that puts ch2 before ch10."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", channel)]


def _open_lock(path):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        # The umask removes bits at creation. Another account must open the file too.
        os.fchmod(descriptor, 0o666)
    except OSError:
        pass  # the file belongs to another account, which set its mode
    return descriptor


class DriveLocks:
    """The drive locks of one supply. A process that holds one is the actuator of the channel."""

    def __init__(self, directory, name, actuator="psu.py"):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.name = name
        self.actuator = actuator
        self.held = {}

    def path(self, channel):
        return self.directory / f"{self.name}.{channel}.drive"

    def holder(self, channel):
        """The holder information in the lock file, or None."""
        try:
            return json.loads(self.path(channel).read_text().strip().splitlines()[0])
        except (OSError, ValueError, IndexError):
            return None

    def holds(self, channel):
        return channel in self.held

    def _refusal(self, channel):
        who = self.holder(channel)
        if not who:
            return f"The channel {channel} is driven by another process."
        return f"The channel {channel} is driven by {who.get('actuator')} (pid {who.get('pid')}, since {who.get('started')})."

    def acquire(self, channels, actuator=None):
        """Take the drive lock of each channel, in channel order, without waiting. Take all or none."""
        taken = []
        for channel in sorted(channels, key=natural):
            if self.holds(channel):
                continue
            descriptor = _open_lock(self.path(channel))
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(descriptor)
                self._release(taken)
                raise SupplyError(self._refusal(channel)) from None
            info = {"actuator": actuator or self.actuator, "pid": os.getpid(), "started": time.strftime("%Y-%m-%dT%H:%M:%S")}
            os.ftruncate(descriptor, 0)
            os.write(descriptor, (json.dumps(info) + "\n").encode())
            self.held[channel] = descriptor
            taken.append(channel)

    def _release(self, channels):
        for channel in channels:
            descriptor = self.held.pop(channel)
            os.ftruncate(descriptor, 0)
            os.close(descriptor)  # closing the descriptor releases the lock

    def release(self):
        self._release(list(self.held))

    @contextmanager
    def hold(self, channels, actuator=None):
        """Hold the drive locks for the block. A channel that this object already holds stays held."""
        before = set(self.held)
        self.acquire(channels, actuator)
        try:
            yield
        finally:
            self._release([channel for channel in self.held if channel not in before])


def hold_drive_locks(config, channels=None, actuator="start"):
    """Take the drive locks of a controller, and return the DriveLocks object.

    The `start` script calls this once. The locks stay until the process
    exits or calls release(). Pass the object to Guard as locks, so the guard
    of the same process does not refuse its own writes.
    """
    locks = DriveLocks(lock_directory(), config["name"], actuator)
    locks.acquire(channels or list(config["channels"]), actuator)
    return locks


class Guard:
    def __init__(self, driver, config, locks=None, actuator="psu.py"):
        self.driver = driver
        self.config = config
        self.name = config["name"]
        self.actuator = actuator
        self.bus_path = Path(lock_directory()) / f"{self.name}.bus"
        self.locks = locks or DriveLocks(lock_directory(), self.name, actuator)
        self._depth = 0
        self._descriptor = None
        self.description = self._call(self.driver.describe)
        self.channels = list(config["channels"])
        for channel in self.channels:
            if channel not in self.description.channels:
                raise SupplyError(f"psu.json names the channel {channel}. The supply has: {', '.join(self.description.channels)}.")

    @contextmanager
    def _bus(self):
        """The bus lock. A nested use in one Guard keeps the lock it has."""
        if self._depth == 0:
            descriptor = _open_lock(self.bus_path)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            except OSError:
                os.close(descriptor)
                raise
            self._descriptor = descriptor
        self._depth += 1
        try:
            yield
        finally:
            self._depth -= 1
            if self._depth == 0:
                os.close(self._descriptor)

    def _call(self, function, *args, **kwargs):
        with self._bus():
            return function(*args, **kwargs)

    def known(self, channel):
        if channel not in self.channels:
            raise SupplyError(f"There is no channel {channel} in psu.json. The channels are: {', '.join(self.channels)}.")

    def _need(self, capability, what):
        if capability not in self.description.capabilities:
            raise SupplyError(f"The driver for {self.description.model} cannot {what}.")

    def limit(self, channel, key):
        """The limit and its source: the smaller of psu.json and the rating."""
        self.known(channel)
        rating = self.description.channels[channel]
        configured = self.config["channels"][channel]
        if key == "max_power":
            return configured.get("max_power", rating.max_voltage * rating.max_current), "psu.json"
        rated = getattr(rating, key)
        if configured[key] <= rated:
            return configured[key], "psu.json"
        return rated, "the rating of the supply"

    def limits(self, channel):
        return {key: self.limit(channel, key)[0] for key in ("max_voltage", "max_current", "max_power")}

    def _within(self, channel, value, key, name, unit, what):
        ceiling, source = self.limit(channel, key)
        if not math.isfinite(value):
            raise SupplyError(f"{what} of {channel}: the {name} must be a finite number.")
        if value < 0:
            raise SupplyError(f"{what} of {channel}: the {name} must not be negative.")
        if value > ceiling + EPSILON:
            raise SupplyError(f"{what} of {channel}: the {name} {value:g} {unit} is above the limit {ceiling:g} {unit} of {source}.")

    def quantize(self, channel, value, step_key):
        """The value that the supply will hold: the nearest step of its register.

        The guard checks this value, so rounding cannot carry a setpoint one
        step above its limit.
        """
        step = getattr(self.description.channels[channel], step_key)
        if value is None or not step or not math.isfinite(value):
            return value
        return round(round(value / step) * step, 9)

    def _check_pair(self, channel, volts, amps, what):
        """Refuse a voltage, a current, or their product above the limits."""
        self._within(channel, volts, "max_voltage", "voltage", "V", what)
        self._within(channel, amps, "max_current", "current", "A", what)
        self._within(channel, volts * amps, "max_power", "power", "W", what)

    def check(self, channel, voltage, current):
        """Refuse a voltage and a current that break the limits. It writes nothing."""
        self.known(channel)
        self._check_pair(channel, voltage, current, "The target")

    def mode(self, setting, reading):
        """The mode of a channel: from the driver, else derived from the current."""
        if setting.mode is not None:
            return setting.mode
        if not setting.on:
            return None
        near = setting.current > 0 and reading.current >= setting.current * (1 - CC_BAND)
        return "cc" if near else "cv"

    def describe(self):
        return self.description

    def measure(self):
        return self._call(self.driver.measure)

    def settings(self):
        return self._call(self.driver.settings)

    def status(self, channels=None):
        """The state of each channel, as plain data."""
        with self._bus():
            readings, settings = self.driver.measure(), self.driver.settings()
        found = {}
        for channel in channels or self.channels:
            self.known(channel)
            setting, reading = settings[channel], readings[channel]
            found[channel] = {
                "output": "on" if setting.on else "off",
                "mode": self.mode(setting, reading),
                "tripped": setting.tripped,
                "setpoints": {"voltage": setting.voltage, "current": setting.current},
                "measured": asdict(reading),
                "limits": self.limits(channel),
            }
            if "ovp" in self.description.capabilities or "ocp" in self.description.capabilities:
                found[channel]["protection"] = {"ovp": setting.ovp, "ocp": setting.ocp}
        return found

    def set(self, channel, voltage=None, current=None):
        """Change the setpoints of one channel, within the limits, and return its settings."""
        self.known(channel)
        voltage = self.quantize(channel, voltage, "voltage_step")
        current = self.quantize(channel, current, "current_step")
        with self.locks.hold([channel], f"{self.actuator} set"), self._bus():
            now = self.driver.settings()[channel]
            volts = now.voltage if voltage is None else voltage
            amps = now.current if current is None else current
            self._check_pair(channel, volts, amps, "The setpoints")
            # One value changes at a time. When the voltage rises, the current
            # goes first, so the state between the two writes stays at or below
            # the old or the new setpoints, and so within the limits.
            writes = [("voltage", voltage), ("current", current)]
            if voltage is not None and voltage > now.voltage:
                writes.reverse()
            for key, value in writes:
                if value is not None:
                    self.driver.set(channel, **{key: value})
            return self.driver.settings()[channel]

    def output(self, channel, on):
        """Turn one output on or off. Turning on checks the present setpoints."""
        self.known(channel)
        if not on:
            with self._bus():
                self.driver.output(channel, False)
                return self.driver.settings()[channel]
        with self.locks.hold([channel], f"{self.actuator} output on"), self._bus():
            now = self.driver.settings()[channel]
            self._check_pair(channel, now.voltage, now.current, "The present setpoints")
            self.driver.output(channel, True)
            return self.driver.settings()[channel]

    def off(self, channels=None):
        """Turn the outputs off. It takes no drive lock: off always works."""
        names = channels or self.channels
        for channel in names:
            self.known(channel)
        with self._bus():
            self.driver.off(names)
            return {channel: setting for channel, setting in self.driver.settings().items() if channel in names}

    def protect(self, channel, ovp=None, ocp=None):
        """Set the protection limits of the supply, at or below the limits of the channel."""
        self.known(channel)
        ovp = self.quantize(channel, ovp, "voltage_step")
        ocp = self.quantize(channel, ocp, "current_step")
        if ovp is not None:
            self._need("ovp", "set an over-voltage limit")
            self._within(channel, ovp, "max_voltage", "OVP", "V", "The protection limit")
        if ocp is not None:
            self._need("ocp", "set an over-current limit")
            self._within(channel, ocp, "max_current", "OCP", "A", "The protection limit")
        with self._bus():
            self.driver.protect(channel, ovp=ovp, ocp=ocp)
            return self.driver.settings()[channel]

    def read_raw(self, first, count):
        self._need("raw", "read raw registers")
        return self._call(self.driver.read_raw, first, count)

    def close(self):
        self.driver.close()
