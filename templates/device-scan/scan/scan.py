#!/usr/bin/env python3
"""Find the devices that the workstation can reach, and write a report.

Run it from the root of the clone:

    python3 scan/scan.py                          # USB, serial, VISA, cameras
    python3 scan/scan.py --identify               # also ask each VISA instrument *IDN?
    python3 scan/scan.py --subnet 192.168.1.0/24  # also look for SCPI ports on a subnet

The scan writes scans/<UTC time>.json and scans/<UTC time>.md, and prints the
Markdown. It changes no setting of a device. `--identify` sends the query
`*IDN?`, which only reads. `--subnet` connects to a few TCP ports of each
address: use it only on the network of the bench, and only when the person
names the subnet.
"""

import argparse
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# The USB devices of the machine. A test names a fake sysfs folder in
# DEVICE_SCAN_SYSFS_USB, so the scan runs with no hardware.
SYSFS_USB = Path(os.environ.get("DEVICE_SCAN_SYSFS_USB", "/sys/bus/usb/devices"))

# USB interface classes that name what a device is.
CLASSES = {
    "02": "serial (CDC-ACM)",
    "0a": "serial (CDC data)",
    "03": "HID",
    "08": "storage",
    "0e": "camera (UVC)",
    "01": "audio",
    "06": "camera (PTP, gphoto2)",
    "ff": "vendor-specific",
}

# USB-serial chips, by vendor ID. A device with one of them is a serial port.
SERIAL_CHIPS = {
    "0403": "FTDI USB-serial",
    "10c4": "Silicon Labs CP210x USB-serial",
    "1a86": "WCH CH340/CH341 USB-serial",
    "067b": "Prolific PL2303 USB-serial",
}

# TCP ports of instruments: raw SCPI, SCPI over telnet, HiSLIP, and the
# portmapper of VXI-11.
SCPI_PORTS = "5025,5024,4880,111"


def read(path):
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def kind_of(vendor, interfaces):
    """The kind of a USB device, from its interfaces and its vendor ID."""
    for interface in interfaces:
        if interface["class"] == "fe" and interface["subclass"] == "03":
            return "instrument (USBTMC)"
    if vendor in SERIAL_CHIPS:
        return SERIAL_CHIPS[vendor]
    for interface in interfaces:
        if interface["class"] in CLASSES:
            return CLASSES[interface["class"]]
    return "unknown"


def nodes_of(device_dir):
    """The /dev names below a USB device, such as ttyUSB0 or video0."""
    names = []
    for sub in ("tty", "video4linux", "usbmisc"):
        for found in device_dir.glob(f"*/{sub}/*"):
            names.append(found.name)
    for found in device_dir.glob("*/tty*"):
        if found.name.startswith("tty") and found.name != "tty":
            names.append(found.name)
    return sorted(set(names))


def interfaces_of(device_dir):
    found = []
    for interface in sorted(device_dir.glob(f"{device_dir.name}:*")):
        driver = interface / "driver"
        found.append({
            "class": read(interface / "bInterfaceClass"),
            "subclass": read(interface / "bInterfaceSubClass"),
            "protocol": read(interface / "bInterfaceProtocol"),
            "driver": os.path.basename(os.readlink(driver)) if driver.exists() else None,
        })
    return found


def usb_devices():
    """Every USB device of the machine, from sysfs. Root hubs stay out."""
    devices = []
    if not SYSFS_USB.exists():
        return devices
    for device_dir in sorted(SYSFS_USB.iterdir()):
        vendor = read(device_dir / "idVendor")
        if not vendor or vendor == "1d6b":
            continue
        interfaces = interfaces_of(device_dir)
        nodes = nodes_of(device_dir)
        bus = int(read(device_dir / "busnum") or 0)
        number = int(read(device_dir / "devnum") or 0)
        usbfs = f"/dev/bus/usb/{bus:03d}/{number:03d}"
        devices.append({
            "port": device_dir.name,
            "id": f"{vendor}:{read(device_dir / 'idProduct')}",
            "manufacturer": read(device_dir / "manufacturer"),
            "product": read(device_dir / "product"),
            "serial": read(device_dir / "serial"),
            "kind": kind_of(vendor, interfaces),
            "interfaces": interfaces,
            "nodes": [{"name": f"/dev/{name}", "here": os.path.exists(f"/dev/{name}")} for name in nodes],
            "usbfs": {"path": usbfs, "here": os.path.exists(usbfs), "writable": os.access(usbfs, os.W_OK)},
        })
    return devices


