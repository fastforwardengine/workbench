#!/usr/bin/env python3
"""Control a HANMATEK HM310P DC power supply over USB (Modbus RTU).

    python3 psu.py info
    python3 psu.py status
    python3 psu.py measure --count 10 --interval 0.5 --csv
    python3 psu.py set --voltage 3.30 --current 0.100
    python3 psu.py output on
    python3 psu.py output off
    python3 psu.py protect --ovp 5 --ocp 0.5 --opp 2.5
    python3 psu.py preset show
    python3 psu.py preset set 1 --voltage 3.3 --current 0.1
    python3 psu.py buzzer off
    python3 psu.py read 0x0010 4
    python3 psu.py --sim sim.json status          # a simulated supply, no hardware

The supply speaks Modbus RTU at 9600 baud, 8N1, address 1, over its CH340
USB-serial chip. docs/registers.md holds the register map and what each
entry rests on. The tool refuses a setpoint, a preset, or a protection limit
above limits.json: a voltage above max_voltage, a current above max_current,
or a power above max_power. The supply's own OVP and OCP act only when the
panel arms them.
"""

import argparse
import json
import os
import struct
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The registers of the supply, from docs/registers.md.
OUTPUT, PROTECT, MODEL, TAIL, DECIMALS = 0x0001, 0x0002, 0x0003, 0x0004, 0x0005
DISPLAY_V, DISPLAY_I, DISPLAY_P = 0x0010, 0x0011, 0x0012  # P: two registers, high word first
OVP, OCP, OPP = 0x0020, 0x0021, 0x0022  # OPP: two registers, high word first
SET_V, SET_I = 0x0030, 0x0031
BUZZER = 0x8804
ADDRESS = 0x9999
PRESET_BASE, PRESET_STEP, PRESETS = 0x1000, 0x10, 6

# The model register of the HM310P, and its decimal places: V 2, A 3, W 3.
HM310P_MODEL, HM310P_DECIMALS = 3010, 0x0233
# The ratings of the supply, and the range of each protection limit.
RATED_V, RATED_I = 30.0, 10.0
MAX_OVP, MAX_OCP, MAX_OPP = 33.0, 10.5, 310.0

PROTECTION_BITS = ["OVP", "OCP", "OPP", "OTP", "SCP"]


class SupplyError(Exception):
    """A refusal or a fault that the tool reports and does not retry."""


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return struct.pack("<H", crc)


class SerialBus:
    """Modbus RTU over the serial port: function codes 3, 6, and 16."""

    def __init__(self, port, address, attempts=3):
        import serial  # pyserial, only for real hardware

        self.serial = serial.Serial(port, 9600, bytesize=8, parity="N", stopbits=1, timeout=0.5)
        self.address = address
        self.attempts = attempts

    def _exchange(self, frame, length):
        answer = b""
        for _ in range(self.attempts):
            self.serial.reset_input_buffer()
            self.serial.write(frame + crc16(frame))
            answer = self.serial.read(length)
            # The supply needs a pause between two frames.
            time.sleep(0.05)
            if len(answer) >= 5 and answer[1] & 0x80 and crc16(answer[:3]) == answer[3:5]:
                raise SupplyError(f"The supply refused function {frame[1]}: Modbus exception {answer[2]}.")
            if len(answer) == length and crc16(answer[:-2]) == answer[-2:]:
                return answer
        raise SupplyError(f"No valid answer from the supply at address {self.address} (last: {answer.hex() or 'nothing'}).")

    def read(self, first, count=1):
        answer = self._exchange(struct.pack(">BBHH", self.address, 3, first, count), 5 + 2 * count)
        return list(struct.unpack(f">{count}H", answer[3:-2]))

    def write(self, register, value):
        frame = struct.pack(">BBHH", self.address, 6, register, value)
        if self._exchange(frame, 8)[:6] != frame:
            raise SupplyError(f"The supply did not confirm the write to {register:#06x}.")

    def write_many(self, first, values):
        frame = struct.pack(f">BBHHB{len(values)}H", self.address, 16, first, len(values), 2 * len(values), *values)
        self._exchange(frame, 8)

    def close(self):
        self.serial.close()


