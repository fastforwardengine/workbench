"""The guard: limits, write order, capabilities, locks, and the derived mode."""

import dataclasses

from drivers import SupplyError
from drivers.hm310p import OCP, OVP, SET_I, SET_V, Hm310p
from guard import DriveLocks, Guard, hold_drive_locks, lock_directory

from .fake_hm310p import FakeBus
from .support import CONFIG_ONE, CONFIG_TWO, Isolated


class Limited(Isolated):
    def guard(self, driver=None, config=CONFIG_TWO, **options):
        return Guard(driver or self.sim(), config, **options)


class Limits(Limited):
    def test_each_channel_has_its_own_limits(self):
        guard = self.guard()
        guard.set("ch1", voltage=5.0, current=0.5)
        with self.assertRaisesRegex(SupplyError, r"^The setpoints of ch2: the voltage 5 V is above the limit 3 V of psu.json\.$"):
            guard.set("ch2", voltage=5.0)
        with self.assertRaisesRegex(SupplyError, "the current 0.1 A is above the limit 0.05 A"):
            guard.set("ch2", current=0.1)
        with self.assertRaisesRegex(SupplyError, "must not be negative"):
            guard.set("ch1", voltage=-1)
        self.assertEqual(guard.settings()["ch2"].voltage, 0)

    def test_power_is_voltage_times_current(self):
        config = {"name": "psu", "channels": {"ch2": {"max_voltage": 3.0, "max_current": 0.05, "max_power": 0.1}}}
        guard = self.guard(self.sim(("ch2",)), config)
        guard.set("ch2", voltage=2.0, current=0.05)
        with self.assertRaisesRegex(SupplyError, "the power 0.15 W is above the limit 0.1 W"):
            guard.set("ch2", voltage=3.0)

    def test_the_rating_of_the_driver_caps_the_config(self):
        config = {"name": "psu", "channels": {"ch1": {"max_voltage": 99, "max_current": 99}}}
        guard = self.guard(config=config)
        self.assertEqual(guard.limits("ch1")["max_voltage"], 30.0)
        with self.assertRaisesRegex(SupplyError, "of the rating of the supply"):
            guard.set("ch1", voltage=31)

    def test_a_refused_change_writes_nothing(self):
        guard = self.guard()
        with self.assertRaises(SupplyError):
            guard.set("ch1", voltage=1.0, current=0.9)
        self.assertEqual(self.sim_writes(), [])

    def test_output_on_checks_the_present_setpoints(self):
        driver = self.sim()
        driver.set("ch2", voltage=4.0, current=0.01)
        guard = self.guard(driver)
        with self.assertRaisesRegex(SupplyError, "The present setpoints of ch2"):
            guard.output("ch2", True)
        self.assertFalse(driver.settings()["ch2"].on)

    def test_an_unknown_channel_is_refused(self):
        with self.assertRaisesRegex(SupplyError, "There is no channel ch3"):
            self.guard().set("ch3", voltage=1)

    def test_protection_limits_stay_within_the_limits_of_the_channel(self):
        guard = self.guard()
        with self.assertRaisesRegex(SupplyError, "the OVP 4 V is above the limit 3 V"):
            guard.protect("ch2", ovp=4)
        self.assertEqual(guard.protect("ch2", ovp=3.0, ocp=0.05).ovp, 3.0)


class WriteOrder(Limited):
    def test_the_current_goes_first_when_the_voltage_rises(self):
        config = {"name": "psu", "channels": {"ch1": {"max_voltage": 5, "max_current": 0.5, "max_power": 1}}}
        driver = self.sim(("ch1",))
        guard = self.guard(driver, config)
        guard.set("ch1", voltage=1, current=0.5)
        before = len(self.sim_writes())
        # From 1 V at 0.5 A to 5 V at 0.1 A: the voltage first would hold 5 V at 0.5 A, 2.5 W.
        guard.set("ch1", voltage=5, current=0.1)
        self.assertEqual(self.sim_writes()[before:], [("ch1", "current", 0.1), ("ch1", "voltage", 5)])
        # When the voltage falls, the voltage goes first.
        after = len(self.sim_writes())
        guard.set("ch1", voltage=2, current=0.4)
        self.assertEqual(self.sim_writes()[after:], [("ch1", "voltage", 2), ("ch1", "current", 0.4)])

    def test_the_registers_follow_the_same_order(self):
        bus = FakeBus()
        config = {"name": "psu", "channels": {"ch1": {"max_voltage": 5, "max_current": 0.5, "max_power": 1}}}
        guard = self.guard(Hm310p(bus), config)
        guard.set("ch1", voltage=1, current=0.5)
        bus.writes.clear()
        guard.set("ch1", voltage=5, current=0.1)
        self.assertEqual(bus.writes, [(SET_I, 100), (SET_V, 500)])


