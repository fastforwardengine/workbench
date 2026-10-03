#!/usr/bin/env python3
"""Control a programmable power supply: one command, one action.

    python3 psu.py info
    python3 psu.py status
    python3 psu.py measure --count 10 --interval 0.5 --csv
    python3 psu.py set --channel ch1 --voltage 3.30 --current 0.100
    python3 psu.py output --channel ch1 on
    python3 psu.py output off                     # every channel off
    python3 psu.py protect --channel ch1 --ovp 5 --ocp 0.5
    python3 psu.py read 0x0010 4                  # raw registers, if the driver has them
    python3 psu.py --sim sim.json status          # a simulated supply, no hardware

psu.json names the supply, the driver, and the limits of each channel.
guard.py refuses a setpoint above them: a voltage above max_voltage, a
current above max_current, or a power above max_power. The --channel option
is optional on a supply with one channel, and required on a supply with
several. Each command takes --json.
"""

import argparse
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

from drivers import SupplyError, open_driver
from guard import Guard, choose_channel, load_config

HERE = Path(__file__).resolve().parent


def number(text):
    return int(text, 0)


def parser():
    top = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    top.add_argument("--config", default=str(HERE / "psu.json"), help="the file of the supply and its limits")
    top.add_argument("--sim", metavar="FILE", help="use the simulated supply, with its state in FILE")
    top.add_argument("--json", action="store_true", help="print JSON")
    # Each option also works after the command, such as `status --json`.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print JSON")
    channel = argparse.ArgumentParser(add_help=False, parents=[common])
    channel.add_argument("--channel", help="the channel, such as ch1")
    commands = top.add_subparsers(dest="command", required=True)
    commands.add_parser("info", parents=[common], help="the supply, its channels, and its limits")
    commands.add_parser("status", parents=[channel], help="output, mode, setpoints, and readings")
    measure = commands.add_parser("measure", parents=[channel], help="read the voltage, the current, and the power")
    measure.add_argument("--count", type=int, default=1)
    measure.add_argument("--interval", type=float, default=0.5)
    measure.add_argument("--csv", action="store_true", help="print CSV rows with a time column")
    settings = commands.add_parser("set", parents=[channel], help="set the voltage and the current limit")
    settings.add_argument("--voltage", type=float)
    settings.add_argument("--current", type=float)
    output = commands.add_parser("output", parents=[channel], help="turn an output on or off")
    output.add_argument("state", choices=["on", "off"])
    protect = commands.add_parser("protect", parents=[channel], help="show or set OVP and OCP")
    protect.add_argument("--ovp", type=float)
    protect.add_argument("--ocp", type=float)
    read = commands.add_parser("read", parents=[common], help="read raw registers, such as 0x0010 4")
    read.add_argument("first", type=number)
    read.add_argument("count", type=number, nargs="?", default=1)
    return top


def pick_channel(guard, args):
    return choose_channel(guard.channels, args.channel)


def summary(setting):
    return {"voltage": setting.voltage, "current": setting.current, "output": "on" if setting.on else "off"}


def info(guard):
    description = guard.describe()
    channels = {
        name: {**asdict(rating), "limits": guard.limits(name), "label": guard.config["channels"][name].get("label")}
        for name, rating in description.channels.items()
        if name in guard.channels
    }
    return {
        "name": guard.name,
        "driver": guard.config.get("driver"),
        "model": description.model,
        "capabilities": sorted(description.capabilities),
        "measure_seconds": description.measure_seconds,
        "refresh_hz": description.refresh_hz,
        "channels": channels,
    }


def measure(guard, args):
    names = [args.channel] if args.channel else guard.channels
    for name in names:
        guard.known(name)
    rows = []
    for n in range(args.count):
        readings = guard.measure()
        row = {"time": round(time.time(), 3), "channels": {name: asdict(readings[name]) for name in names}}
        rows.append(row)
        if args.csv:
            if n == 0:
                print("time,channel,voltage,current,power")
            for name, reading in row["channels"].items():
                print(",".join(str(value) for value in (row["time"], name, *reading.values())), flush=True)
        if n + 1 < args.count:
            time.sleep(args.interval)
    if args.csv:
        return None
    return rows[0]["channels"] if args.count == 1 else rows


def output(guard, args):
    if args.state == "off" and not args.channel:
        return {name: {"output": "on" if s.on else "off"} for name, s in guard.off().items()}
    channel = pick_channel(guard, args)
    setting = guard.output(channel, args.state == "on")
    return {channel: {"output": "on" if setting.on else "off"}}


def protect(guard, args):
    channel = pick_channel(guard, args)
    setting = guard.protect(channel, args.ovp, args.ocp)
    return {channel: {"ovp": setting.ovp, "ocp": setting.ocp}}


def run(guard, args):
    if args.command == "info":
        return info(guard)
    if args.command == "status":
        return guard.status([args.channel] if args.channel else None)
    if args.command == "measure":
        return measure(guard, args)
    if args.command == "set":
        channel = pick_channel(guard, args)
        return {channel: summary(guard.set(channel, args.voltage, args.current))}
    if args.command == "output":
        return output(guard, args)
    if args.command == "protect":
        return protect(guard, args)
    values = guard.read_raw(args.first, args.count)
    return {f"{args.first + k:#06x}": value for k, value in enumerate(values)}


def show(result, as_json):
    if result is None:
        return
    if as_json:
        print(json.dumps(result, indent=2))
        return
    if isinstance(result, list):
        # Several samples: one JSON line for each sample.
        for row in result:
            print(json.dumps(row))
        return
    for key, value in result.items():
        print(f"{key}: {json.dumps(value) if isinstance(value, (dict, list)) else value}")


def main(argv=None):
    args = parser().parse_args(argv)
    guard = None
    try:
        config = load_config(args.config)
        if args.sim:
            config["driver"] = "sim"
        guard = Guard(open_driver(config, args.sim), config)
        show(run(guard, args), args.json)
    except SupplyError as error:
        print(f"psu: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        # pyserial's SerialException is an OSError: a missing, busy, or lost port.
        print(f"psu: The supply failed: {error}", file=sys.stderr)
        return 1
    except ImportError as error:
        if error.name != "serial":
            raise
        print("psu: pyserial is not installed. The workstation has it: python3-serial.", file=sys.stderr)
        return 1
    finally:
        if guard is not None:
            guard.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
