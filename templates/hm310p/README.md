# HM310P power supply

This template holds `psu.py`, a command-line tool for a HANMATEK HM310P DC
power supply on USB (Modbus RTU, `/dev/ttyUSB0`). `docs/registers.md` holds
the register map and what each entry rests on.

1. Read the supply before you change it: `python3 psu.py status`.
2. Keep each setpoint within `limits.json`. The tool refuses a setpoint, a
   preset, or a protection limit above it: a voltage above `max_voltage`, a
   current above `max_current`, or a power above `max_power`. It checks the
   whole preset, also the values that it keeps. Change `limits.json` only
   when the person asks, and commit the change.
3. Set the voltage and the current limit while the output is off:
   `python3 psu.py set --voltage 3.30 --current 0.050`.
4. Ask the owner of the exchange before the first `python3 psu.py output on`.
   Turn the output off with `python3 psu.py output off` when the work ends,
   also after a failure.
5. Read the output with `python3 psu.py measure --count 10 --interval 0.5
   --csv`. Record the rows in a file that you commit.
6. The supply's own OVP and OCP act only when the panel arms them. Setting
   them with `python3 psu.py protect` does not arm them. Each one must be at
   or below its limit in `limits.json`, so it trips at or before it.
7. Try a command with no hardware on a simulated supply:
   `python3 psu.py --sim sim.json status`. The simulation has a 100 ohm load.
8. Commit, and push your branch. A push keeps the work.

Every command takes `--json`. `python3 psu.py --help` lists the commands:
`info`, `status`, `measure`, `set`, `output`, `protect`, `preset`, `buzzer`,
`address`, and `read`.
