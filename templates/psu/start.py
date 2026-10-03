#!/usr/bin/env python3
"""Run one controller on a programmable power supply.

    python3 start.py ramp --channel ch1 --voltage 5 --current 0.1 --seconds 10 --hold 60
    python3 start.py --sim sim.json ramp --voltage 3.3 --current 0.05

The controller takes the drive lock of its channel, drives the channel, and
turns it off at its end. It logs one JSON line for each event to
ACTUATOR_EVENTS, else to events.jsonl. Exit 0 means that the channel is off.
After a kill, or an exit code other than 0, run finally.py.
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
        sub.add_argument("--channel", help="the channel, such as ch1")
        module.add_arguments(sub)
    return top


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return run(args.actuator, args, ACTUATORS[args.actuator].run)
    except ImportError as error:
        if error.name != "serial":
            raise
        print("start: pyserial is not installed. The workstation has it: python3-serial.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
