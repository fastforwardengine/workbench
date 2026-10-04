# Device scan

This template finds the devices that the workstation can reach: USB devices,
serial ports, USBTMC instruments, cameras, and microphones. Each scan writes
a report to `scans/`.

Run the scan from the root of the clone, with a `name`, such as `scan`:
`python3 scan/scan.py`. Read its end with `wait`.

**A report names each device.** It holds the name, the USB ID, the kind, and
whether the device file reaches the workstation. The workstation makes the
file of a camera, a microphone, a serial port, or a USBTMC instrument
within 5 seconds of its arrival.

**The Microphones section lists the microphones.** `arecord -l` shows the
same list. The card id, such as `BRIO`, stays the same after a reconnect.
The card number can change.

**`inventory.md` holds the devices of the bench.** Mark a value that no
scan shows with `TBD`.

Commit, and push your branch. A push keeps the work.
