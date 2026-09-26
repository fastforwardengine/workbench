#!/usr/bin/env python3
"""Hand the USB devices of this Mac to OrbStack's Linux, so the workstation
container reaches them, or give them back to macOS.

    python3 workstation/usb.py attach     # `make usb` runs this
    python3 workstation/usb.py detach     # `make usb-detach` runs this

A device that OrbStack attaches leaves macOS until it is detached, except a
serial adapter, which stays usable on both. So the script leaves out:

- an input device, such as a keyboard or a mouse: macOS needs it;
- a billboard device, which a USB-C hub shows and which does nothing;
- each device that workstation/usb-ignore names by its vendor:product ID.

It attaches every other device. On a machine without OrbStack, such as a
Linux bench machine, the devices are native, and the script does nothing.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

IGNORE_FILE = Path(__file__).with_name("usb-ignore")

# The OrbStack categories that stay with macOS.
KEEP_ON_MAC = {"input": "an input device, which macOS needs", "billboard": "a hub's billboard"}


def orb(*args):
    return subprocess.run(["orb", *args], capture_output=True, text=True)


def ignored():
    """The vendor:product IDs of usb-ignore, in lower case."""
    if not IGNORE_FILE.exists():
        return set()
    lines = (line.split("#")[0].strip() for line in IGNORE_FILE.read_text().splitlines())
    return {line.split()[0].lower() for line in lines if line}


def devices():
    listed = orb("usb", "list", "--format", "json")
    if listed.returncode != 0:
        sys.exit(f"orb usb list failed: {listed.stderr.strip()}")
    return json.loads(listed.stdout).get("devices", [])


def attached(bus_id):
    """True when the device is attached to a machine of OrbStack."""
    info = orb("usb", "info", bus_id).stdout
    for line in info.splitlines():
        if line.strip().startswith("Machine:"):
            return line.split(":", 1)[1].strip() != "Not attached"
    return False


def label(device):
    usb_id = f"{device['vendor_id']:04x}:{device['product_id']:04x}"
    return usb_id, f"{device.get('path') or 'USB device'} ({usb_id})"


def reason_to_keep(device, skip):
    usb_id, _ = label(device)
    category = device.get("category", "")
    if category in KEEP_ON_MAC:
        return KEEP_ON_MAC[category]
    if usb_id in skip:
        return f"named in {IGNORE_FILE.name}"
    return None


def main(action):
    if action not in ("attach", "detach"):
        sys.exit(__doc__)
    if not shutil.which("orb"):
        print("usb: no OrbStack here, so the USB devices are native to Linux.")
        return
    skip = ignored()
    for device in devices():
        _, name = label(device)
        reason = reason_to_keep(device, skip)
        if reason:
            print(f"usb: {name} stays with macOS: {reason}.")
            continue
        is_attached = attached(device["bus_id"])
        if (action == "attach") == is_attached:
            print(f"usb: {name} is {'already attached' if is_attached else 'with macOS'}.")
            continue
        done = orb("usb", action, device["bus_id"])
        outcome = "done" if done.returncode == 0 else f"failed: {done.stderr.strip() or done.stdout.strip()}"
        print(f"usb: {action} {name}: {outcome}.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
