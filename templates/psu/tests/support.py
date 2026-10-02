"""Helpers for the tests: a lock directory, and a supply of each driver."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from drivers.hm310p import Hm310p
from drivers.sim import Sim

from .fake_hm310p import FakeBus

CONFIG_ONE = {
    "name": "psu",
    "driver": "hm310p",
    "channels": {"ch1": {"label": "radio", "max_voltage": 5.0, "max_current": 0.5, "max_power": 2.5}},
}
CONFIG_TWO = {
    "name": "psu",
    "driver": "sim",
    "channels": {
        "ch1": {"label": "radio", "max_voltage": 5.0, "max_current": 0.5, "max_power": 2.5},
        "ch2": {"label": "led", "max_voltage": 3.0, "max_current": 0.05, "max_power": 0.15},
    },
}


class Isolated(unittest.TestCase):
    """A test with its own directory, and its own lock directory in PSU_LOCK_DIR."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.locks = self.directory / "locks"
        previous = os.environ.get("PSU_LOCK_DIR")
        os.environ["PSU_LOCK_DIR"] = str(self.locks)
        self.addCleanup(lambda: os.environ.pop("PSU_LOCK_DIR", None) if previous is None else os.environ.update(PSU_LOCK_DIR=previous))
        self.state = self.directory / "sim.json"

    def sim(self, channels=("ch1", "ch2"), loads=None):
        return Sim(self.state, list(channels), loads)

    def sim_writes(self):
        if not self.state.exists():
            return []
        return [tuple(write) for write in json.loads(self.state.read_text())["writes"]]


def hm310p_factory(case):
    bus = FakeBus()
    return (lambda: Hm310p(bus)), CONFIG_ONE, bus


def sim_factory(case):
    return (lambda: Sim(case.state, list(CONFIG_TWO["channels"]))), CONFIG_TWO, None
