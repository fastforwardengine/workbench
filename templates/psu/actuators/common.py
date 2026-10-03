"""The parts that the actuators share: refusals, the judgement of a reading, and the power-on."""

import math

from controller import GaveUp
from drivers import SupplyError
from guard import CC_BAND

MIN_PERIOD = 0.05


def refuse_unless(condition, note):
    if not condition:
        raise GaveUp(note)


def finite(args, names):
    """Refuse an option that is not a finite number. A list option holds a number in each place. An option that is None passes."""
    for name in names:
        value = getattr(args, name)
        values = value if isinstance(value, list) else [value]
        refuse_unless(all(each is None or math.isfinite(each) for each in values), f"The option --{name} must be a finite number.")


def least_period(guard):
    """The shortest period that the supply can follow."""
    return max(4 * guard.describe().measure_seconds, MIN_PERIOD)


def refuse_limits(guard, channel, voltage, current):
    """Refuse a voltage and a current above the limits of the channel, and write nothing."""
    try:
        guard.known(channel)
        guard.check(channel, voltage, current)
    except SupplyError as error:
        raise GaveUp(str(error)) from error


def off_reason(setting):
    """Why a channel is off, or None when it is on."""
    if setting.on:
        return None
    return f"The output is off ({', '.join(setting.tripped)} tripped)." if setting.tripped else "The output is off."


def power_on(guard, channel, current, setting):
    """Set the current limit first. An output that is off starts at 0 V. Return the settings."""
    if setting.on:
        return setting if setting.current == current else guard.set(channel, current=current)
    guard.set(channel, voltage=0.0, current=current)
    return guard.output(channel, True)


def judge_cc(reading, setting, who=None):
    """Give up on a reading at the current limit. who names the channel when several run."""
    if reading.current >= setting.current * (1 - CC_BAND):
        raise GaveUp(f"The channel{_named(' ', who)} is in constant current: {_where(reading)}, at the limit {setting.current:g} A.")


def judge_trip(reading, trip, who=None):
    """Give up on a reading above the trip current."""
    if trip is not None and reading.current > trip:
        raise GaveUp(f"The current{_named(' of ', who)} is abnormal: {_where(reading)}, above the trip current {trip:g} A.")


def judge_current(reading, setting, trip, who=None):
    """Give up on a reading at the current limit, or above the trip current."""
    judge_cc(reading, setting, who)
    judge_trip(reading, trip, who)


def _named(joint, who):
    return f"{joint}{who}" if who else ""


def _where(reading):
    return f"{reading.current:g} A at {reading.voltage:g} V"