def serial_ports():
    try:
        from serial.tools import list_ports
    except ImportError:
        return {"error": "pyserial is not installed"}
    return [
        {"device": port.device, "description": port.description, "hwid": port.hwid}
        for port in list_ports.comports()
    ]


def visa_resources(identify):
    try:
        import pyvisa
    except ImportError:
        return {"error": "pyvisa is not installed"}
    try:
        manager = pyvisa.ResourceManager("@py")
        names = list(manager.list_resources())
    except Exception as error:  # A backend fault is a finding of the scan.
        return {"error": str(error)}
    found = []
    for name in names:
        entry = {"resource": name}
        if identify:
            entry["idn"] = query_idn(manager, name)
        found.append(entry)
    return found


def query_idn(manager, name):
    try:
        instrument = manager.open_resource(name, open_timeout=2000)
        instrument.timeout = 2000
        answer = instrument.query("*IDN?").strip()
        instrument.close()
        return answer
    except Exception as error:  # An instrument that does not answer is a finding.
        return f"no answer: {error}"


def run(command):
    """The output of a command, or why it did not run."""
    if not shutil.which(command[0]):
        return f"{command[0]} is not installed"
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return f"{command[0]} did not end within 60 seconds"
    return (done.stdout + done.stderr).strip()


def cameras():
    """The video devices, or a line that says there is none."""
    video = Path("/sys/class/video4linux")
    if not video.exists() or not any(video.iterdir()):
        return "No video device."
    return run(["v4l2-ctl", "--list-devices"])


def network(subnet):
    if not subnet:
        return None
    return run(["nmap", "-Pn", "-p", SCPI_PORTS, "--open", "-oG", "-", subnet])


def markdown(report):
    lines = [f"# Device scan, {report['time']}", "", f"Host: {report['host']}", "", "## USB", ""]
    if not report["usb"]:
        lines.append("No USB device. With OrbStack, attach one with `orb usb attach <id>`.")
    for device in report["usb"]:
        name = " ".join(filter(None, [device["manufacturer"], device["product"]])) or "(no name)"
        lines.append(f"- **{name}** `{device['id']}` at port {device['port']}: {device['kind']}")
        for node in device["nodes"]:
            state = "in the container" if node["here"] else "not in the container: add it to `devices:`"
            lines.append(f"  - `{node['name']}`, {state}")
        usbfs = device["usbfs"]
        access = "read and write" if usbfs["writable"] else "no write access"
        lines.append(f"  - libusb: `{usbfs['path']}`, {access}" if usbfs["here"] else f"  - libusb: `{usbfs['path']}` is not in the container")
    lines += ["", "## Serial ports", "", "```", json.dumps(report["serial"], indent=2), "```"]
    lines += ["", "## VISA resources (pyvisa-py)", "", "```", json.dumps(report["visa"], indent=2), "```"]
    lines += ["", "## Cameras", "", "```", report["v4l2"], "", report["gphoto2"], "```"]
    if report["network"] is not None:
        lines += ["", f"## SCPI ports on {report['subnet']}", "", "```", report["network"], "```"]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--identify", action="store_true", help="ask each VISA instrument *IDN?")
    parser.add_argument("--subnet", help="look for SCPI ports on this subnet, such as 192.168.1.0/24")
    parser.add_argument("--out", default="scans", help="the folder of the reports")
    args = parser.parse_args()

    time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    report = {
        "time": time,
        "host": os.uname().nodename,
        "usb": usb_devices(),
        "serial": serial_ports(),
        "visa": visa_resources(args.identify),
        "v4l2": cameras(),
        "gphoto2": run(["gphoto2", "--auto-detect"]),
        "subnet": args.subnet,
        "network": network(args.subnet),
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{time}.json").write_text(json.dumps(report, indent=2) + "\n")
    text = markdown(report)
    (out / f"{time}.md").write_text(text)
    print(text)
    print(f"Wrote {out / (time + '.json')} and {out / (time + '.md')}.")


if __name__ == "__main__":
    main()
