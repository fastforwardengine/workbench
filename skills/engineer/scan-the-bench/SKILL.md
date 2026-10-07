---
name: scan-the-bench
description: Find the devices that the workstation reaches, and report each one. Use it when a person asks what is connected, and before the first run of a bench script.
---

1. Fork the `device-scan` template with `fork`, with `clone` set to a path in your home.
   The `README.md` of the clone holds the commands.
2. Run `python3 scan/scan.py` with `bash` and a `name`, such as `scan`. Read
   its end with `wait`.
3. Report each device with four facts: its name, its USB ID, its kind, and
   its device file or its AVFoundation index.
4. When a device is missing, scan once more after 5 seconds. macOS lists
   a device a few seconds after it arrives.
5. When the scan still finds no device, say which step a person takes:
   plug the device into the Mac, or close the app that holds it. A camera
   or a microphone also needs the permission of macOS.
6. Record each device of the bench in `inventory.md`. Mark a value that no
   scan shows with `TBD`.
7. Commit the reports and `inventory.md`, and push your branch. Cite the
   pushed commit in `refs`, in the form that the git guidance gives.
