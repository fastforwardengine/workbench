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

**The sensor reads the supply and never writes to it.** `sensor.py` is a
sensor server for the sensor API of Ambion. It follows the lifecycle of
`templates/usb-camera`. It takes no drive lock, so it runs beside a
controller. It serves three sensors:

| Sensor     | Spans | Answer                                                    |
| ---------- | ----- | --------------------------------------------------------- |
| `output`   | yes   | The voltage, the current, and the power of each channel   |
| `recent`   | no    | The statistics of the last 60 s, and the recent changes   |
| `settings` | no    | The setpoints, the protection limits, and the drive owner |

1. Fork and clone the template, as in `templates/usb-camera/README.md`.
   Run the sensor from a second clone of the fork at a pushed commit. Then
   a later edit in your working clone leaves the launch metadata of the
   evidence unchanged.
2. Start one foreground server with the process tools. Use your fork ID
   and an absolute data directory outside the clone:

   ```ts
   bash({
     command: 'cd ~/bench-psu-sensor && AMBION_SENSOR_REPOSITORY=instruments/bench-psu AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-psu" python3 -u -B sensor.py',
     name: 'bench-psu-sensor', wait: 0, timeout: 86400,
   });
   ```

3. Read `status({ handle })` until `READY {"port": ...}` appears. The
   sensor takes one sample and one settings read before it prints READY.
   A failed read prints the error and no READY.
4. Connect with the process handle and the printed port. The connection
   name is `name` from `psu.json`:

   ```ts
   connect({ name: 'psu', process: handle, port });
   observe({ sensor: 'psu/output' });
   ```

5. Replace the sensor in this order: `cancel({ handle })`, edit and push,
   start a new handle, and connect again. After a restart the sensor
   refills its memory of the last 60 s from the data directory.

The command takes `--config psu.json`, `--sim FILE`, and `--port 0`. The
sample period follows the cost of one read: 250 ms for the HM310P and for
the simulator. The constants at the top of `sensor.py` set the period, the
windows, and the memory. Each sample time is a multiple of the period since
the Unix epoch, so a gap shows as a missing slot.

**A reading counts when it ends inside its slot.** Once each second, the
sensor also reads the settings, which can overrun the slot. The next
reading then starts late, and it counts when it ends before its slot ends.
The sensor drops a reading that ends after its slot. On the HM310P the
sensor holds the bus for about 525 ms of each second. That is four readings
of 75 ms and one settings read of three exchanges.

**Each `recent` observation writes one small file to `blobs/`.** No
process removes them. Delete old blobs while the sensor is stopped.

The data directory holds three kinds of file:

- `samples.jsonl` holds one line for each sample, with the time, the
  period, and the voltage, the current, and the power of each channel. A
  span read of `output` reads it. A span of more than 14400 samples gets
  status 422.
- `settings.jsonl` holds one line for each change of the settings. The
  first line is the baseline.
- `blobs/<sha256>` holds each `recent.json` document that `observe`
  returned.

**Run the tests** with `python3 -B -m unittest` in this directory. They
need python3 and no hardware.
