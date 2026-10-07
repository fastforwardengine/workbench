"""The drivers of programmable power supplies.

A driver speaks to one supply in engineering units: volts, amperes, watts.
A driver knows nothing about limits or locks. guard.py holds both.

To add a driver, write one file in this directory, and register it in
DRIVERS below. Then add it to the driver suite in tests/test_drivers.py.
"""

import importlib
from dataclasses import dataclass, field
from typing import Protocol

# The capabilities that a driver names in Description.capabilities.
CAPABILITIES = {
    "ovp": "set an over-voltage protection limit",
    "ocp": "set an over-current protection limit",
    "raw": "read raw registers",
    "mode": "report constant voltage or constant current",
}


class SupplyError(Exception):
    """A refusal or a fault that the tool reports and does not retry."""


@dataclass(frozen=True)
class ChannelRating:
    """What one channel can do, from the hardware. Steps are the finest change."""

    max_voltage: float
    max_current: float
    voltage_step: float
    current_step: float


@dataclass(frozen=True)
class Description:
    """What a supply is. measure_seconds is the time of one measure call."""

    model: str
    channels: dict[str, ChannelRating]
    capabilities: frozenset[str]
    measure_seconds: float
    refresh_hz: float | None = None


@dataclass(frozen=True)
class Reading:
    voltage: float
    current: float
    power: float


@dataclass
class Settings:
    """The setpoints and the state of one channel. mode is None when the supply does not report it."""

    voltage: float
    current: float
    on: bool
    mode: str | None = None
    tripped: list[str] = field(default_factory=list)
    ovp: float | None = None
    ocp: float | None = None


class Driver(Protocol):
    """The calls that guard.py makes. Every channel id is a key of describe().channels."""

    def describe(self) -> Description: ...

    def measure(self) -> dict[str, Reading]:
        """Read every channel in one call."""
        ...

    def settings(self) -> dict[str, Settings]: ...

    def set(self, channel: str, voltage: float | None = None, current: float | None = None) -> None:
        """Write the given values, the voltage first. A value of None stays as it is."""
        ...

    def output(self, channel: str, on: bool) -> None: ...

    def off(self, channels: list[str] | None = None) -> None:
        """Turn the outputs off. Safe to call twice. Needs no state from an earlier process."""
        ...

    def protect(self, channel: str, ovp: float | None = None, ocp: float | None = None) -> None:
        """Only with the capability "ovp" or "ocp"."""
        ...

    def read_raw(self, first: int, count: int) -> list[int]:
        """Only with the capability "raw"."""
        ...

    def close(self) -> None: ...


# The registry: the driver name, then the module in this package and the class.
DRIVERS = {
    "hm310p": ("hm310p", "Hm310p"),
    "sim": ("sim", "Sim"),
}


def open_driver(config, state_path=None):
    """Open the driver that config names. A state_path selects the simulator."""
    name = "sim" if state_path else config.get("driver")
    if name not in DRIVERS:
        raise SupplyError(f"The driver {name!r} does not exist. The drivers are: {', '.join(sorted(DRIVERS))}.")
    module, class_name = DRIVERS[name]
    driver_class = getattr(importlib.import_module(f".{module}", __name__), class_name)
    return driver_class.from_config(config, state_path)
