"""Turn on one channel or several at fixed setpoints, and watch them until the deadline."""

from . import rails
from .common import refuse_unless

CHANNELS = (1, None)
SETTLE_PERIODS = 3


def add_arguments(parser):
    rails.add_arguments(parser)
    parser.add_argument("--seconds", type=float, required=True, help="the time to watch after the outputs reach their voltages, in s")


def run(controller, guard, args):
    controller.check()
    rails.check_numbers(args)
    refuse_unless(0 < args.seconds < float("inf"), "The option --seconds must be a finite number above 0.")
    held = rails.Rails(controller, guard, args)
    held.validate()
    held.announce(seconds=args.seconds)
    for rail in held.rails:
        held.power_on(rail)
    controller.claim("acting")
    readings = held.settle([], held.rails, SETTLE_PERIODS * held.period)
    controller.claim("reached", held.summary(readings))
    controller.claim("holding")
    held.watch(args.seconds)
