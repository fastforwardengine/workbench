---
name: drive-the-power-supply
description: Read, set, and measure the HM310P power supply within its limits. Use it when an approved plan needs the supply to drive a load.
compatibility: Needs python3 and the HM310P on a USB serial port. The tool runs a simulated supply with --sim.
---

1. Fork the `hm310p` template with `fork`, and clone it into your home. The
   `README.md` of the clone holds the commands.
2. Read the supply before you change it: `python3 psu.py status`.
3. Keep every setpoint within `limits.json`. The tool refuses a value above
   it. Change `limits.json` only when the person asks, and commit the change.
4. Set the voltage and the current limit while the output is off:
   `python3 psu.py set --voltage <V> --current <A>`.
5. Ask the person before the first `python3 psu.py output on` of the
   exchange. Wait for the answer.
6. Read the output with `python3 psu.py measure --count <n> --interval <s>
--csv`. Write the rows to a file.
7. Turn the output off with `python3 psu.py output off` when the work ends,
   also after a failure.
8. Snapshot the file of the rows with `snapshot`, and cite the snapshot ref
   for each reading. A value with no such file is a planned value.
9. Try a command with no hardware on a simulated supply:
   `python3 psu.py --sim sim.json status`.
10. Commit, and push your branch. A push keeps the work.
