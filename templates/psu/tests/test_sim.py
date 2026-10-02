"""The load models and the trips of the simulated supply."""

from .support import Isolated


class SimLoads(Isolated):
    def test_resistor_holds_constant_voltage_and_then_constant_current(self):
        sim = self.sim(("ch1",))
        sim.set("ch1", voltage=1.0, current=0.5)
        sim.output("ch1", True)
        self.assertEqual(sim.settings()["ch1"].mode, "cv")
        self.assertEqual(sim.measure()["ch1"].current, 0.01)
        sim.set("ch1", voltage=3.3, current=0.02)
        reading = sim.measure()["ch1"]
        # 3.3 V wants 33 mA on 100 ohm. The 20 mA limit holds, so the voltage falls to 2 V.
        self.assertEqual((reading.voltage, reading.current, reading.power), (2.0, 0.02, 0.04))
        self.assertEqual(sim.settings()["ch1"].mode, "cc")

    def test_diode_draws_nothing_below_its_forward_voltage(self):
        sim = self.sim(loads={"ch2": {"kind": "diode", "forward_voltage": 2.0, "ohms": 10}})
        sim.set("ch2", voltage=1.5, current=0.1)
        sim.output("ch2", True)
        self.assertEqual(sim.measure()["ch2"].current, 0)
        sim.set("ch2", voltage=2.5)
        self.assertAlmostEqual(sim.measure()["ch2"].current, 0.05)
        sim.set("ch2", voltage=4.0, current=0.1)
        # 2 V over the diode at 10 ohm would draw 0.2 A: the limit holds the current at 0.1 A.
        reading = sim.measure()["ch2"]
        self.assertAlmostEqual(reading.current, 0.1)
        self.assertAlmostEqual(reading.voltage, 3.0)

    def test_channels_do_not_affect_each_other(self):
        sim = self.sim()
        sim.set("ch1", voltage=2.0, current=0.5)
        sim.output("ch1", True)
        self.assertTrue(sim.settings()["ch1"].on)
        self.assertFalse(sim.settings()["ch2"].on)
        self.assertEqual(sim.measure()["ch2"].voltage, 0)

    def test_a_channel_trips_above_its_protection_limit(self):
        sim = self.sim(("ch1",))
        sim.protect("ch1", ovp=2.0)
        sim.set("ch1", voltage=3.0, current=0.5)
        sim.output("ch1", True)
        found = sim.settings()["ch1"]
        self.assertFalse(found.on)
        self.assertEqual(found.tripped, ["OVP"])

    def test_two_objects_share_one_state_file(self):
        first, second = self.sim(), self.sim()
        first.set("ch1", voltage=1.0)
        second.set("ch2", voltage=2.0)
        self.assertEqual(first.settings()["ch2"].voltage, 2.0)
        self.assertEqual(second.settings()["ch1"].voltage, 1.0)
