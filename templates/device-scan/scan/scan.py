#!/usr/bin/env python3
"""Find the devices that the Mac workstation can reach, and write a report.

Run it from the root of the clone:

    python3 scan/scan.py                          # USB, serial, cameras, microphones

The scan writes scans/<UTC time>.json and scans/<UTC time>.md, and prints the
Markdown. It changes no setting of a device.

It reads the USB tree from system_profiler, the serial ports from pyserial,
the cameras and the microphones from the AVFoundation list of ffmpeg, and the
cameras of gphoto2 when gphoto2 is installed.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# The data types of system_profiler for USB. A newer macOS can name the second one.
USB_TYPES = ("SPUSBDataType", "SPUSBHostDataType")
VENDOR_KEYS = ("vendor_id", "apple_vendor_id", "USBDeviceKeyVendorID", "idVendor")
PRODUCT_KEYS = ("product_id", "USBDeviceKeyProductID", "idProduct")

# USB-serial chips, by vendor ID. A device with one of them is a serial port.
SERIAL_CHIPS = {
    "0403": "FTDI USB-serial",
    "10c4": "Silicon Labs CP210x USB-serial",
    "1a86": "WCH CH340/CH341 USB-serial",
    "067b": "Prolific PL2303 USB-serial",
}

# Makers of bench instruments that speak USBTMC. macOS has no driver that names the class,
# so the vendor ID is the only sign. The kind says "probably" for that reason.
INSTRUMENT_VENDORS = {
    "1ab1": "Rigol",
    "f4ec": "Siglent",
    "f4ed": "Siglent",
    "0699": "Tektronix",
    "2a8d": "Keysight",
    "0957": "Agilent",
}


def hex_id(entry, keys):
    """The four hex digits in the first of these keys that has a value, such as 0x046d  (Logitech Inc.)."""
    for key in keys:
        found = re.search(r"0x([0-9a-fA-F]{1,4})", str(entry.get(key, "")))
        if found:
            return found.group(1).lower().zfill(4)
    return None


def walk(tree):
    """Every device of the USB tree. An entry with a vendor ID and a product ID is a device."""
    found = []
    if isinstance(tree, dict):
        vendor, product = hex_id(tree, VENDOR_KEYS), hex_id(tree, PRODUCT_KEYS)
        if vendor and product:
            found.append((tree, vendor, product))
        for value in tree.values():
            found += walk(value)
    elif isinstance(tree, list):
        for value in tree:
            found += walk(value)
    return found


def run(command, timeout=60):
    """The finished process of a command, or a line that says why it did not run."""
    if not shutil.which(command[0]):
        return f"{command[0]} is not installed"
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return f"{command[0]} did not end within {timeout} seconds"


def usb_tree():
    """The USB devices of system_profiler, and a problem line when it gives none."""
    problem = ""
    for data_type in USB_TYPES:
        done = run(["system_profiler", data_type, "-json"])
        if isinstance(done, str):
            return [], done
        try:
            devices = walk(json.loads(done.stdout))
        except json.JSONDecodeError:
            problem = f"system_profiler {data_type} gave no JSON"
            continue
        if devices:
            return devices, ""
    return [], problem


def serial_ports():
    """The serial ports of pyserial, or a dict that says why there are none."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return {"error": "pyserial is not installed"}
    return [
        {
            "device": port.device,
            "description": port.description,
            "hwid": port.hwid,
            "usb_id": f"{port.vid:04x}:{port.pid:04x}" if port.vid is not None and port.pid is not None else None,
            "serial": port.serial_number,
        }
        for port in sorted(list_ports.comports(), key=lambda one: one.device)
    ]


def avfoundation():
    """The AVFoundation devices of ffmpeg: {"video": [...], "audio": [...]}, and a problem line.
    ffmpeg prints the list on stderr, and it exits with status 1 because the input is empty."""
    found = {"video": [], "audio": []}
    done = run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], timeout=30)
    if isinstance(done, str):
        return found, done
    kind = None
    for line in (done.stderr + done.stdout).splitlines():
        if "AVFoundation video devices:" in line:
            kind = "video"
        elif "AVFoundation audio devices:" in line:
            kind = "audio"
        entry = re.match(r"\[AVFoundation[^\]]*\]\s+\[(\d+)\]\s+(.+?)\s*$", line)
        if entry and kind:
            found[kind].append({"index": int(entry.group(1)), "name": entry.group(2)})
    problem = "" if found["video"] or found["audio"] else "ffmpeg listed no AVFoundation device"
    return found, problem


def gphoto2():
    """The output of `gphoto2 --auto-detect`, or a line that says why there is none."""
    done = run(["gphoto2", "--auto-detect"])
    return done if isinstance(done, str) else (done.stdout + done.stderr).strip()


