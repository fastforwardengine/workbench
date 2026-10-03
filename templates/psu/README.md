# Programmable power supply

This template controls one programmable power supply from the command
line. `psu.json` names the supply, its driver, and the limits of each
channel. `psu.py` runs one command. `guard.py` enforces the limits and the
locks. `drivers/` holds one file for each kind of supply. The `hm310p`
driver speaks to a HANMATEK HM310P over USB (`docs/hm310p.md` holds its
register map). The `sim` driver is a simulated supply with no hardware.

1. Read the supply before you change it: `python3 psu.py status`. Read
   `psu.json` and `python3 psu.py info` to learn the channels, the limits,
   and the capabilities of the driver.
2. Keep each setpoint within the limits of `psu.json`. The guard refuses a
   voltage above `max_voltage`, a current above `max_current`, and a power
   above `max_power`. A limit is the smaller of the value in `psu.json` and
   the rating of the driver. Change `psu.json` only when the person asks,
   and commit the change.
3. Set the voltage and the current limit while the output is off:
   `python3 psu.py set --channel ch1 --voltage 3.30 --current 0.050`.
   A supply with one channel needs no `--channel`. A supply with several
   channels requires it.
4. Ask the person before the first `python3 psu.py output --channel ch1 on`.
   Turn the outputs off with `python3 psu.py output off` when the work
   ends, also after a failure. That command takes no channel and turns off
   every channel. It works while another process holds a channel.
5. Read the outputs with `python3 psu.py measure --count 10 --interval 0.5
   --csv`. Each row names its channel. Record the rows in a file that you
   commit.
6. Set the protection limits with `python3 psu.py protect --channel ch1
   --ovp 5 --ocp 0.5`. Each one must be at or below the limit of the channel
   in `psu.json`. The HM310P arms its own OVP and OCP only at the panel, so
   `psu.json` stays the guard.
7. Try each command on the simulator first: `python3 psu.py --sim sim.json
   status`. The simulator has the channels of `psu.json`. Each channel has a
   100 ohm load. Add `"sim": {"loads": {"ch2": {"kind": "diode",
   "forward_voltage": 2.0, "ohms": 10}}}` to `psu.json` to change a load.
8. Add a driver for another supply: write one file in `drivers/` with a
   class that follows the `Driver` protocol of `drivers/__init__.py`.
   Register the class in `DRIVERS` there. Add it to `FACTORIES` in
   `tests/test_drivers.py`, and make the driver suite pass.
9. Commit, and push your branch. A push keeps the work.

**Locks keep several processes apart.** Each call takes the bus lock of the
supply and waits for it. A call that writes a setpoint or turns an output on
takes the drive lock of its channel without waiting. It refuses when another
process holds that lock, and the message names the holder. The locks live in
`/run/lock`, or in the system temporary directory. `PSU_LOCK_DIR` sets
another directory.

**Every command takes `--json`.** `python3 psu.py --help` lists the
commands: `info`, `status`, `measure`, `set`, `output`, `protect`, and
`read`. The `read` command needs a driver with raw registers.

**Run the tests** with `python3 -B -m unittest` in this directory. They
need python3 and no hardware.
