---
name: observe-the-camera
description: Capture and keep a USB camera frame or a USB microphone sound clip through a sensor server that you own. Use it for bench images, build checks, reading the FM radio display, or a recording of the sound of the radio.
---

1. Follow `scan-the-bench` before you open a camera or a microphone.
   Find the capture node, the resolution, and the card id as the README of
   the `usb-camera` template says. Do not assume that `/dev/video0` is the
   camera.
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
5. After the server answers its first `/camera/observe`, show the camera
   to the person:

   ```ts
   show({
     name: 'bench',
     kind: 'frame',
     source: { type: 'process', handle, path: '/camera/observe' },
     title: 'Bench camera',
     actions: [{ id: 'look', label: 'Look now' }],
   });
   ```

   The `name` is a short name for the camera. The person says it: "hide
   bench". The `title` is the label of the viewfinder. Do not call `show`
   before the first answer. The viewfinder of the person, `/camera`, reads
   the frame of that process. A `hide({ name })` removes the camera from the
   viewfinder, and the server keeps running. A cancel of the server leaves
   the widget, and the viewfinder then draws nothing.

   The viewfinder draws the action as a button, "Look now". A press arrives
   as a message of the person that starts with the widget name, such as
   `bench, rev 2 "Bench camera": Look now [look]`. Answer it with a new
   observation of that camera: read the handle of that name from your
   widget reminder, and follow step 4. Do not ask which camera. When its
   process ended, say so.

6. Aim the camera at the bench before you capture. Read the frame before
   you describe the bench or the display. No tool reads the digits of the
   display for you. Inspect each image, and report pass, fail, or unclear,
   with the ref. For FM radio path A, frame the display and check that you
   can read every digit before you report a frequency. Report an
   unreadable digit as unclear.
7. Tell the people at the bench before you record a clip. Read a clip
   through its level series first, and then analyze the WAV file in the
   band around the tone, as the README of the clone says.
8. A synthetic demo observation proves the workflow. It is no reading of a
   device. When a capture fails, check the device and fetch again.
   Do not use an earlier image or clip in its place.
9. Cancel the server before you edit or roll back the running version.
   Validate, commit, push, then start a replacement with `bash`. It
   receives a new port. When it answers, call `show` again with its handle.
   After a host restart, inspect the processes. Fetch from the surviving
   handle. When the old process is gone, start a new server with `bash`, and
   call `show` again with the new handle. The saved refs work after the
   server stops.
