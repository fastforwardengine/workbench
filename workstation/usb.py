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

OrbStack can keep an attach that Linux lost, such as after a replug through
a hub. When the workstation container runs, the script counts the USB
devices of each ID that Linux sees, and attaches again each device of an ID
that Linux sees fewer of. It leaves a device that another OrbStack machine
holds, and a detach that fails stops the attach again.
"""

import json
import shutil
from collections import Counter
import subprocess
import sys
from pathlib import Path

IGNORE_FILE = Path(__file__).with_name("usb-ignore")
COMPOSE_FILE = Path(__file__).with_name("compose.yaml")

# The vendor:product ID of each USB device in sysfs.
LIST_IDS = 'for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && echo "$(cat "$d/idVendor"):$(cat "$d/idProduct")"; done'

# The OrbStack machine of the workstation container. `orb usb attach` with no
# machine attaches a device there, and the container then sees the device.
WORKSTATION_MACHINE = "default"

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


def linux_ids():
    """How many USB devices of each vendor:product ID Linux sees, or None when the container does not run."""
    listed = subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE_FILE), "exec", "-T", "workstation", "sh", "-c", LIST_IDS],
        capture_output=True,
        text=True,
    )
    return Counter(listed.stdout.split()) if listed.returncode == 0 else None


def machine_of(bus_id):
    """The OrbStack machine that holds the device, or None when it is with macOS."""
    info = orb("usb", "info", bus_id).stdout
    for line in info.splitlines():
        if line.strip().startswith("Machine:"):
            machine = line.split(":", 1)[1].strip()
            return None if machine == "Not attached" else machine
    return None


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


def lost_ids(devices_, machines, seen):
    """
    The IDs of which Linux sees fewer devices than OrbStack attached to the
    workstation. Two devices of one ID look the same to Linux, so a count and
    not a match finds the one it lost.
    """
    if seen is None:
        return set()
    attached = Counter(label(d)[0] for d in devices_ if machines.get(d["bus_id"]) == WORKSTATION_MACHINE)
    return {usb_id for usb_id, count in attached.items() if seen.get(usb_id, 0) < count}


def plan(action, devices_, machines, seen, skip):
    """
    One step for each device: `keep` (stays with macOS), `elsewhere` (another
    OrbStack machine holds it), `done` (nothing to do), `attach`, `detach`, or
    `reattach` (OrbStack holds it for the workstation, and Linux lost it).
    Each step is (bus_id, name, step, note).
    """
    lost = lost_ids(devices_, machines, seen) if action == "attach" else set()
    steps = []
    for device in devices_:
        usb_id, name = label(device)
        machine = machines.get(device["bus_id"])
        reason = reason_to_keep(device, skip)
        if reason:
            steps.append((device["bus_id"], name, "keep", reason))
        elif machine not in (None, WORKSTATION_MACHINE):
            steps.append((device["bus_id"], name, "elsewhere", machine))
        elif action == "detach":
            steps.append((device["bus_id"], name, "detach" if machine else "done", "with macOS"))
        elif machine and usb_id in lost:
            steps.append((device["bus_id"], name, "reattach", "Linux does not see it"))
        else:
            steps.append((device["bus_id"], name, "done" if machine else "attach", "already attached"))
    return steps


def act(bus_id, name, step, note):
    if step == "keep":
        print(f"usb: {name} stays with macOS: {note}.")
    elif step == "elsewhere":
        print(f"usb: {name} is attached to the OrbStack machine {note}, so it stays there.")
    elif step == "done":
        print(f"usb: {name} is {note}.")
    elif step == "reattach":
        print(f"usb: {name} is attached for the workstation, and {note}. Attaching it again.")
        detached = orb("usb", "detach", bus_id)
        if detached.returncode != 0:
            print(f"usb: detach {name} failed, so it is not attached again: {detached.stderr.strip() or detached.stdout.strip()}.")
            return
        report("attach", name, orb("usb", "attach", bus_id))
    else:
        report(step, name, orb("usb", step, bus_id))


def report(step, name, done):
    outcome = "done" if done.returncode == 0 else f"failed: {done.stderr.strip() or done.stdout.strip()}"
    print(f"usb: {step} {name}: {outcome}.")


def main(action):
    if action not in ("attach", "detach"):
        sys.exit(__doc__)
    if not shutil.which("orb"):
        print("usb: no OrbStack here, so the USB devices are native to Linux.")
        return
    listed = devices()
    machines = {device["bus_id"]: machine_of(device["bus_id"]) for device in listed}
    seen = linux_ids() if action == "attach" else None
    for step in plan(action, listed, machines, seen, ignored()):
        act(*step)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
