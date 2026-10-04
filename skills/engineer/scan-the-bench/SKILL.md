---
name: scan-the-bench
description: Find the devices that the workstation reaches, and report each one. Use it when a person asks what is connected, and before the first run of a bench script.
---

1. Fork the `device-scan` template with `fork` and `clone`, into your home.
   The `README.md` of the clone holds the commands.
2. Run `python3 scan/scan.py` with `bash` and a `name`, such as `scan`. Read
   its end with `wait`.
3. Report each device with four facts: its name, its USB ID, its kind, and
   whether its device file reaches the workstation.
4. When a file is missing, scan once more. The workstation makes the file of
   a camera, a serial port, or a USBTMC instrument within 5 seconds.
5. When the scan still finds no device, say which step a person takes:
   attach the device to the workstation, such as `orb usb attach <id>` on a
   Mac.
6. Record each device of the bench in `inventory.md`. Mark a value that no
   scan shows with `TBD`.
7. Commit the reports and `inventory.md`, and push your branch. Cite the
   pushed commit in `refs`, in the form that the git guidance gives.
