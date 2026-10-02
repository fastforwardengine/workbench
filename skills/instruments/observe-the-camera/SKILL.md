---
name: observe-the-camera
description: Capture and keep a USB camera frame or a USB microphone sound clip through a sensor server that you own. Use it for bench images, build checks, reading the FM radio display, or a recording of the sound of the radio.
---

1. Follow `scan-the-bench` before you open a camera or a microphone.
   Select the V4L2 capture node and a supported resolution. Do not assume
   that `/dev/video0` is the camera. Use the path under `/dev/v4l/by-id/` when
   it exists. The workstation container has none, so match the USB ID in
   `v4l2-ctl --list-devices` before each start. For the microphone, run
   `arecord -l` and use `plughw:CARD=<id>,DEV=0` with the card id, such as
   `BRIO`. The card number changes after a reconnect.
2. Fork `usb-camera` with `fork`, and clone it into your home. Follow the
   README of the clone for the offline tests, the push, and the start of
   the foreground server. One process owns one USB device and serves its camera and its microphone.
   Keep the data
   outside the checkout.
3. Wait for READY with `status`. Then `connect` with your process handle
   and the printed port. Only the workstation backend has endpoints.
4. `observe` the qualified sensor, such as `bench/camera` or
   `bench/microphone`. A microphone `observe` records a clip of `--seconds`
   seconds and blocks for that time. Cite the
   manifest snapshot ref that it returns. Other specialists observe through
   the same connection. Do not share your home or the server URL.
5. Read the frame before you describe the bench or the display. Report
   unclear when you cannot read a marking or a digit. For FM radio path A,
   the camera must show every digit of the display. No tool reads the
   digits for you.
   Read a clip through its `level` series: it holds the RMS level in dBFS
   of each 10 ms window, so a pulsed tone shows high and low levels in
   turn. Analyze the exported WAV file with `python3` and numpy in your
   home. Tell the people at the bench before you record.
6. A synthetic demo observation proves the workflow. It is no reading of a
   device. When a capture fails, check the device and observe again.
   Do not use an earlier image or clip in its place.
7. Cancel the server before you edit or roll back the running version.
   Validate, commit, push, then start and connect a replacement.
   `disconnect` leaves the server running. After a host restart, inspect
   the processes and connect again. The saved refs work after the server
   stops.
