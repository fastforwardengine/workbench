#!/usr/bin/env python3
"""Run one controller on a programmable power supply.

    python3 start.py ramp --channel ch1 --voltage 5 --current 0.1 --seconds 10 --hold 60
    python3 start.py --sim sim.json ramp --voltage 3.3 --current 0.05
    python3 start.py sweep --channel ch1 --voltages 1 2 3 --current 0.1 --dwell 1
    python3 start.py hold --channel ch1 --channel ch2 --voltage 3 1.8 --current 0.1 0.02 --seconds 60
    python3 start.py sequence --channel ch2 --channel ch1 --voltage 1.8 3 --current 0.02 0.1

An actuator drives the channels that --channel names, one option for each
channel. Ramp and sweep take one channel. Hold takes one or more. Sequence
takes two or more, and turns them off in reverse order.

The controller takes the drive lock of each of its channels, drives them,
and turns them off at its end. It logs one JSON line for each event to
ACTUATOR_EVENTS, else to events.jsonl. Exit 0 means that the channels are
off. After a kill, or an exit code other than 0, run finally.py.
"""

import argparse
import sys
from pathlib import Path

from actuators import ACTUATORS
from controller import run

HERE = Path(__file__).resolve().parent


def add_supply_arguments(parser):
    parser.add_argument("--config", default=str(HERE / "psu.json"), help="the file of the supply and its limits")
    parser.add_argument("--sim", metavar="FILE", help="use the simulated supply, with its state in FILE")


def parser():
    top = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_supply_arguments(top)
    commands = top.add_subparsers(dest="actuator", required=True)
    for name, module in ACTUATORS.items():
        sub = commands.add_parser(name, help=module.__doc__)
        sub.add_argument("--channel", dest="channels", action="append", metavar="CHANNEL", help="a channel, such as ch1. Repeat it for each channel, in order")
        module.add_arguments(sub)
    return top


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return run(args.actuator, args, ACTUATORS[args.actuator].run, ACTUATORS[args.actuator].CHANNELS)
    except ImportError as error:
        if error.name != "serial":
            raise
        print("start: pyserial is not installed. The workstation has it: python3-serial.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
