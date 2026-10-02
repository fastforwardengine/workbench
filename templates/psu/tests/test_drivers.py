"""The driver suite. Each driver runs the same checks. A new driver joins FACTORIES."""

from .support import Isolated, hm310p_factory, sim_factory

FACTORIES = {"hm310p": hm310p_factory, "sim": sim_factory}


class DriverSuite(Isolated):
    def each(self):
        for name, factory in FACTORIES.items():
            with self.subTest(driver=name):
                make, config, _ = factory(self)
                driver = make()
                yield make, config, driver

    def test_describe_matches_the_config(self):
        for _, config, driver in self.each():
            description = driver.describe()
            self.assertEqual(sorted(description.channels), sorted(config["channels"]))
            self.assertTrue(description.capabilities <= {"ovp", "ocp", "raw", "mode"})
            for rating in description.channels.values():
                self.assertGreater(rating.max_voltage, 0)
                self.assertGreater(rating.voltage_step, 0)

    def test_measure_returns_every_channel(self):
        for _, config, driver in self.each():
            readings = driver.measure()
            self.assertEqual(sorted(readings), sorted(config["channels"]))
            for reading in readings.values():
                self.assertEqual((reading.voltage, reading.current, reading.power), (0, 0, 0))

    def test_set_reads_back_through_settings(self):
        for _, config, driver in self.each():
            channel = next(iter(config["channels"]))
            driver.set(channel, voltage=3.3, current=0.02)
            found = driver.settings()[channel]
            self.assertEqual((found.voltage, found.current, found.on), (3.3, 0.02, False))
            driver.set(channel, current=0.05)
            found = driver.settings()[channel]
            self.assertEqual((found.voltage, found.current), (3.3, 0.05))

    def test_output_changes_the_reading(self):
        for _, config, driver in self.each():
            channel = next(iter(config["channels"]))
            driver.set(channel, voltage=1.0, current=0.5)
            driver.output(channel, True)
            self.assertTrue(driver.settings()[channel].on)
            self.assertEqual(driver.measure()[channel].voltage, 1.0)
            self.assertAlmostEqual(driver.measure()[channel].current, 0.01)

    def test_off_from_a_fresh_driver_turns_every_channel_off_twice_over(self):
        for make, config, driver in self.each():
            for channel in config["channels"]:
                driver.set(channel, voltage=1.0, current=0.02)
                driver.output(channel, True)
            self.assertTrue(all(found.on for found in driver.settings().values()))
            fresh = make()
            fresh.off()
            after_first = fresh.settings()
            self.assertFalse(any(found.on for found in after_first.values()))
            fresh.off()
            self.assertEqual(fresh.settings(), after_first)

    def test_protect_round_trips_with_the_capabilities(self):
        for _, config, driver in self.each():
            channel = next(iter(config["channels"]))
            capabilities = driver.describe().capabilities
            self.assertTrue({"ovp", "ocp"} <= capabilities)
            driver.protect(channel, ovp=5.0, ocp=0.5)
            found = driver.settings()[channel]
            self.assertEqual((found.ovp, found.ocp), (5.0, 0.5))
