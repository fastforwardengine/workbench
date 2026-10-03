# USB camera sensor

This template holds `camera.py`, a sensor server for a Linux UVC camera and
its integrated USB microphone, such as the Logitech BRIO.
It follows the process, connection, and observation lifecycle of the
[Ambion 0.5.0 camera-chat example](https://github.com/ambionframework/ambion/tree/v0.5.0/examples/camera-chat)
and the [sensor contract](https://github.com/ambionframework/ambion/blob/v0.5.0/docs/sensors.md).
It needs Python 3.11 or newer, `fswebcam`, and `arecord`. The workstation
has all three. It has no pip or npm dependency.

One process owns the USB device and serves two sensors: `camera` and
`microphone`. The camera sensor captures one still PNG for each `observe`.
The microphone sensor records one WAV clip for each `observe`. The upstream
Mac example captures five frames each second. This server has no preview and
no captions.

1. Follow `scan-the-bench`. Record the USB ID and the capture node of the
   camera in the inventory.
2. Run `v4l2-ctl --list-devices` and
   `v4l2-ctl -d /dev/video0 --list-formats-ext`. Select a video capture
   node and a supported resolution. `/dev/video0` is an example. The
   Engineer account has the `video` group. If no node exists, attach
   the camera and scan again after five seconds.
   For the microphone, run `arecord -l`. A line such as
   `card 1: BRIO [Logitech BRIO]` names the card id `BRIO`. The card id
   stays the same after a reconnect. The card number can change. Give
   `--audio-device` the name `plughw:CARD=BRIO,DEV=0`, with your card id.
   Do not use a card number. The `plughw` plug-in converts the sound to
   mono, 48 kHz, 16-bit samples. The Engineer account has the `audio`
   group.
3. Give `--device` the path of that node. The kernel can give a camera a
   different `/dev/videoN` number after a reconnect or a reboot. On a host
   with udev, use the stable path under `/dev/v4l/by-id/`. The workstation
   container runs no udev, so it has no `/dev/v4l/by-id/`. There, match
   the USB ID in `v4l2-ctl --list-devices` to the node before each start.
4. Fork and clone, then make a branch:

   ```ts
   fork({ source: 'templates/usb-camera', name: 'bench-camera', clone: '~/bench-camera' });
   bash({ command: 'cd ~/bench-camera && git switch -c capture' });
   ```

5. Change `camera.py` when the capture needs it. Keep the data outside the
   checkout. Run `python3 -B -m unittest -v test_camera.py` in the clone.
   The tests open no camera. Commit your changes, if there are any. Then
   push the branch before you run the saved version. The push also runs
   when there is nothing to commit:

   ```sh
   git add README.md camera.py test_camera.py
   git diff --cached --quiet || git commit -m 'Set up bench camera'
   git push -u origin capture
   ```

6. Start one foreground server with the process tools. Use your fork ID,
   node, resolution, and card id. Give `--device`, `--audio-device`, or
   both. The server serves a sensor for each option you give. Do not add
   `&`, `nohup`, or a supervisor.
   The server needs a git checkout of the fork and stops at start without
   one.

   ```ts
   bash({
     command: 'cd ~/bench-camera && AMBION_SENSOR_REPOSITORY=engineer/bench-camera AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-camera" python3 -u -B camera.py --device /dev/video0 --resolution 1280x720 --audio-device plughw:CARD=BRIO,DEV=0 --seconds 5',
     name: 'bench-camera', wait: 0, timeout: 86400,
   });
   ```

7. Read `status({ handle })` until `READY {"port": ...}` appears. The
   server saves the first frame and the first clip before it prints READY. A
   frame capture takes up to 30 seconds. A clip takes `--seconds` seconds. A
   failed start prints no READY, so read the process output. The launch
   metadata holds the repository, the commit, the branch, and the dirty
   flag. The server reads them once at start. A later commit leaves the
   earlier evidence unchanged.
8. Connect with the process handle and the printed port:

   ```ts
   connect({ name: 'bench', process: handle, port });
   observe({ sensor: 'bench/camera' });
   observe({ sensor: 'bench/microphone' });
   ```

9. Know what each `observe` does. It captures a new PNG at compression
   level 6, skips ten frames so the exposure settles, and records the UTC
   time of receipt. A failed capture returns 503 and no frame. The server
   closes a connection that stays idle for 10 seconds.

   Each microphone `observe` records a clip of `--seconds` seconds. The
   value is an integer from 1 to 30, and the default is 5. The call blocks
   for that time. The server handles one request at a time, so a camera
   `observe` waits while a clip records. The clip is mono, 48 kHz, 16-bit.
   The observation holds three parts: a text with the peak and RMS level in
   dBFS, the WAV file `clip.wav`, and the series `level`. The series holds
   the RMS level in dBFS of each 10 ms window. It starts at the time that
   the server launches `arecord`. The timestamp of the observation is the
   receipt time.
10. Know where the server listens. It binds to `127.0.0.1` on the
    workstation. Ambion forwards the port through SSH. Do not publish the
    port in Docker and do not build a tunnel. The in-process just-bash
    backend has no endpoints and no camera runtime.
11. Cite the **manifest snapshot ref** that `observe` returns. `observe`
    verifies the frame digests. It saves the frame and the manifest in the
    snapshot store, so no manual snapshot is necessary. Other specialists
    observe through the same connection and receive exports in their own
    homes. They need no access to the Engineer home. Export paths
    change, so cite the snapshot refs as evidence. After the server
    stops, use `restore` on the manifest ref and on the frame ref.
12. Aim the camera at the bench before you capture. The server does not
    crop images, blur faces, or run OCR. The microphone hears the room.
    Tell the people at the bench before you record. Inspect each image.
    Report pass, fail, or unclear, with the ref. For FM radio path A,
    frame the display and check that you can read every digit before you
    report a frequency. Report an unreadable digit as unclear.

    Read a clip through its level series first. A pulsed tone that is
    louder than the room shows high and low levels in turn. Room sound,
    such as speech or a fan, can hide that pattern, because the series
    measures all frequencies. Then analyze the WAV file in the band around
    the tone. `observe` exports the WAV file to the home of the observer
    under a name such as `file-001.bin`, and names that path. Analyze it
    there with `python3` and numpy.
13. Replace the server in this order:
    1. `cancel({ handle })` stops the server. `disconnect({ name: 'bench' })`
       only detaches the connection.
    2. Edit the checkout. Validate, commit, and push.
    3. Start a new handle and connect again. To roll back, select an
       earlier commit first.
14. After a host restart, inspect `ps` and adopt a surviving process. Then
    connect again. Nothing restarts or reconnects by itself.

The data directory holds two kinds of file:

- `blobs/<sha256>` holds one PNG or one WAV file for each digest. The
  server writes each blob through a temporary file and renames it, so a
  crash leaves no partial blob. The server replaces a stored blob whose
  bytes do not match its digest.
- `observations.jsonl` holds one line for each observation, with the
  original source metadata and the sensor name. The server only appends to
  it.

Nothing reads `observations.jsonl` as sensor history. A span read gets
status 422. A restart or a Git rollback keeps both files. No migration,
retention rule, or pruning runs. Choose a new directory when the format
changes. The workspace object store keeps the frames and clips that
`observe` returned. The owner of the server manages the other files.

`--demo` serves both sensors with fixed synthetic data: a PNG, and a 1 s WAV
clip of a 440 Hz tone that switches on and off 10 times each second. The
discovery text and each observation say that the data is synthetic. `--demo`
still needs a fork ID and an absolute data directory outside the checkout.
Use it to test the workflow when no camera is present.

Commit, and push your branch. A push keeps the work.
