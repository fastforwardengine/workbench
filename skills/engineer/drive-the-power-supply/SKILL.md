---
name: drive-the-power-supply
description: Read, set, and drive a programmable power supply within its limits, by hand with psu.py or with a start.py actuator (ramp, sweep, hold, sequence), and read it with the psu sensor. Use it when an approved plan needs the supply to drive a load.
compatibility: Needs python3. A real supply needs python3-serial and a USB serial port. The tool runs a simulated supply with --sim.
---

1. Fork the `psu` template with `fork`, and clone it into your home. The
   `README.md` of the clone holds every command and option.
2. Try each command on the simulator first, with no hardware. Add
   `--sim sim.json` to `psu.py` or to `start.py`, as in
   `python3 psu.py --sim sim.json status`. Send the command to the real
   supply only after it works.
3. Read `psu.json` and `python3 psu.py status` before you change anything.
   The guard refuses a value above the limits of `psu.json`. Change
   `psu.json` only when the person asks, and commit the change.
4. Set a point by hand with `psu.py set` while the output is off. Set the
   protection limits with `psu.py protect`.
5. Ask the person before the first command of an exchange that turns an
   output on, and wait for the answer. `psu.py output --channel <ch> on`
   is such a command. Each `start.py` actuator is such a command.
6. Drive a channel with an actuator when the work needs a ramp, a sweep, a
   hold, or a power-up order. Start `start.py <actuator>` with the `bash`
   tool. Give it a `name`, `grace: 2`, a `timeout` above the run time, and
   `wait: 0`.
7. Set `--trip` below `--current` for each rail of a `sequence`. While a
   rail settles, the sequence ignores a current at the limit. Only a
   current above `--trip`, or the end of `--settle`, stops a shorted rail
   that sits at its current limit.
8. Read `events.jsonl` in the clone while the actuator runs. Read the exit
   code with `wait` or `status({ handle })`. Exit 0 means that the
   controller turned off the channels that it held. Any other code means
   that the state of the channels is unknown.
9. Stop an actuator early with `cancel({ handle })`. The controller turns
   its channels off.
10. After an exit code other than 0, a kill, or a lost process, run
    `python3 finally.py`. It turns off every channel, and it needs no
    drive lock.
11. Read the supply with the sensor. Start `sensor.py` as the README of the
    clone says, wait for READY, and `connect` with the handle and the
    port. Then `observe` `psu/output`, `psu/recent`, or `psu/settings`.
12. Cite the manifest snapshot ref that `observe` returns for each
    reading. For rows of `psu.py measure` or for `events.jsonl`, save the
    file with `snapshot`, and cite that ref. A value with no ref is a
    planned value.
13. Turn every output off at the end of the work, also after a failure:
    `python3 psu.py output off`.
14. Commit, and push your branch. A push keeps the work.
