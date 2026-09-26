# The registers of the HM310P

The supply speaks Modbus RTU at 9600 baud, 8 data bits, no parity, 1 stop
bit, at address 1, over a CH340 USB-serial chip (`1a86:7523`). It answers
function 3 (read) and function 6 (write one register). Function 16 (write
several registers) also works: `psu.py` uses it for OPP. Every address is
the zero-based address in the frame.

**Status** says what each entry rests on:

- **Tested**: a read or a write on a real unit, 2026-09-26, checked against
  the panel through a camera where the panel shows the value.
- **Documented**: the OEM Modbus document, or the sources below, with no
  test of its meaning here.

| Register        | Name                | Scale      | Access | Status                                                         |
| --------------- | ------------------- | ---------- | ------ | -------------------------------------------------------------- |
| `0x0001`        | Output on/off       | 0 or 1     | r/w    | Tested: the panel follows                                      |
| `0x0002`        | Protection status   | bits       | r      | Documented: bit 0 OVP, 1 OCP, 2 OPP, 3 OTP, 4 SCP. No trip seen |
| `0x0003`        | Model               | 3010       | r      | Tested                                                         |
| `0x0004`        | Tail classification | raw        | r      | Tested: reads 19280. Its meaning is not documented             |
| `0x0005`        | Decimal places      | `0x0233`   | r      | Tested: voltage 2, current 3, power 3                          |
| `0x0010`        | Measured voltage    | 0.01 V     | r      | Tested: the panel agrees                                       |
| `0x0011`        | Measured current    | 0.001 A    | r      | Tested at 0 A only: no load current flowed                     |
| `0x0012`–`13`   | Measured power      | 0.001 W    | r      | Documented: 32 bits, high word first                           |
| `0x0020`        | OVP limit           | 0.01 V     | r/w    | Tested: round trip. Factory value 33.00 V                      |
| `0x0021`        | OCP limit           | 0.001 A    | r/w    | Tested: round trip. Factory value 10.500 A                     |
| `0x0022`–`23`   | OPP limit           | 0.001 W    | r/w    | Tested: round trip with function 16. Factory value 310.000 W   |
| `0x0030`        | Voltage setpoint    | 0.01 V     | r/w    | Tested: the panel follows                                      |
| `0x0031`        | Current setpoint    | 0.001 A    | r/w    | Tested: the panel follows                                      |
| `0x1000` + 16·n | Preset n+1          | V, A, t, e | r/w    | Tested: round trip of the voltage and the current of preset 1  |
| `0x8804`        | Buzzer              | 0 or 1     | r/w    | Tested: round trip. Whether 1 means a beep is not confirmed     |
| `0x9999`        | Modbus address      | 1 to 250   | r/w    | Tested: read only                                              |

**Each preset holds four registers:** the voltage (0.01 V), the current
(0.001 A), a time, and an enable flag. Six presets answer, `0x1000` to
`0x1050`. `0x1060` reads zeros. The time and the enable flag are not
documented.

**The OPP scale is 0.001 W, against the sources.** The OEM document and
`hm310t` give 2 decimal places. The factory value reads 310000, which is
310 W at 3 decimal places and 3100 W at 2. The factory OVP and OCP are the
ratings plus a margin (33 V over 30 V, 10.5 A over 10 A), and 310 W fits a
300 W supply. A trip test with a load that draws current settles it.

**The supply's OVP and OCP act only when the panel arms them.** With OVP at
5.00 V over USB, the supply took a setpoint of 6.00 V and gave 6.00 V with no
trip. `psu.py` enforces `limits.json` itself, for that reason.

**Registers that `psu.py` leaves alone:** `0x8801` to `0x8803` (power-on
state, display, and short-circuit protection, from the vendor software),
`0x0032`, `0x0014`, `0xCCCC`, and `0xC110` to `0xC12F`. The last range holds
the factory limits of voltage and current. `psu.py read` reads any of them.

## Sources

- The OEM Modbus document, `Modbus.pdf`, from the `hm310t` repository.
- [hm310t](https://github.com/joeyda3rd/modbus-power-supply): the register
  table, reconciled against a real unit. Source of the 3 decimal places of
  OCP and of function 16.
- [HanmaTekPSUCmd](https://github.com/mckenm/HanmaTekPSUCmd), `HanmatekPSLib.cs`:
  the buzzer, the presets, and the `0x88xx` and `0xC1xx` registers, from the
  settings of the vendor software.
