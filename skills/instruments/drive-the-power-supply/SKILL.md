---
name: drive-the-power-supply
description: Read, set, and measure a programmable power supply within its limits. Use it when an approved plan needs the supply to drive a load.
compatibility: Needs python3. A real supply needs python3-serial and a USB serial port. The tool runs a simulated supply with --sim.
---

1. Fork the `psu` template with `fork`, and clone it into your home. The
   `README.md` of the clone holds the commands.
2. Try each new command on a simulated supply first, with no hardware:
   `python3 psu.py --sim sim.json status`. Send it to the real supply only
   after it works.
3. Read the real supply before you change it: `python3 psu.py status`.
   `python3 psu.py info` lists the channels and the capabilities of the
   driver.
4. Keep every setpoint within the limits of `psu.json`. The tool refuses a
   value above them. Change `psu.json` only when the person asks, and commit
   the change.
5. Set the voltage and the current limit while the output is off:
   `python3 psu.py set --channel <ch> --voltage <V> --current <A>`. A supply
   with several channels requires `--channel`.
6. Set the protection limits with `python3 psu.py protect --channel <ch>`.
   Keep each one at or below the limit of the channel in `psu.json`. The
   HM310P arms its own OVP and OCP only at the panel.
7. Ask the person before the first `python3 psu.py output --channel <ch> on`
   of the exchange. Wait for the answer.
8. Read the outputs with `python3 psu.py measure --count <n> --interval <s> --csv`.
   Write the rows to a file.
9. Turn the outputs off with `python3 psu.py output off` when the work ends,
   also after a failure. The command turns off every channel.
10. Snapshot the file of the rows with `snapshot`, and cite the snapshot ref
    for each reading. A value with no such file is a planned value.
11. Commit, and push your branch. A push keeps the work.