class NoCapability(Isolated):
    def stub(self, capabilities, mode=True):
        owner = self

        class Stub(type(self.sim())):
            def describe(self):
                return dataclasses.replace(super().describe(), capabilities=frozenset(capabilities))

            def settings(self):
                found = super().settings()
                if not mode:
                    for setting in found.values():
                        setting.mode = None
                return found

        return Stub(owner.state, ["ch1"])

    def test_an_operation_without_its_capability_is_refused(self):
        guard = Guard(self.stub({"ocp"}), CONFIG_ONE | {"driver": "sim"})
        with self.assertRaisesRegex(SupplyError, "cannot set an over-voltage limit"):
            guard.protect("ch1", ovp=1)
        guard.protect("ch1", ocp=0.1)
        with self.assertRaisesRegex(SupplyError, "cannot read raw registers"):
            guard.read_raw(0x10, 1)

    def test_the_mode_is_derived_when_the_driver_gives_none(self):
        guard = Guard(self.stub({"ovp", "ocp"}, mode=False), CONFIG_ONE)
        guard.set("ch1", voltage=3.3, current=0.02)
        self.assertIsNone(guard.status()["ch1"]["mode"])
        guard.output("ch1", True)
        # 3.3 V wants 33 mA on 100 ohm. The 20 mA limit holds: constant current.
        self.assertEqual(guard.status()["ch1"]["mode"], "cc")
        guard.set("ch1", voltage=1.0, current=0.5)
        self.assertEqual(guard.status()["ch1"]["mode"], "cv")

    def test_the_driver_mode_wins_when_it_has_one(self):
        guard = Guard(self.stub({"ovp"}, mode=True), CONFIG_ONE)
        guard.set("ch1", voltage=1.0, current=0.5)
        guard.output("ch1", True)
        self.assertEqual(guard.status()["ch1"]["mode"], "cv")


class Locks(Limited):
    def test_the_lock_directory_follows_the_variable(self):
        self.assertEqual(lock_directory(), str(self.locks))

    def test_a_drive_lock_refuses_a_second_actuator_and_names_the_holder(self):
        guard = self.guard()
        controller = DriveLocks(self.locks, "psu", "start")
        controller.acquire(["ch1"])
        with self.assertRaisesRegex(SupplyError, r"^The channel ch1 is driven by start \(pid \d+, since \d{4}-"):
            guard.set("ch1", voltage=1.0)
        with self.assertRaisesRegex(SupplyError, "driven by start"):
            guard.output("ch1", True)
        # The other channel is free.
        guard.set("ch2", voltage=1.0)
        controller.release()
        guard.set("ch1", voltage=1.0)

    def test_off_ignores_the_drive_lock(self):
        driver = self.sim()
        driver.set("ch1", voltage=1.0, current=0.1)
        driver.output("ch1", True)
        DriveLocks(self.locks, "psu", "start").acquire(["ch1", "ch2"])
        found = self.guard(driver).off()
        self.assertFalse(found["ch1"].on)
        self.assertFalse(driver.settings()["ch1"].on)

    def test_the_holder_may_drive_through_its_own_guard(self):
        locks = hold_drive_locks(CONFIG_TWO, actuator="start")
        guard = self.guard(locks=locks)
        guard.set("ch1", voltage=1.0)
        self.assertTrue(locks.holds("ch1"))
        # Another guard with its own lock object is refused.
        with self.assertRaisesRegex(SupplyError, "driven by start"):
            self.guard().set("ch1", voltage=2.0)

    def test_a_failed_acquire_takes_no_channel(self):
        DriveLocks(self.locks, "psu", "start").acquire(["ch2"])
        mine = DriveLocks(self.locks, "psu", "other")
        with self.assertRaises(SupplyError):
            mine.acquire(["ch1", "ch2"])
        self.assertEqual(mine.held, {})

    def test_a_temporary_hold_releases_the_lock(self):
        guard = self.guard()
        guard.set("ch1", voltage=1.0)
        other = DriveLocks(self.locks, "psu", "start")
        other.acquire(["ch1"])
        other.release()
