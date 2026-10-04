# USB camera sensor

This template holds `camera.py`, a sensor server for a Linux UVC camera and
its integrated USB microphone, such as the Logitech BRIO.
It follows the sensor protocol, version 2, of Ambion. The
[sensor contract](https://github.com/ambionframework/ambion/blob/v0.6.0/docs/sensors.md)
defines the protocol. The
[Ambion 0.6.0 camera-chat example](https://github.com/ambionframework/ambion/tree/v0.6.0/examples/camera-chat)
shows the same lifecycle.
It needs Python 3.11 or newer, `fswebcam`, and `arecord`. The workstation
has all three. It has no pip or npm dependency.

One process owns the USB device and serves two sensors: `camera` and
`microphone`. The camera sensor captures one still PNG. The microphone
sensor records one WAV clip. The server serves each request in its own
thread. A request that arrives while a capture of the same sensor runs
waits for that capture and receives the same observation. Otherwise the
request starts a new capture. The upstream Mac example captures five
frames each second. This server has no preview and no captions.

1. Record the USB ID and the capture node of the camera in the inventory
   of the `device-scan` fork.
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

   The sensor needs a git checkout of the fork and stops at start without
   one.

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

6. Start one foreground server with `bash`. Use your fork ID, node,
   resolution, and card id. Give `--device`, `--audio-device`, or both. The
   server serves a sensor for each option you give. Name the process
   `camera`, so that the viewfinder of the terminal finds it. The workspace
   sets `$PORT` for the process, and the server listens on that port. Do
   not add `&`, `nohup`, `--port`, or a supervisor.

   ```ts
   bash({
     command: 'cd ~/bench-camera && AMBION_SENSOR_REPOSITORY=engineer/bench-camera AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-camera" python3 -u -B camera.py --device /dev/video0 --resolution 1280x720 --audio-device plughw:CARD=BRIO,DEV=0 --seconds 5',
     name: 'camera', wait: 0, timeout: 86400,
   });
   ```

7. Check that the server runs with `wait({ handles: [handle], timeout: 0 })`.
   A running process has no exit status. The server prints no ready line.
   It saves the first frame and the first clip before it listens, so
   `fetch` fails until those captures end. A frame capture takes up to 30
   seconds. A clip takes `--seconds` seconds. When the server fails at
   start, `wait` returns the exit status and the output holds the reason.
   The launch metadata holds the repository, the commit, the branch, and
   the dirty flag. The server reads them once at start. A later commit
   leaves the earlier evidence unchanged.
8. Read the sensors with `fetch`. The `process` is the handle:

   ```ts
   fetch({ process: handle, path: '/' });
   fetch({ process: handle, path: '/camera/observe' });
   fetch({ process: handle, path: '/microphone/observe' });
   ```

   The index at `/` names each sensor and its description. An observation
   names each file part by `/files/<sha256>`. Fetch that path to read the
   file:

   ```ts
   fetch({ process: handle, path: '/files/<sha256>' });
   ```

9. Know what each `GET /<sensor>/observe` does. It starts a capture, or it
   joins the capture that runs for the same sensor. A joined request can
   return a frame that started before the call. A capture writes a new PNG
   at compression level 6, skips ten frames so the exposure settles, and
   records the UTC time of receipt. A failed capture returns status 503
   and no frame, to every request that waits for it. The server closes a
   connection that stays idle for 10 seconds.

   Each microphone request records a clip of `--seconds` seconds. The
   value is an integer from 1 to 30, and the default is 5. The call blocks
   for that time. The camera and the microphone capture in parallel, so a
   camera request does not wait while a clip records. A second microphone
   request during a clip receives that clip. The clip is mono, 48 kHz,
   16-bit. The observation holds three parts: a text with the peak and RMS
   level in dBFS, the WAV file `clip.wav`, and the series `level`. The
   series holds the RMS level in dBFS of each 10 ms window. It starts at
   the time that the server launches `arecord`. The timestamp of the
   observation is the receipt time.
10. Know where the server listens. It binds to `127.0.0.1` and the port in
    `$PORT`. It exits at start when `PORT` is absent. `fetch` reaches the
    port through the endpoint of the workspace on the workstation. Do not
    publish the port in Docker and do not build a tunnel. The in-process
    just-bash backend has no endpoints and no camera runtime.
11. Cite the **snapshot refs** that `fetch` returns for the observation and
    for the frame. `fetch` saves each body in the snapshot store under
    `~/.fetch/camera/`, so no manual snapshot is necessary. Compare the
    digest in the observation with the digest in the path of the frame
    that you fetch. Other specialists fetch from the same process and
    keep snapshots in their own homes. They need no access to the Engineer
    home. Snapshot paths change, so cite the refs as evidence. After the
    server stops, use `restore` on the ref of the observation and on the
    ref of the frame.
12. The server does not crop images, blur faces, or run OCR. The
    microphone hears the room.

    A pulsed tone that is louder than the room shows high and low levels
    in turn in the level series. Room sound, such as speech or a fan, can
    hide that pattern, because the series measures all frequencies. To
    find the tone, analyze the WAV file in the band around it. `fetch` of `/files/<sha256>` saves the WAV file under
    `~/.fetch/camera/` and names that path. Analyze it there with
    `python3` and numpy.
13. Replace the server in this order:
    1. `cancel({ handle })` stops the server.
    2. Edit the checkout. Validate, commit, and push.
    3. Start a new handle with `bash`. To roll back, select an earlier
       commit first. The new process receives a new port.
14. After a host restart, list the processes with `ps` and adopt a
    surviving process. Fetch from its handle. Nothing restarts by itself.

The data directory holds two kinds of file:

- `blobs/<sha256>` holds one PNG or one WAV file for each digest. The
  server writes each blob through a temporary file and renames it, so a
  crash leaves no partial blob. The server replaces a stored blob whose
  bytes do not match its digest.
- `observations.jsonl` holds one line for each capture, with the
  original source metadata and the sensor name. The server only appends to
  it. A lock orders the writes of concurrent captures.

Nothing reads `observations.jsonl` as sensor history. A span read gets
status 422. A restart or a Git rollback keeps both files. No migration,
retention rule, or pruning runs. Choose a new directory when the format
changes. The workspace object store keeps the frames and clips that
`fetch` returned. The owner of the server manages the other files.

`--demo` serves both sensors with fixed synthetic data: a PNG, and a 1 s WAV
clip of a 440 Hz tone that switches on and off 10 times each second. The
discovery text and each observation say that the data is synthetic. `--demo`
still needs a fork ID and an absolute data directory outside the checkout.
Use it to test the workflow when no camera is present.

Commit, and push your branch. A push keeps the work.
