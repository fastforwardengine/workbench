"""The HANMATEK HM310P: one channel, Modbus RTU over a CH340 USB-serial chip.

docs/hm310p.md holds the register map and what each entry rests on. The
supply does not report constant voltage or constant current, so mode is None.
The supply's own OVP and OCP act only when the panel arms them.
"""

from . import ChannelRating, Description, Reading, Settings, SupplyError
from .modbus import SerialBus, find_port

# The registers of the supply, from docs/hm310p.md.
OUTPUT, PROTECT, MODEL, TAIL, DECIMALS = 0x0001, 0x0002, 0x0003, 0x0004, 0x0005
DISPLAY_V = 0x0010  # then the current, then the power: two registers, high word first
OVP, OCP = 0x0020, 0x0021
SET_V, SET_I = 0x0030, 0x0031

# The model register of the HM310P, and its decimal places: V 2, A 3, W 3.
HM310P_MODEL, HM310P_DECIMALS = 3010, 0x0233
# The ratings of the supply, and the range of each protection limit.
RATED_V, RATED_I = 30.0, 10.0
MAX_OVP, MAX_OCP = 33.0, 10.5

PROTECTION_BITS = ["OVP", "OCP", "OPP", "OTP", "SCP"]
CHANNEL = "ch1"
CH340_USB_ID = "1a86:7523"


class Hm310p:
    """The HM310P over a bus object with read, write, write_many, and close."""

    def __init__(self, bus):
        self.bus = bus

    @classmethod
    def from_config(cls, config, state_path=None):
        transport = config.get("transport", {})
        port = transport.get("port") or find_port(transport.get("usb_id", CH340_USB_ID))
        return cls(SerialBus(port, transport.get("address", 1)))

    def _channel(self, channel):
        if channel != CHANNEL:
            raise SupplyError(f"The HM310P has one channel, {CHANNEL}. There is no {channel}.")

    def describe(self):
        model, tail, decimals = self.bus.read(MODEL, 3)
        if model != HM310P_MODEL or decimals != HM310P_DECIMALS:
            raise SupplyError(f"This is not an HM310P: model {model}, decimals {decimals:#06x}.")
        return Description(
            model=f"HM310P (model {model}, tail {tail})",
            channels={CHANNEL: ChannelRating(RATED_V, RATED_I, 0.01, 0.001)},
            capabilities=frozenset({"ovp", "ocp", "raw"}),
            measure_seconds=0.075,
            refresh_hz=None,
        )

    def measure(self):
        volts, amps, high, low = self.bus.read(DISPLAY_V, 4)
        return {CHANNEL: Reading(volts / 100, amps / 1000, ((high << 16) | low) / 1000)}

    def settings(self):
        # OUTPUT and PROTECT are neighbours, so one exchange reads both.
        on, bits = self.bus.read(OUTPUT, 2)
        volts, amps = self.bus.read(SET_V, 2)
        ovp, ocp = self.bus.read(OVP, 2)
        return {
            CHANNEL: Settings(
                voltage=volts / 100,
                current=amps / 1000,
                on=bool(on),
                mode=None,
                tripped=[name for n, name in enumerate(PROTECTION_BITS) if bits >> n & 1],
                ovp=ovp / 100,
                ocp=ocp / 1000,
            )
        }

    def set(self, channel, voltage=None, current=None):
        self._channel(channel)
        if voltage is not None:
            self.bus.write(SET_V, round(voltage * 100))
        if current is not None:
            self.bus.write(SET_I, round(current * 1000))

    def output(self, channel, on):
        self._channel(channel)
        self.bus.write(OUTPUT, 1 if on else 0)

    def off(self, channels=None):
        for channel in channels or [CHANNEL]:
            self._channel(channel)
        self.bus.write(OUTPUT, 0)

    def protect(self, channel, ovp=None, ocp=None):
        self._channel(channel)
        if ovp is not None and not 0 <= ovp <= MAX_OVP:
            raise SupplyError(f"The OVP of the HM310P is 0 to {MAX_OVP:g} V.")
        if ocp is not None and not 0 <= ocp <= MAX_OCP:
            raise SupplyError(f"The OCP of the HM310P is 0 to {MAX_OCP:g} A.")
        if ovp is not None:
            self.bus.write(OVP, round(ovp * 100))
        if ocp is not None:
            self.bus.write(OCP, round(ocp * 1000))

    def read_raw(self, first, count):
        return self.bus.read(first, count)

    def close(self):
        self.bus.close()
