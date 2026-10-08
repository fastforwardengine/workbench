---
name: observe-the-camera
description: Read the frames of a streaming USB camera, or record a USB microphone sound clip, through a sensor server that you own. Use it for bench images, what changed on the bench in the last minutes, build checks, reading the FM radio display, or a recording of the sound of the radio.
---

1. Ask the person to set the microscope to its PC camera mode (UVC).
   Then follow `scan-the-bench` before you open a camera or a microphone.
   Find the USB ID of each camera in the inventory, the resolution, and the
   card id of a microphone, as the README of the `usb-camera` template
   says. Select a camera with `--usb-id`. Do not assume that `/dev/video0`
   is the camera.
2. Fork `usb-camera` with `fork`, with `clone` set to a path in your home. Follow the
   README of the clone for the offline tests, the push, and the start of
   the foreground server. One process owns one USB device and serves its
   camera and its microphone. Keep the data outside the checkout.
3. Start the server with `bash` and a `name`. The workspace sets `$PORT`.
   Check that it runs with `wait({ handles: [handle],
timeout: 0 })`. The server prints no ready line. `fetch` fails until
   the first frame arrives.
4. The bench has two cameras. Run both at the same time, and keep both
   running. Give each camera its own fork, its own process, and its own
   data directory, as the section "Two cameras" of the README says:

   | Camera                    | Fork and process | Widget  | Title        |
   | ------------------------- | ---------------- | ------- | ------------ |
   | Logitech BRIO, overview   | `bench-camera`   | `bench` | Bench camera |
   | TOMLOV TM4K-AF microscope | `scope-camera`   | `scope` | Microscope   |

   Start the microscope with `--resolution 1920x1080` and no
   `--audio-device`. It probably has no microphone. The server streams
   MJPEG, so check that the microscope offers MJPEG at that resolution
   with `v4l2-ctl --list-formats-ext`. The manual of the TM4K family says
   that the microscope has a storage mode (MSDC) and a PC camera mode
   (UVC). These facts about the microscope are unverified. When
   `device-scan` does not find the microscope, run the bench camera only,
   and tell the person that the microscope is missing.

5. Read a camera with `fetch({ process: handle, path: '/camera/observe' })`.
   Your widget reminder names the handle of each shown camera, and `ps`
   names each process. When no camera runs, say so, and start one as
   steps 2 and 3 say. The camera streams all the time. The fetch returns
   the frames that the server kept in the last two minutes, and the newest
   frame, oldest first. The server keeps a frame when the scene changed,
   so the kept frames are a timeline of changes. After two minutes of a
   still bench, the fetch returns only the newest frame.

   Read the text parts first. Each gives the receipt time and the age in
   seconds. A kept frame also gives the share of changed pixels. The text
   of the newest frame names the time of the last change. The text tells
   when the scene changed and how much. Only the frame shows what changed.
   To answer what happened at the bench, read every running camera. Then
   fetch the frames that you need with `/files/<sha256>`, newest first.
   The server drops a frame after two minutes, and `/files` then gives
   status 404. Fetch the frames soon after the observation. For an event
   older than two minutes, use the refs in the room and the notes.

   A frame from earlier in the ring is valid evidence of that time. Name
   its receipt time when you cite it. Cite the snapshot ref of the
   observation and the snapshot ref of each frame that you use. After each
   camera frame that you fetch, post a short message that cites the frame
   ref. The person then sees the photo while you continue the work.

   Read a microphone with `fetch` and the path `/microphone/observe`. A
   microphone request records a clip of `--seconds` seconds and blocks
   for that time. The observation names the clip by `/files/<sha256>`.
   Fetch that path to get the clip. Cite the snapshot ref of the
   observation and the snapshot ref of the clip. Other specialists fetch
   from the same process. Do not share your home or the server URL.

6. After a server answers its first `/camera/observe`, show its camera
   to the person. Show both cameras, each with its own `show`. The example
   shows the bench camera:

   ```ts
   show({
     name: 'bench',
     kind: 'frame',
     source: { type: 'process', handle, path: '/camera/observe' },
     title: 'Bench camera',
     actions: [{ id: 'look', label: 'Look now' }],
   });
   ```

   For the microscope, use the `name` `scope`, the `title` `Microscope`,
   and the handle of `scope-camera`.

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
   widget reminder, and follow step 5. Read the newest frame. Do not ask
   which camera. When its process ended, say so.

7. Ask the person to aim the camera at the bench. Read the frame before
   you describe the bench or the display. No tool reads the digits of the
   display for you. Inspect each image, and report pass, fail, or unclear,
   with the ref. For FM radio path A, frame the display and check that you
   can read every digit before you report a frequency. Report an
   unreadable digit as unclear.
8. Tell the people at the bench before you record a clip. Read a clip
   through its level series first, and then analyze the WAV file in the
   band around the tone, as the README of the clone says.
9. A synthetic demo observation proves the workflow. It is no reading of a
   device. When a fetch gives status 503, check the device and fetch
   again. A frame that you fetched before the failure stays evidence of its
   receipt time. Do not present it as the state of the bench now.
10. Cancel the server before you edit or roll back the running version.
    Validate, commit, push, then start a replacement with `bash`. It
    receives a new port. When it answers, call `show` again with its handle.
    After a host restart, inspect the processes. Fetch from the surviving
    handle. When the old process is gone, start a new server with `bash`, and
    call `show` again with the new handle. The saved refs work after the
    server stops.
