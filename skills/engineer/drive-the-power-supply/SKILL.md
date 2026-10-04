---
name: drive-the-power-supply
description: Read, set, and drive a programmable power supply within its limits, with one psu.py command or with a start.py actuator (ramp, sweep, hold, sequence), and read it with the psu sensor. Use it when an approved plan needs the supply to drive a load.
compatibility: Needs python3. A real supply needs python3-serial and a USB serial port. The tool runs a simulated supply with --sim.
---

1. Fork the `psu` template with `fork`, with `clone` set to a path in your home. The
   `README.md` of the clone holds every command and option.
2. Try each command on the simulator first, with no hardware. Put
   `--sim sim.json` before the command or the actuator, as in
   `python3 start.py --sim sim.json ramp ...`. Send the command to the real
   supply only after it works.
3. Read `psu.json` and `python3 psu.py status` before you change anything.
   Change `psu.json` only when the person asks, and commit the change.
4. Ask the person before the first command of an exchange that turns an
   output on, and wait for the answer. `psu.py output --channel <ch> on`
   is such a command. Each `start.py` actuator is such a command.
5. Drive a channel with an actuator when the work needs a ramp, a sweep, a
   hold, or a power-up order. Start `start.py <actuator>` with the `bash`
   tool, as the README says for a controller. Set `--trip` below
   `--current` for each rail of a `sequence`.
6. Read `events.jsonl` in the clone while the actuator runs. Read the exit
   code with `wait({ handles: [handle], timeout: 0 })`. Exit 0 means that the
   controller turned off the channels that it held. Any other code means
   that the state of the channels is unknown.
7. Stop an actuator early with `cancel({ handle })`. Then read the state
   with `wait({ handles: [handle], timeout: 0 })`. Only the state `exited`
   with code 0 means that the channels are off.
8. After an exit code other than 0, the state `cancelled`, a kill, or a
   lost process, run
   `python3 finally.py`. It turns off every channel, also while another
   process holds a channel.
9. Read the supply with the sensor. Start `sensor.py` with `bash` as the README of
   the clone says. The sensor prints no ready line, and `fetch` fails until
   it takes its first sample. Then fetch `/output/observe`,
   `/recent/observe`, or `/settings/observe` from the handle.
10. Cite the snapshot ref that `fetch` returns for each reading. For rows of `psu.py measure` or for `events.jsonl`, save the
    file with `snapshot`, and cite that ref.
11. Turn every output off at the end of the work, also after a failure:
    `python3 psu.py output off`.
12. Commit, and push your branch. A push keeps the work.