class SimulatedBus:
    """A simulated HM310P with a resistor on its output. The state persists in a JSON file."""

    DEFAULTS = {
        f"{OUTPUT}": 0, f"{PROTECT}": 0, f"{MODEL}": HM310P_MODEL, f"{TAIL}": 19280,
        f"{DECIMALS}": HM310P_DECIMALS, f"{OVP}": 3300, f"{OCP}": 10500, f"{OPP}": 4, f"{OPP + 1}": 47856,
        f"{SET_V}": 100, f"{SET_I}": 200, f"{BUZZER}": 0, f"{ADDRESS}": 1,
    }
    # The presets that a real unit held: voltage, current, time, and enable.
    PRESET_DEFAULTS = [
        (320, 1010, 10, 1),
        (960, 3030, 11, 1),
        (1600, 5050, 12, 1),
        (2240, 7070, 13, 1),
        (2880, 9090, 14, 1),
        (3200, 10100, 15, 1),
    ]

    def __init__(self, path, load_ohms=100.0):
        self.path = Path(path)
        state = json.loads(self.path.read_text()) if self.path.exists() else {}
        presets = {
            f"{PRESET_BASE + PRESET_STEP * n + k}": value
            for n, values in enumerate(self.PRESET_DEFAULTS)
            for k, value in enumerate(values)
        }
        self.registers = {**self.DEFAULTS, **presets, **state.get("registers", {})}
        self.load_ohms = state.get("load_ohms", load_ohms)
        # Each write, in order, so a test can check the order of a change.
        self.writes = state.get("writes", [])

    def _output(self):
        """Constant voltage until the current limit, then constant current."""
        if not self.registers[f"{OUTPUT}"]:
            return 0, 0, 0
        volts, amps = self.registers[f"{SET_V}"] / 100, self.registers[f"{SET_I}"] / 1000
        current = min(volts / self.load_ohms, amps)
        volts = current * self.load_ohms
        return round(volts * 100), round(current * 1000), round(volts * current * 1000)

    def read(self, first, count=1):
        volts, amps, watts = self._output()
        live = {DISPLAY_V: volts, DISPLAY_I: amps, DISPLAY_P: watts >> 16, DISPLAY_P + 1: watts & 0xFFFF}
        return [live.get(first + k, self.registers.get(f"{first + k}", 0)) for k in range(count)]

    def write(self, register, value):
        self.registers[f"{register}"] = value
        self.writes.append([register, value])
        self._save()

    def write_many(self, first, values):
        for k, value in enumerate(values):
            self.registers[f"{first + k}"] = value
            self.writes.append([first + k, value])
        self._save()

    def _save(self):
        state = {"load_ohms": self.load_ohms, "registers": self.registers, "writes": self.writes}
        self.path.write_text(json.dumps(state, indent=1))

    def close(self):
        pass


