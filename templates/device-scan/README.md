# Device scan

This template finds the devices that the workstation can reach: USB devices,
serial ports, USBTMC instruments, cameras, and microphones. Each scan writes
a report to `scans/`.

1. Run the scan from the root of the clone, with a `name`, such as `scan`:
   `python3 scan/scan.py`. Read its end with `wait`.
2. Report each device: its name, its USB ID, its kind, and whether its
   device file reaches the container. The workstation makes the file of a
   camera, a microphone, a serial port, or a USBTMC instrument within 5
   seconds of its arrival, so scan again once when a file is missing.
3. To list the microphones, read the Microphones section of the report or
   run `arecord -l`. Note the card id, such as `BRIO`. It stays the same
   after a reconnect. The card number can change.
4. Record each device of the bench in `inventory.md`.
5. Commit the reports and `inventory.md`, and push your branch. A push
   keeps the work.
