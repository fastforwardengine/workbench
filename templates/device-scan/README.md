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
   device file reaches the container. A device whose file does not reach
   the container needs a `devices:` entry in `workstation/compose.yaml`.
5. Record each device of the bench in `inventory.md`.
6. Commit the reports and `inventory.md`, and push your branch. A push
   keeps the work.
