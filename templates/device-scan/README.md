# Device scan

This template finds the devices that the Mac workstation can reach: USB
devices, serial ports, USBTMC instruments, cameras, and microphones. Each
scan writes a report to `scans/`.

Run the scan from the root of the clone, with a `name`, such as `scan`:
`python3 scan/scan.py`. Read its end with `wait`. The scan needs Python 3.11
or newer. It uses `pyserial` for the serial ports, and `ffmpeg` for the
cameras and the microphones. `gphoto2` is optional.

**A report names each device.** It holds the name, the USB ID, the kind, the
location, and the serial number of the device. A USB-serial adapter lists its
`/dev/cu.*` file. A camera or a microphone lists its AVFoundation index.

**The scan reads four sources.**

| Source                                 | Gives                                         |
| -------------------------------------- | --------------------------------------------- |
| `system_profiler SPUSBDataType -json`  | Each USB device: ID, name, serial, location   |
| `serial.tools.list_ports` of pyserial  | The serial ports, such as `/dev/cu.usbserial` |
| `ffmpeg -f avfoundation -list_devices` | The cameras and the microphones, by index     |
| `gphoto2 --auto-detect`                | Cameras that gphoto2 drives, when installed   |

On a newer macOS, the scan reads `SPUSBHostDataType` when
`SPUSBDataType` gives no device.

**The Microphones section lists the audio devices of AVFoundation.** The
name, such as `BRIO`, stays the same after a reconnect. The index can
change.

**The kind of a USB device is an inference in two cases.** macOS gives no
interface class. A USB-serial chip is a vendor ID in a fixed list. An
instrument is a vendor ID of a known maker, and the kind says "probably
USBTMC". A camera or a microphone is a device whose name matches an
AVFoundation device. A report that lacks a tool names it in a `Problem`
line.

**`inventory.md` holds the devices of the bench.** Mark a value that no
scan shows with `TBD`.

Commit, and push your branch. A push keeps the work.