class Supply:
    """The HM310P in engineering units, with the limits of limits.json."""

    def __init__(self, bus, limits):
        self.bus = bus
        self.limits = limits

    def check_model(self):
        model, _, decimals = self.bus.read(MODEL, 3)
        if model != HM310P_MODEL or decimals != HM310P_DECIMALS:
            raise SupplyError(f"This is not an HM310P: model {model}, decimals {decimals:#06x}.")

    def info(self):
        model, tail, decimals = self.bus.read(MODEL, 3)
        return {"model": model, "tail": tail, "decimals": f"{decimals:#06x}", "address": self.bus.read(ADDRESS)[0]}

    def measure(self):
        volts, amps, high, low = self.bus.read(DISPLAY_V, 4)
        return {"voltage": volts / 100, "current": amps / 1000, "power": ((high << 16) | low) / 1000}

    def protection_state(self):
        bits = self.bus.read(PROTECT)[0]
        return {name: bool(bits >> n & 1) for n, name in enumerate(PROTECTION_BITS)}

    def setpoints(self):
        volts, amps = self.bus.read(SET_V, 2)
        return {"voltage": volts / 100, "current": amps / 1000}

    def protection_limits(self):
        ovp, ocp, high, low = self.bus.read(OVP, 4)
        # OPP: 3 decimals. The factory value 310000 reads as 310 W, above the 300 W rating.
        return {"ovp": ovp / 100, "ocp": ocp / 1000, "opp": ((high << 16) | low) / 1000}

    def status(self):
        return {
            "output": "on" if self.bus.read(OUTPUT)[0] else "off",
            "tripped": [name for name, on in self.protection_state().items() if on],
            "setpoints": self.setpoints(),
            "measured": self.measure(),
            "protection_limits": self.protection_limits(),
            "limits": self.limits,
        }

    def _within(self, value, name, ceiling, unit):
        if value < 0:
            raise SupplyError(f"{name} must not be negative.")
        if value > ceiling:
            raise SupplyError(f"{name} {value:g} {unit} is above the limit {ceiling:g} {unit} of limits.json.")

    def _check_pair(self, volts, amps, what):
        """Refuse a voltage, a current, or their product above limits.json."""
        self._within(volts, f"{what}: the voltage", min(self.limits["max_voltage"], RATED_V), "V")
        self._within(amps, f"{what}: the current", min(self.limits["max_current"], RATED_I), "A")
        self._within(volts * amps, f"{what}: the power", self.limits["max_power"], "W")

    def set(self, voltage=None, current=None):
        now = self.setpoints()
        volts = now["voltage"] if voltage is None else voltage
        amps = now["current"] if current is None else current
        self._check_pair(volts, amps, "The setpoints")
        # One register changes at a time. When the voltage rises, the current
        # goes first, so the state between the two writes stays at or below the
        # old or the new setpoints, and so within limits.json.
        writes = []
        if voltage is not None:
            writes.append((SET_V, round(voltage * 100)))
        if current is not None:
            writes.append((SET_I, round(current * 1000)))
        if voltage is not None and voltage > now["voltage"]:
            writes.reverse()
        for register, value in writes:
            self.bus.write(register, value)
        return self.setpoints()

    def output(self, on):
        if on:
            self.set()  # the present setpoints must be within the limits
        self.bus.write(OUTPUT, 1 if on else 0)
        return "on" if self.bus.read(OUTPUT)[0] else "off"

    def protect(self, ovp=None, ocp=None, opp=None):
        # A protection limit trips at or before the limit of limits.json.
        if ovp is not None:
            self._within(ovp, "OVP", min(self.limits["max_voltage"], MAX_OVP), "V")
        if ocp is not None:
            self._within(ocp, "OCP", min(self.limits["max_current"], MAX_OCP), "A")
        if opp is not None:
            self._within(opp, "OPP", min(self.limits["max_power"], MAX_OPP), "W")
        if ovp is not None:
            self.bus.write(OVP, round(ovp * 100))
        if ocp is not None:
            self.bus.write(OCP, round(ocp * 1000))
        if opp is not None:
            raw = round(opp * 1000)
            self.bus.write_many(OPP, [raw >> 16, raw & 0xFFFF])
        return self.protection_limits()

    def presets(self):
        found = []
        for n in range(PRESETS):
            volts, amps, span, enabled = self.bus.read(PRESET_BASE + PRESET_STEP * n, 4)
            found.append({"preset": n + 1, "voltage": volts / 100, "current": amps / 1000, "time": span, "enabled": enabled})
        return found

    def set_preset(self, number, voltage=None, current=None):
        if not 1 <= number <= PRESETS:
            raise SupplyError(f"The supply has presets 1 to {PRESETS}.")
        base = PRESET_BASE + PRESET_STEP * (number - 1)
        stored = self.presets()[number - 1]
        # The panel can recall the preset, so the whole preset must be within
        # limits.json: the new values, and the stored values it keeps.
        volts = stored["voltage"] if voltage is None else voltage
        amps = stored["current"] if current is None else current
        self._check_pair(volts, amps, f"Preset {number}")
        if voltage is not None:
            self.bus.write(base, round(voltage * 100))
        if current is not None:
            self.bus.write(base + 1, round(current * 1000))
        return self.presets()[number - 1]

    def buzzer(self, on):
        self.bus.write(BUZZER, 1 if on else 0)
        return "on" if self.bus.read(BUZZER)[0] else "off"


def number(text):
    return int(text, 0)


