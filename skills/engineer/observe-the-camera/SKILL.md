---
name: observe-the-camera
description: Capture and keep a USB camera frame or a USB microphone sound clip through a sensor server that you own. Use it for bench images, build checks, reading the FM radio display, or a recording of the sound of the radio.
---

1. Follow `scan-the-bench` before you open a camera or a microphone.
   Select the V4L2 capture node and a supported resolution. Do not assume
   that `/dev/video0` is the camera. Use the path under `/dev/v4l/by-id/` when
   it exists. Otherwise, match the USB ID in `v4l2-ctl --list-devices`
   before each start. For the microphone, run
   `arecord -l` and use `plughw:CARD=<id>,DEV=0` with the card id, such as
   `BRIO`. The card number changes after a reconnect.
2. Fork `usb-camera` with `fork`, with `clone` set to a path in your home. Follow the
   README of the clone for the offline tests, the push, and the start of
   the foreground server. One process owns one USB device and serves its
   camera and its microphone. Keep the data outside the checkout.
3. Start the server with `bash` and the `name` `camera`. The workspace
   sets `$PORT`. Check that it runs with `wait({ handles: [handle],
timeout: 0 })`. The server prints no ready line. `fetch` fails until
   the first capture ends.
4. Read a sensor with `fetch({ process: handle, path: '/camera/observe' })`
   or `'/microphone/observe'`. A microphone request records a clip of
   `--seconds` seconds and blocks for that time. The observation names each
   file by `/files/<sha256>`. Fetch that path to get the frame or the clip.
   Cite the snapshot ref of the observation and the snapshot ref of the
   frame. After each camera frame, post a short message that cites the
   frame ref. The person then sees the photo while you continue the work.
   Other specialists fetch from the same process. Do not share your home
   or the server URL.
5. Read the frame before you describe the bench or the display. Read a
   frame and a clip as step 12 of the README of the clone says. No tool
   reads the digits of the display for you.
6. A synthetic demo observation proves the workflow. It is no reading of a
   device. When a capture fails, check the device and fetch again.
   Do not use an earlier image or clip in its place.
7. Cancel the server before you edit or roll back the running version.
   Validate, commit, push, then start a replacement with `bash`. It
   receives a new port. After a host restart, inspect the processes and
   fetch from the surviving handle. The saved refs work after the server
   stops.
