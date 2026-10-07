"""The serial port of the HM310P: a USB ID goes to a device file, and an explicit port wins."""

import sys
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from drivers import SupplyError
from drivers.hm310p import Hm310p
from drivers.modbus import find_port


def port(device, vid, pid):
    return SimpleNamespace(device=device, vid=vid, pid=pid)


def fake_serial(*ports):
    """A pyserial whose list_ports.comports gives these ports. It goes into sys.modules."""
    tools, list_ports = ModuleType("serial.tools"), ModuleType("serial.tools.list_ports")
    list_ports.comports = lambda: list(ports)
    tools.list_ports = list_ports
    top = ModuleType("serial")
    top.tools = tools
    return {"serial": top, "serial.tools": tools, "serial.tools.list_ports": list_ports}


CH340 = port("/dev/cu.usbserial-1410", 0x1A86, 0x7523)
BLUETOOTH = port("/dev/cu.Bluetooth-Incoming-Port", None, None)
OTHER = port("/dev/cu.usbmodem2101", 0x2E8A, 0x000A)


class FindPortTests(unittest.TestCase):
    def find(self, usb_id, *ports):
        with patch.dict(sys.modules, fake_serial(*ports)):
            return find_port(usb_id)

    def test_the_usb_id_goes_to_the_device_file_of_the_adapter(self):
        self.assertEqual(self.find("1a86:7523", BLUETOOTH, OTHER, CH340), "/dev/cu.usbserial-1410")

    def test_the_usb_id_ignores_case(self):
        self.assertEqual(self.find("1A86:7523", CH340), "/dev/cu.usbserial-1410")

    def test_the_new_name_after_a_reconnect_needs_no_change(self):
        renamed = port("/dev/cu.usbserial-2330", 0x1A86, 0x7523)
        self.assertEqual(self.find("1a86:7523", renamed), "/dev/cu.usbserial-2330")

    def test_a_linux_device_file_works(self):
        self.assertEqual(self.find("1a86:7523", port("/dev/ttyUSB0", 0x1A86, 0x7523)), "/dev/ttyUSB0")

    def test_the_tty_twin_of_a_macos_port_does_not_count(self):
        twin = port("/dev/tty.usbserial-1410", 0x1A86, 0x7523)
        self.assertEqual(self.find("1a86:7523", twin, CH340), "/dev/cu.usbserial-1410")

    def test_no_adapter_raises_supply_error(self):
        with self.assertRaisesRegex(SupplyError, r"No serial port has USB ID 1a86:7523.*transport\.port"):
            self.find("1a86:7523", BLUETOOTH, OTHER)

    def test_two_adapters_raise_supply_error(self):
        second = port("/dev/cu.usbserial-1420", 0x1A86, 0x7523)
        with self.assertRaisesRegex(SupplyError, r"More than one serial port has USB ID 1a86:7523: /dev/cu.usbserial-1410, "):
            self.find("1a86:7523", CH340, second)

    def test_a_bad_usb_id_raises_supply_error(self):
        for value in ("1a867523", "1a86:752", "0x1a86:7523", ""):
            with self.assertRaisesRegex(SupplyError, "is not four hex digits"):
                self.find(value, CH340)

    def test_missing_pyserial_raises_supply_error(self):
        with patch.dict(sys.modules, {"serial": None, "serial.tools": None}), \
                self.assertRaisesRegex(SupplyError, "pyserial is not installed"):
            find_port("1a86:7523")


class FromConfigTests(unittest.TestCase):
    def open(self, transport, *ports):
        """Open the driver with SerialBus patched. Returns the arguments that SerialBus received."""
        with patch.dict(sys.modules, fake_serial(*ports)), patch("drivers.hm310p.SerialBus") as bus:
            Hm310p.from_config({"transport": transport} if transport is not None else {})
        return bus.call_args.args

    def test_psu_json_finds_the_port_by_usb_id(self):
        self.assertEqual(self.open({"usb_id": "1a86:7523", "address": 1}, CH340), ("/dev/cu.usbserial-1410", 1))

    def test_a_config_with_no_transport_looks_for_the_ch340(self):
        self.assertEqual(self.open(None, CH340), ("/dev/cu.usbserial-1410", 1))

    def test_an_explicit_port_wins_and_needs_no_pyserial_list(self):
        self.assertEqual(self.open({"port": "/dev/cu.usbserial-9", "usb_id": "1a86:7523", "address": 3}),
                         ("/dev/cu.usbserial-9", 3))

    def test_the_address_defaults_to_1(self):
        self.assertEqual(self.open({"usb_id": "2e8a:000a"}, OTHER), ("/dev/cu.usbmodem2101", 1))
