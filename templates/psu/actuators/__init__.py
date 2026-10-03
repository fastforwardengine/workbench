"""The actuators of start.py: one module for each.

A module has a docstring, CHANNELS, add_arguments(parser) for its options,
and run(controller, guard, args) for its work. CHANNELS is (least, most) for
the number of --channel options, and most can be None for no upper bound.
The harness in controller.py checks the count, takes the drive lock of each
channel, and sets args.channels to the channels in the order given. When
there is one channel, it also sets args.channel. run() returns at its
deadline, and raises GaveUp to end early. The harness makes the channels
safe after run() ends. An actuator can set controller.stop_order and
controller.stop_dwell for an ordered turn-off.

To add an actuator, write the module and register it in ACTUATORS. The
modules common and rails hold shared parts, and ACTUATORS does not list
them.
"""

from . import hold, ramp, sequence, sweep

ACTUATORS = {"ramp": ramp, "sweep": sweep, "hold": hold, "sequence": sequence}
