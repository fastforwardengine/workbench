#!/usr/bin/env python3
"""Turn the outputs off after an unclean end: a kill, a crash, or an exit code other than 0.

    python3 finally.py --channel ch1
    python3 finally.py                 # every channel

It takes no drive lock, so it works while another process holds a channel.
It needs no state from the controller. A second run changes nothing.
"""

import argparse
import sys

from controller import emit
from drivers import SupplyError, open_driver
from guard import Guard, load_config
from start import add_supply_arguments


def main(argv=None):
    top = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_supply_arguments(top)
    top.add_argument("--channel", help="the channel, such as ch1. The default is every channel")
    args = top.parse_args(argv)
    guard = None
    try:
        config = load_config(args.config)
        if args.sim:
            config["driver"] = "sim"
        guard = Guard(open_driver(config, args.sim), config)
        settings = guard.off([args.channel] if args.channel else None)
        emit("finally", "state", value="safe", note="finally")
        for channel, setting in settings.items():
            print(f"{channel}: {'on' if setting.on else 'off'}")
        return 1 if any(setting.on for setting in settings.values()) else 0
    except (SupplyError, OSError) as error:
        print(f"finally: {error}", file=sys.stderr)
        return 1
    except ImportError as error:
        if error.name != "serial":
            raise
        print("finally: pyserial is not installed. The workstation has it: python3-serial.", file=sys.stderr)
        return 1
    finally:
        if guard is not None:
            guard.close()


if __name__ == "__main__":
    sys.exit(main())