def parser():
    top = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    top.add_argument("--port", default=os.environ.get("PSU_PORT", "/dev/ttyUSB0"), help="the serial port (PSU_PORT)")
    top.add_argument("--address", type=int, default=1, help="the Modbus address of the supply")
    top.add_argument("--limits", default=str(HERE / "limits.json"), help="the file of the software limits")
    top.add_argument("--sim", metavar="FILE", help="use a simulated supply, with its state in FILE")
    top.add_argument("--json", action="store_true", help="print JSON")
    # --json also works after the command, such as `status --json`.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print JSON")
    commands = top.add_subparsers(dest="command", required=True)
    command = commands.add_parser
    commands.add_parser = lambda *names, **options: command(*names, parents=[common], **options)
    commands.add_parser("info", help="model, decimals, and address")
    commands.add_parser("status", help="output, protection, setpoints, and readings")
    measure = commands.add_parser("measure", help="read the voltage, the current, and the power")
    measure.add_argument("--count", type=int, default=1)
    measure.add_argument("--interval", type=float, default=0.5)
    measure.add_argument("--csv", action="store_true", help="print CSV rows with a time column")
    settings = commands.add_parser("set", help="set the voltage and the current limit")
    settings.add_argument("--voltage", type=float)
    settings.add_argument("--current", type=float)
    output = commands.add_parser("output", help="turn the output on or off")
    output.add_argument("state", choices=["on", "off"])
    protect = commands.add_parser("protect", help="show or set OVP, OCP, and OPP")
    protect.add_argument("--ovp", type=float)
    protect.add_argument("--ocp", type=float)
    protect.add_argument("--opp", type=float)
    preset = commands.add_parser("preset", help="show or set the memory presets")
    preset_commands = preset.add_subparsers(dest="action", required=True)
    preset_commands.add_parser("show", parents=[common])
    preset_set = preset_commands.add_parser("set", parents=[common])
    preset_set.add_argument("number", type=int)
    preset_set.add_argument("--voltage", type=float)
    preset_set.add_argument("--current", type=float)
    buzzer = commands.add_parser("buzzer", help="turn the key beep on or off")
    buzzer.add_argument("state", choices=["on", "off"])
    address = commands.add_parser("address", help="show or change the Modbus address")
    address.add_argument("new", type=int, nargs="?")
    address.add_argument("--yes", action="store_true", help="confirm a change of address")
    read = commands.add_parser("read", help="read raw registers, such as 0x0010 4")
    read.add_argument("register", type=number)
    read.add_argument("count", type=number, nargs="?", default=1)
    return top


def run(supply, args):
    if args.command == "info":
        return supply.info()
    if args.command == "status":
        return supply.status()
    if args.command == "measure":
        return measure(supply, args)
    if args.command == "set":
        return supply.set(args.voltage, args.current)
    if args.command == "output":
        return {"output": supply.output(args.state == "on")}
    if args.command == "protect":
        return supply.protect(args.ovp, args.ocp, args.opp)
    if args.command == "preset":
        return supply.presets() if args.action == "show" else supply.set_preset(args.number, args.voltage, args.current)
    if args.command == "buzzer":
        return {"buzzer": supply.buzzer(args.state == "on")}
    if args.command == "address":
        return address(supply, args)
    return {f"{args.register + k:#06x}": value for k, value in enumerate(supply.bus.read(args.register, args.count))}


def measure(supply, args):
    rows = []
    for n in range(args.count):
        rows.append({"time": round(time.time(), 3), **supply.measure()})
        if args.csv:
            if n == 0:
                print("time,voltage,current,power")
            print(",".join(str(value) for value in rows[-1].values()), flush=True)
        if n + 1 < args.count:
            time.sleep(args.interval)
    return None if args.csv else (rows[0] if args.count == 1 else rows)


def address(supply, args):
    if args.new is None:
        return {"address": supply.bus.read(ADDRESS)[0]}
    if not 1 <= args.new <= 250:
        raise SupplyError("The address is 1 to 250.")
    if not args.yes:
        raise SupplyError("A new address changes how every later command reaches the supply. Add --yes, and then use --address.")
    supply.bus.write(ADDRESS, args.new)
    return {"address": args.new}


def show(result, as_json):
    if result is None:
        return
    if as_json or not isinstance(result, dict):
        print(json.dumps(result, indent=2))
        return
    for key, value in result.items():
        print(f"{key}: {json.dumps(value) if isinstance(value, (dict, list)) else value}")


def main(argv=None):
    args = parser().parse_args(argv)
    limits = json.loads(Path(args.limits).read_text())
    bus = None
    try:
        bus = SimulatedBus(args.sim) if args.sim else SerialBus(args.port, args.address)
        supply = Supply(bus, limits)
        supply.check_model()
        show(run(supply, args), args.json)
    except SupplyError as error:
        print(f"psu: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        # pyserial's SerialException is an OSError: a missing, busy, or lost port.
        print(f"psu: The serial port {args.port} failed: {error}", file=sys.stderr)
        return 1
    except ImportError:
        print("psu: pyserial is not installed. The workstation has it: python3-serial.", file=sys.stderr)
        return 1
    finally:
        if bus is not None:
            bus.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
