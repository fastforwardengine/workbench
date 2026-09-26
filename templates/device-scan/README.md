# Device scan

This template finds the devices that the workstation can reach: USB
devices, serial ports, VISA instruments, cameras, and, when the person asks,
the SCPI ports on a subnet. Each scan writes a report to `scans/`.

1. Run the scan from the root of the clone, with a `name`, such as `scan`:
   `python3 scan/scan.py`. Read its end with `wait` or `status`.
2. Add `--identify` to ask each VISA instrument `*IDN?`. The query only
   reads.
3. Add `--subnet <CIDR>` only when the person names the subnet of the
   bench. It connects to the SCPI ports of each address.
4. Report each device: its name, its USB ID, its kind, and whether its
   device file reaches the container. The workstation makes the file of a
   camera, a serial port, or a USBTMC instrument within 5 seconds of its
   arrival, so scan again once when a file is missing.
5. To capture one frame of a camera, run
   `fswebcam -d /dev/video0 -r 1280x720 -S 10 --no-banner scans/<time>.jpg`.
   `-S 10` skips 10 frames, so the exposure settles. `v4l2-ctl -d /dev/video0
   --list-ctrls` lists the controls, such as the exposure and the gain.
6. Record each device of the bench in `inventory.md`.
7. Commit the reports and `inventory.md`, and push your branch. A push
   keeps the work.