def gphoto2_models(listing):
    """The camera models in the table of `gphoto2 --auto-detect`: the text before the port, after the rule."""
    rows = listing.split("\n---", 1)[1].splitlines()[1:] if "\n---" in listing else []
    return [row.rsplit(None, 1)[0].strip() for row in rows if len(row.split()) > 1]


def matches(name, devices):
    """The AVFoundation devices whose name is this name, in any case, or holds it, or is part of it."""
    key = name.casefold()
    found = [one for one in devices if one["name"].casefold() == key]
    return found or [one for one in devices if key in one["name"].casefold() or one["name"].casefold() in key]


def kind_of(entry, vendor, media, models):
    """The kind of a USB device, from its name, its vendor ID, and the lists of ffmpeg and gphoto2."""
    name = str(entry.get("_name", ""))
    if vendor in SERIAL_CHIPS:
        return SERIAL_CHIPS[vendor]
    if vendor in INSTRUMENT_VENDORS:
        return "instrument (probably USBTMC)"
    if media["video"]:
        return "camera (UVC)"
    if name and any(name.casefold() in model.casefold() or model.casefold() in name.casefold() for model in models):
        return "camera (PTP, gphoto2)"
    if entry.get("_items") or "hub" in name.casefold():
        return "hub"
    if media["audio"]:
        return "microphone"
    if entry.get("Media"):
        return "storage"
    if re.search(r"keyboard|mouse|trackpad", name, re.IGNORECASE):
        return "HID"
    return "unknown"


def usb_devices(tree, ports, found, models):
    """Every USB device, with its serial ports and its AVFoundation devices."""
    devices = []
    for entry, vendor, product in tree:
        name = str(entry.get("_name", ""))
        usb_id = f"{vendor}:{product}"
        nodes = [
            {"name": port["device"], "here": os.path.exists(port["device"])}
            for port in ports
            if port["usb_id"] == usb_id and port["serial"] in (None, entry.get("serial_num", port["serial"]))
        ]
        media = {kind: matches(name, found[kind]) if name else [] for kind in found}
        devices.append({
            "port": str(entry.get("location_id", "")),
            "id": usb_id,
            "manufacturer": str(entry.get("manufacturer", "")),
            "product": name,
            "serial": str(entry.get("serial_num", "")),
            "kind": kind_of(entry, vendor, media, models),
            "nodes": nodes,
            "video": media["video"],
            "audio": media["audio"],
        })
    return devices


def listing_lines(devices, empty):
    return [f"- {one['index']}: {one['name']}" for one in devices] or [empty]


def markdown(report):
    lines = [f"# Device scan, {report['time']}", "", f"Host: {report['host']}", "", "## USB", ""]
    if report["errors"].get("usb"):
        lines.append(f"Problem: {report['errors']['usb']}.")
    elif not report["usb"]:
        lines.append("No USB device. Plug one in, and scan again.")
    for device in report["usb"]:
        name = " ".join(filter(None, [device["manufacturer"], device["product"]])) or "(no name)"
        where = f" at {device['port']}" if device["port"] else ""
        lines.append(f"- **{name}** `{device['id']}`{where}: {device['kind']}")
        for node in device["nodes"]:
            lines.append(f"  - `{node['name']}`, {'here' if node['here'] else 'not here'}")
        for kind in ("video", "audio"):
            for one in device[kind]:
                lines.append(f"  - AVFoundation {kind} {one['index']}: {one['name']}")
    lines += ["", "## Serial ports", "", "```", json.dumps(report["serial"], indent=2), "```"]
    lines += ["", "## Cameras", ""]
    lines += listing_lines(report["cameras"], "No AVFoundation video device.")
    lines += ["", "```", report["gphoto2"], "```"]
    lines += ["", "## Microphones", ""]
    lines += listing_lines(report["microphones"], "No AVFoundation audio device.")
    if report["errors"].get("avfoundation"):
        lines += ["", f"Problem: {report['errors']['avfoundation']}."]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="scans", help="the folder of the reports")
    args = parser.parse_args()

    time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    tree, usb_problem = usb_tree()
    ports = serial_ports()
    found, av_problem = avfoundation()
    listing = gphoto2()
    errors = {"usb": usb_problem, "avfoundation": av_problem}
    report = {
        "time": time,
        "host": os.uname().nodename,
        "usb": usb_devices(tree, ports if isinstance(ports, list) else [], found, gphoto2_models(listing)),
        "serial": ports,
        "cameras": found["video"],
        "microphones": found["audio"],
        "gphoto2": listing,
        "errors": {key: value for key, value in errors.items() if value},
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
