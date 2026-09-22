# TP4056-based charge and protection module (summary)

**The module charges one Li-ion cell from USB power and protects it from
over-charge, over-discharge, and a shorted output.** It sits between the
USB source and the cell.

## Input and output

| Value                           | Limit                                               |
| ------------------------------- | --------------------------------------------------- |
| Input voltage (USB)             | 4.5 V to 5.5 V                                      |
| Charge termination voltage      | 4.2 V ± 1 %                                         |
| Charge current                  | Set by a resistor; this module ships set to 1000 mA |
| Overcurrent protection          | Trips near 3 A on the output                        |
| Standby current (charged, idle) | Typically 2 mA to 3 mA                              |

## Charge current

The module holds the cell at 4.2 V once it reaches that voltage, and tapers
the current down. Do not exceed the cell's charge current limit in
`cell-18650.md`: this module's default 1000 mA setting is within it.

## Protection

- Over-discharge cutoff: near 2.4 V, close to the cell's own 2.5 V minimum.
  Treat the cell's limit as the one to design to, not the module's.
- Over-current and short-circuit protection on the output.
- No thermal cutoff. A cycling test should watch cell temperature with a
  thermocouple; see `thermocouple-k-type.md`.
