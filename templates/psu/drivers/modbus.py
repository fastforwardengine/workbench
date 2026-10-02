"""Modbus RTU framing over a serial port."""

import struct
import time

from . import SupplyError


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
