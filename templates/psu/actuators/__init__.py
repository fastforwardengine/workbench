"""The actuators of start.py: one module for each.

A module has a docstring, add_arguments(parser) for its options, and
run(controller, guard, args) for its work. run() returns at its deadline,
and raises GaveUp to end early. The harness in controller.py makes the
channels safe after run() ends. To add an actuator, write the module and
register it in ACTUATORS.
"""

from . import ramp

ACTUATORS = {"ramp": ramp}
