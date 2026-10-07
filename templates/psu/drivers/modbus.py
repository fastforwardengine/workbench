"""Modbus RTU framing over a serial port."""

import re
import struct
import time

from . import SupplyError

USB_ID = re.compile(r"[0-9a-fA-F]{4}:[0-9a-fA-F]{4}")


def find_port(usb_id):
    """The serial device of the one USB-serial adapter with this ID, such as /dev/cu.usbserial-1410.
    pyserial reads the USB ID of each port, so the name of the device file may change at a reconnect."""
    if not USB_ID.fullmatch(str(usb_id)):
        raise SupplyError(f"The USB ID {usb_id!r} is not four hex digits, a colon, and four hex digits.")
    try:
        from serial.tools import list_ports  # pyserial, only for real hardware
    except ImportError as error:
        raise SupplyError("pyserial is not installed. Run: python3 -m pip install pyserial") from error
    wanted = usb_id.lower()
    found = sorted(
        port.device for port in list_ports.comports()
        if port.vid is not None and port.pid is not None and f"{port.vid:04x}:{port.pid:04x}" == wanted
    )
    found = [device for device in found if not device.startswith("/dev/tty.")]  # macOS lists cu.* and tty.*
    if not found:
        raise SupplyError(f"No serial port has USB ID {wanted}. Attach the supply, or set transport.port in psu.json.")
    if len(found) > 1:
        raise SupplyError(f"More than one serial port has USB ID {wanted}: {', '.join(found)}. Set transport.port in psu.json.")
    return found[0]


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return struct.pack("<H", crc)


class SerialBus:
    """Modbus RTU over the serial port: function codes 3, 6, and 16."""

    def __init__(self, port, address, baud=9600, attempts=3):
        import serial  # pyserial, only for real hardware

        self.serial = serial.Serial(port, baud, bytesize=8, parity="N", stopbits=1, timeout=0.5)
        self.address = address
        self.attempts = attempts

    def _exchange(self, frame, length):
        answer = b""
        for _ in range(self.attempts):
            self.serial.reset_input_buffer()
            self.serial.write(frame + crc16(frame))
            answer = self.serial.read(length)
            # The supply needs a pause between two frames.
            time.sleep(0.05)
            if len(answer) >= 5 and answer[1] & 0x80 and crc16(answer[:3]) == answer[3:5]:
                raise SupplyError(f"The supply refused function {frame[1]}: Modbus exception {answer[2]}.")
            if len(answer) == length and crc16(answer[:-2]) == answer[-2:]:
                return answer
        raise SupplyError(f"No valid answer from the supply at address {self.address} (last: {answer.hex() or 'nothing'}).")

    def read(self, first, count=1):
        answer = self._exchange(struct.pack(">BBHH", self.address, 3, first, count), 5 + 2 * count)
        return list(struct.unpack(f">{count}H", answer[3:-2]))

    def write(self, register, value):
        frame = struct.pack(">BBHH", self.address, 6, register, value)
        if self._exchange(frame, 8)[:6] != frame:
            raise SupplyError(f"The supply did not confirm the write to {register:#06x}.")

    def write_many(self, first, values):
        frame = struct.pack(f">BBHHB{len(values)}H", self.address, 16, first, len(values), 2 * len(values), *values)
        self._exchange(frame, 8)

    def close(self):
        self.serial.close()
