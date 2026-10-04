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
4. Turn an output on with `python3 psu.py output --channel ch1 on`.
   Turn the outputs off with `python3 psu.py output off`. That command
   takes no channel and turns off every channel. It works while another
   process holds a channel.
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
sensor server for the sensor protocol, version 2, of Ambion. It follows the
lifecycle of `templates/usb-camera`. It takes no drive lock, so it runs beside a
controller. It serves three sensors:

| Sensor     | Spans | Answer                                                    |
| ---------- | ----- | --------------------------------------------------------- |
| `output`   | yes   | The voltage, the current, and the power of each channel   |
| `recent`   | no    | The statistics of the last 60 s, and the recent changes   |
| `settings` | no    | The setpoints, the protection limits, and the drive owner |

1. Fork and clone the template, as in `templates/usb-camera/README.md`.
   Run the sensor from a second clone of the fork at a pushed commit. Then
   a later edit in your working clone leaves the launch metadata of the
   evidence unchanged. The sensor needs a git checkout and stops at start
   without one.
2. Start one foreground server with `bash`. Use your fork ID and an
   absolute data directory outside the clone. The workspace sets `$PORT`
   for the process, and the sensor listens on that port. Name the process
   `psu-sensor`:

   ```ts
   bash({
     command: 'cd ~/bench-psu-sensor && AMBION_SENSOR_REPOSITORY=engineer/bench-psu AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-psu" python3 -u -B sensor.py',
     name: 'psu-sensor', wait: 0, timeout: 86400,
   });
   ```

3. Check that the sensor runs with `wait({ handles: [handle], timeout: 0 })`.
   The sensor prints no ready line. It takes one sample and one settings
   read before it listens, so `fetch` fails until those reads end. A failed
   read makes the sensor exit, and the output holds the error.
4. Read the sensor with `fetch`. The `process` is the handle:

   ```ts
   fetch({ process: handle, path: '/' });
   fetch({ process: handle, path: '/output/observe' });
   fetch({ process: handle, path: '/output/observe?from=2026-01-01T00:00:00.000Z&to=2026-01-01T00:00:10.000Z' });
   ```

   The index at `/` names each sensor. Only `output` takes a span, with
   `from` and `to` together. Cite the snapshot ref that `fetch` returns.
5. Replace the sensor in this order: `cancel({ handle })`, edit and push,
   and start a new handle with `bash`. The new process receives a new
   port. After a restart the sensor refills its memory of the last 60 s
   from the data directory.

The command takes `--config psu.json` and `--sim FILE`. The
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
- `blobs/<sha256>` holds each `recent.json` document that an observation
  named.

**A controller drives a channel and turns it off at its end.**
`start.py ramp` brings a channel to a voltage in steps, under a current
limit. It holds the voltage, and then it turns the channel off.

1. Start the controller with the `bash` call. The turn-off of `ramp` takes
   milliseconds, and the turn-off of `sequence` can take 2 s. Give every
   actuator `grace: 5`. Set `timeout` above the sum of `--seconds` and
   `--hold`:

   ```ts
   bash({
     command: 'cd ~/bench-psu && python3 -u -B start.py ramp --channel ch1 --voltage 5 --current 0.1 --seconds 10 --hold 60',
     name: 'psu-ramp', grace: 5, timeout: 120, wait: 0,
   });
   ```

2. Read the log. The controller appends one JSON line for each event to
   `events.jsonl`, or to the file in `ACTUATOR_EVENTS`. The `state` events
   carry one of six words: `acting`, `reached`, `holding`, `stopping`,
   `safe`, and `gave_up`. The `observe` and `drive` events come once for
   each second, and at each change of state.
3. Trust exit 0 as safe. Every channel that the process holds is off at
   exit 0. Exit 1 means an error, and the state of the channel is unknown.
4. Run `python3 finally.py --channel ch1` after an unclean end: an exit
   code other than 0, the state `cancelled`, a kill, or a lost process.
   It takes no drive lock. A second run changes nothing.

**The ramp gives up on an abnormal current.** A reading within 2 % of the
current limit means constant current, and the ramp ends. With
`--trip A`, a reading above that current also ends the ramp.
`--tolerance V` sets the allowed distance from the target voltage.

**Four actuators drive channels.** Each one takes `--channel` once for
each channel, in the order that the options of the actuator use.

| Actuator   | Channels | What it does                                         | It gives up when                                                       |
| ---------- | -------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `ramp`     | one      | Brings the channel to a voltage in steps             | The channel is in constant current, or above `--trip`                  |
| `sweep`    | one      | Visits each voltage of `--voltages`, and logs it     | The output goes off, or a current is above `--trip`                    |
| `hold`     | one up   | Turns the outputs on, and watches them for `--seconds` | A current is at its limit or above `--trip`, a voltage leaves `--tolerance`, or an output goes off |
| `sequence` | two up   | Brings the rails up in order, and down in reverse    | A rail does not settle in `--settle` s, or a rail leaves its band      |

`--voltage`, `--current`, and `--trip` of `hold` and `sequence` take one
value for each channel. One value serves every channel. A point of `sweep`
in constant current is a valid point, and `sweep` logs it. The turn-off of
`sequence` takes `--down-dwell` seconds between two rails, and the total
stays below 2 s.

**A `sequence` needs `--trip` below `--current` for each rail.** While a
rail settles, the sequence ignores a current at the limit. Within the
controller, only a current above `--trip`, or the end of `--settle`, stops
a shorted rail that sits at its current limit.

**The controller takes the drive lock of each of its channels.** When another
process holds it, the controller logs `gave_up` with the holder, and
touches nothing. After the controller takes the locks, every end turns the
channels off. This includes a refused option or a limit, so a channel that
`psu.py` left on is off after a refused ramp.

**Run the tests** with `python3 -B -m unittest` in this directory. They
need python3 and no hardware.
