# USB camera sensor

This template holds `camera.py`, a sensor server for a Linux UVC camera.
It follows the process, connection, and observation lifecycle of the
[Ambion 0.5.0 camera-chat example](https://github.com/ambionframework/ambion/tree/v0.5.0/examples/camera-chat)
and the [sensor contract](https://github.com/ambionframework/ambion/blob/v0.5.0/docs/sensors.md).
It needs Python 3.11 or newer and `fswebcam`. The workstation has both.
It has no pip or npm dependency.

The server captures one still PNG for each `observe`. The upstream Mac
example captures five frames each second. This server has no preview and
no captions.

1. Follow `scan-the-bench`. Record the USB ID and the capture node of the
   camera in the inventory.
2. Run `v4l2-ctl --list-devices` and
   `v4l2-ctl -d /dev/video0 --list-formats-ext`. Select a video capture
   node and a supported resolution. `/dev/video0` is an example. The
   Instruments account has the `video` group. If no node exists, attach
   the camera and scan again after five seconds.
3. Fork and clone, then make a branch:

   ```ts
   fork({ source: 'templates/usb-camera', name: 'bench-camera', clone: '~/bench-camera' });
   bash({ command: 'cd ~/bench-camera && git switch -c capture' });
   ```

4. Change `camera.py` when the capture needs it. Keep the data outside the
   checkout. Run `python3 -B -m unittest -v test_camera.py` in the clone.
   The tests open no camera. Commit and push the branch before you run
   the saved version:

   ```sh
   git add README.md camera.py test_camera.py
   git commit -m 'Set up bench camera'
   git push -u origin capture
   ```

5. Start one foreground server with the process tools. Use your fork ID,
   node, and resolution. Do not add `&`, `nohup`, or a supervisor.

   ```ts
   bash({
     command: 'cd ~/bench-camera && AMBION_SENSOR_REPOSITORY=instruments/bench-camera AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-camera" python3 -u -B camera.py --device /dev/video0 --resolution 1280x720',
     name: 'bench-camera', wait: 0, timeout: 86400,
   });
   ```

6. Read `status({ handle })` until `READY {"port": ...}` appears. The
   server saves the first frame before it prints READY. A capture takes up
   to 30 seconds. A failed start prints no READY, so read the process
   output. The launch metadata holds the repository, the commit, the
   branch, and the dirty flag. The server reads them once at start. A
   later commit leaves the earlier evidence unchanged.
7. Connect with the process handle and the printed port:

   ```ts
   connect({ name: 'bench', process: handle, port });
   observe({ sensor: 'bench/camera' });
   ```

8. Know what each `observe` does. It captures a new PNG at compression
   level 6, skips ten frames so the exposure settles, and records the UTC
   time of receipt. A failed capture returns 503 and no frame. The server
   closes a connection that stays idle for 10 seconds.
9. Know where the server listens. It binds to `127.0.0.1` on the
   workstation. Ambion forwards the port through SSH. Do not publish the
   port in Docker and do not build a tunnel. The in-process just-bash
   backend has no endpoints and no camera runtime.
10. Cite the **manifest snapshot ref** that `observe` returns. `observe`
    verifies the frame digests. It saves the frame and the manifest in the
    snapshot store, so no manual snapshot is necessary. Other specialists
    observe through the same connection and receive exports in their own
    homes. They need no access to the Instruments home. Export paths
    change, so cite the snapshot refs as evidence. After the server
    stops, use `restore` on the manifest ref and on the frame ref.
11. Aim the camera at the bench before you capture. The server does not
    crop images, blur faces, run OCR, or record audio. Inspect each image.
    Report pass, fail, or unclear, with the ref. For FM radio path A,
    frame the display and check that you can read every digit before you
    report a frequency. Report an unreadable digit as unclear.
12. Replace the server in this order:
    1. `cancel({ handle })` stops the server. `disconnect({ name: 'bench' })`
       only detaches the connection.
    2. Edit the checkout. Validate, commit, and push.
    3. Start a new handle and connect again. To roll back, select an
       earlier commit first.
13. After a host restart, inspect `ps` and adopt a surviving process. Then
    connect again. Nothing restarts or reconnects by itself.

The data directory holds two kinds of file:

- `blobs/<sha256>` holds one PNG for each digest. The server writes each
  blob through a temporary file and renames it, so a crash leaves no
  partial blob. The server replaces a stored blob whose bytes do not match
  its digest.
- `observations.jsonl` holds one line for each observation, with the
  original source metadata. The server only appends to it.

Nothing reads `observations.jsonl` as sensor history. A span read returns
422. A restart or a Git rollback keeps both files. No migration, retention
rule, or pruning runs. Choose a new directory when the format changes.
The workspace object store keeps the frames that `observe` returned. The
owner of the server manages the other frames.

`--demo` replaces the capture with a fixed synthetic PNG. The discovery
text and each observation say that the frame is synthetic. `--demo` still
needs a fork ID and an absolute data directory outside the checkout. Use it
to test the workflow when no camera is present.

Commit, and push your branch. A push keeps the work.
