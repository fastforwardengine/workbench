---
name: scan-the-bench
description: Find the devices that the workstation reaches, and report each one. Use it when a person asks what is connected, and before the first run of a bench script.
---

1. Fork the `device-scan` template with `fork`, and clone it into your home.
   The `README.md` of the clone holds the commands.
2. Run `python3 scan/scan.py` with `bash` and a `name`, such as `scan`. Read
   its end with `wait` or `status`.
3. Add `--identify` to ask each VISA instrument `*IDN?`. The query only
   reads. Add `--subnet <CIDR>` only when the person names the subnet.
4. Report each device with four facts: its name, its USB ID, its kind, and
   whether its device file reaches the workstation.
5. When a file is missing, scan once more. The workstation makes the file of
   a camera, a serial port, or a USBTMC instrument within 5 seconds.
6. When the scan still finds no device, say which step a person takes:
   attach the device to the workstation, such as `orb usb attach <id>` on a
   Mac.
7. Record each device of the bench in `inventory.md`. Mark a value that no
   scan shows with `TBD`.
8. Commit the reports and `inventory.md`, and push your branch. Cite the
   pushed commit in `refs`, in the form that the git guidance gives.
