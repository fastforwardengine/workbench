"""Bring rails up in the order given, each after the one before settles, and turn them off in reverse order."""

from . import rails
from .common import finite, refuse_unless

CHANNELS = (2, None)
MAX_DOWN = 2.0  # the most time of the turn-off steps, in s. The grace of the process is 5 s.


def add_arguments(parser):
    rails.add_arguments(parser)
    parser.add_argument("--settle", type=float, default=2, help="the time for each rail to reach its band, in s")
    parser.add_argument("--seconds", type=float, default=0, help="the time to watch after all rails are up, in s")
    parser.add_argument("--down-dwell", type=float, default=0.1, help="the time between two turn-offs at the end, in s")


def check_numbers(args):
    rails.check_numbers(args)
    finite(args, ("settle", "seconds", "down_dwell"))
    refuse_unless(args.settle > 0, "The option --settle must be above 0.")
    refuse_unless(args.seconds >= 0 and args.down_dwell >= 0, "The options --seconds and --down-dwell must not be negative.")
    total = (len(args.channels) - 1) * args.down_dwell
    refuse_unless(total <= MAX_DOWN, f"The turn-off steps take {total:g} s with --down-dwell {args.down_dwell:g} s. The most is {MAX_DOWN:g} s.")


def run(controller, guard, args):
    controller.check()
    check_numbers(args)
    chain = rails.Rails(controller, guard, args)
    chain.validate()
    controller.stop_order = [rail.channel for rail in reversed(chain.rails)]
    controller.stop_dwell = args.down_dwell
    chain.announce(settle=args.settle, seconds=args.seconds)
    controller.claim("acting")
    up = []
    for rail in chain.rails:
        chain.power_on(rail)
        readings = chain.settle(up, [rail], args.settle)
        up.append(rail)
    controller.claim("reached", chain.summary(readings))
    if args.seconds > 0:
        controller.claim("holding")
        chain.watch(args.seconds)
