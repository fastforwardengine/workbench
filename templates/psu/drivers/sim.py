"""A simulated supply with several channels, and no hardware.

The state lives in a JSON file. Every call reloads the file, and replaces
it with a temporary file and a rename. A lock file beside it orders the
calls, so several processes share one simulated supply. Each channel has a
load. The "sim" section of psu.json names the state file and the loads:

    "sim": {"state": "sim.json", "loads": {"ch2": {"kind": "diode", "forward_voltage": 2.0, "ohms": 10}}}

A resistor load is the default, 100 ohm. A channel holds constant voltage
until the current limit, and then holds constant current. The state keeps
each write, in order, so a test can check the order of a change.
"""

import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path

from . import ChannelRating, Description, Reading, Settings, SupplyError

DEFAULT_LOAD = {"kind": "resistor", "ohms": 100.0}
DEFAULT_CHANNELS = ["ch1", "ch2"]
RATED_V, RATED_I = 30.0, 10.0
MAX_OVP, MAX_OCP = 33.0, 10.5


def demand(load, volts):
    """The current that the load draws at the given voltage."""
    if load["kind"] == "diode":
        return 0.0 if volts <= load["forward_voltage"] else (volts - load["forward_voltage"]) / load["ohms"]
    return volts / load["ohms"]


def limited_voltage(load, amps):
    """The voltage across the load at the given current."""
    offset = load["forward_voltage"] if load["kind"] == "diode" else 0.0
    return offset + amps * load["ohms"]


class Sim:
    def __init__(self, path, channels=None, loads=None):
        self.path = Path(path)
        self.channels = list(channels or DEFAULT_CHANNELS)
        self.loads = {name: {**DEFAULT_LOAD, **(loads or {}).get(name, {})} for name in self.channels}
        for name, load in self.loads.items():
            if load["kind"] not in ("resistor", "diode") or load["ohms"] <= 0:
                raise SupplyError(f"The load of {name} is wrong: {load}.")

    @classmethod
    def from_config(cls, config, state_path=None):
        section = config.get("sim", {})
        path = state_path or section.get("state")
        if not path:
            raise SupplyError('The sim driver needs a state file: use --sim FILE, or "sim": {"state": FILE} in the config.')
        return cls(path, list(config.get("channels", DEFAULT_CHANNELS)), section.get("loads"))

    def _new_channel(self):
        return {"voltage": 0.0, "current": 0.0, "on": False, "ovp": MAX_OVP, "ocp": MAX_OCP, "tripped": []}

    def _load(self):
        state = json.loads(self.path.read_text()) if self.path.exists() else {}
        channels = state.setdefault("channels", {})
        for name in self.channels:
            channels.setdefault(name, self._new_channel())
        state.setdefault("writes", [])
        return state

    def _save(self, state):
        temporary = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(state, indent=1))
        os.replace(temporary, self.path)

    def _operate(self, name, channel):
        """The voltage, the current, and the mode of one channel."""
        if not channel["on"]:
            return 0.0, 0.0, None
        load = self.loads[name]
        amps = demand(load, channel["voltage"])
        if amps <= channel["current"]:
            return channel["voltage"], amps, "cv"
        return limited_voltage(load, channel["current"]), channel["current"], "cc"

    def _settle(self, state):
        """A channel trips when its output passes its OVP or OCP. The output turns off."""
        for name in self.channels:
            channel = state["channels"][name]
            volts, amps, _ = self._operate(name, channel)
            for label, over in (("OVP", volts > channel["ovp"]), ("OCP", amps > channel["ocp"])):
                if over and label not in channel["tripped"]:
                    channel["on"] = False
                    channel["tripped"].append(label)

    @contextmanager
    def _session(self):
        with open(f"{self.path}.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = self._load()
            before = json.dumps(state, sort_keys=True)
            yield state
            self._settle(state)
            if json.dumps(state, sort_keys=True) != before:
                self._save(state)

    def _known(self, channel):
        if channel not in self.channels:
            raise SupplyError(f"The simulated supply has no channel {channel}. It has: {', '.join(self.channels)}.")

    def describe(self):
        rating = ChannelRating(RATED_V, RATED_I, 0.001, 0.001)
        return Description(
            model=f"Simulated supply, {len(self.channels)} channels",
            channels={name: rating for name in self.channels},
            capabilities=frozenset({"ovp", "ocp", "mode"}),
            measure_seconds=0.0,
            refresh_hz=None,
        )

    def measure(self):
        with self._session() as state:
            found = {}
            for name in self.channels:
                volts, amps, _ = self._operate(name, state["channels"][name])
                found[name] = Reading(round(volts, 6), round(amps, 6), round(volts * amps, 6))
            return found

    def settings(self):
        with self._session() as state:
            found = {}
            for name in self.channels:
                channel = state["channels"][name]
                found[name] = Settings(
                    voltage=channel["voltage"],
                    current=channel["current"],
                    on=channel["on"],
                    mode=self._operate(name, channel)[2],
                    tripped=list(channel["tripped"]),
                    ovp=channel["ovp"],
                    ocp=channel["ocp"],
                )
            return found

    def set(self, channel, voltage=None, current=None):
        self._known(channel)
        with self._session() as state:
            for key, value in (("voltage", voltage), ("current", current)):
                if value is not None:
                    state["channels"][channel][key] = value
                    state["writes"].append([channel, key, value])

    def output(self, channel, on):
        self._known(channel)
        with self._session() as state:
            state["channels"][channel]["on"] = bool(on)
            if on:
                state["channels"][channel]["tripped"] = []
            state["writes"].append([channel, "output", 1 if on else 0])

    def off(self, channels=None):
        names = channels or self.channels
        for name in names:
            self._known(name)
        with self._session() as state:
            for name in names:
                if state["channels"][name]["on"]:
                    state["channels"][name]["on"] = False
                    state["writes"].append([name, "output", 0])

    def protect(self, channel, ovp=None, ocp=None):
        self._known(channel)
        with self._session() as state:
            for key, value in (("ovp", ovp), ("ocp", ocp)):
                if value is not None:
                    state["channels"][channel][key] = value
                    state["writes"].append([channel, key, value])

    def read_raw(self, first, count):
        raise SupplyError("The simulated supply has no registers.")

    def close(self):
        pass
