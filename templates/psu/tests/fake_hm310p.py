"""A register-level fake of the HM310P. It stands in for the serial bus in tests."""

from drivers.hm310p import (
    DECIMALS, DISPLAY_V, HM310P_DECIMALS, HM310P_MODEL, MODEL, OCP, OUTPUT, OVP, PROTECT, SET_I, SET_V, TAIL,
)

DISPLAY_P = DISPLAY_V + 2


class FakeBus:
    """A simulated HM310P with a resistor on its output. It keeps each write, in order."""

    def __init__(self, load_ohms=100.0):
        self.registers = {
            OUTPUT: 0, PROTECT: 0, MODEL: HM310P_MODEL, TAIL: 19280, DECIMALS: HM310P_DECIMALS,
            OVP: 3300, OCP: 10500, SET_V: 0, SET_I: 0,
        }
        self.load_ohms = load_ohms
        self.writes = []

    def _output(self):
        """Constant voltage until the current limit, then constant current."""
        if not self.registers[OUTPUT]:
            return 0, 0, 0
        volts, amps = self.registers[SET_V] / 100, self.registers[SET_I] / 1000
        current = min(volts / self.load_ohms, amps)
        volts = current * self.load_ohms
        return round(volts * 100), round(current * 1000), round(volts * current * 1000)

    def read(self, first, count=1):
        volts, amps, watts = self._output()
        live = {DISPLAY_V: volts, DISPLAY_V + 1: amps, DISPLAY_P: watts >> 16, DISPLAY_P + 1: watts & 0xFFFF}
        return [live.get(first + k, self.registers.get(first + k, 0)) for k in range(count)]

    def write(self, register, value):
        self.registers[register] = value
        self.writes.append((register, value))

    def write_many(self, first, values):
        for k, value in enumerate(values):
            self.write(first + k, value)

    def close(self):
        pass
