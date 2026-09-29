---
name: drive-the-power-supply
description: Read, set, and measure the HM310P power supply within its limits. Use it when an approved plan needs the supply to drive a load.
compatibility: Needs python3 and the HM310P on a USB serial port. The tool runs a simulated supply with --sim.
---

1. Fork the `hm310p` template with `fork`, and clone it into your home. The
   `README.md` of the clone holds the commands.
2. Try each new command on a simulated supply first, with no hardware:
   `python3 psu.py --sim sim.json status`. Send it to the real supply only
   after it works.
3. Read the real supply before you change it: `python3 psu.py status`.
4. Keep every setpoint within `limits.json`. The tool refuses a value above
   it. Change `limits.json` only when the person asks, and commit the change.
5. Set the voltage and the current limit while the output is off:
   `python3 psu.py set --voltage <V> --current <A>`.
6. The OVP and the OCP of the supply act only when the panel arms them.
   `python3 psu.py protect` sets them and does not arm them. Keep each one at
   or below its limit in `limits.json`, so it trips at or before that limit.
7. Ask the person before the first `python3 psu.py output on` of the
   exchange. Wait for the answer.
8. Read the output with `python3 psu.py measure --count <n> --interval <s> --csv`.
   Write the rows to a file.
9. Turn the output off with `python3 psu.py output off` when the work ends,
   also after a failure.
10. Snapshot the file of the rows with `snapshot`, and cite the snapshot ref
    for each reading. A value with no such file is a planned value.
11. Commit, and push your branch. A push keeps the work.
