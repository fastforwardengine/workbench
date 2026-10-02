# USB camera sensor

A forkable Linux UVC camera server for Workbench's Instruments account.
Its process, connection, and observation lifecycle follows the tagged
[Ambion 0.5.0 camera-chat example](https://github.com/ambionframework/ambion/tree/v0.5.0/examples/camera-chat)
and [sensor contract](https://github.com/ambionframework/ambion/blob/v0.5.0/docs/sensors.md).
The acquisition adapter uses Python 3.11+ and `fswebcam`, already installed
in the Workbench workstation. There are no pip or npm dependencies.
Unlike the upstream Mac example, capture is on demand, not five frames per
second. This is a still-image sensor; it supplies no preview or captions.

1. Follow `scan-the-bench`. Record the camera's USB ID and capture node in
   the inventory. As Instruments, run `v4l2-ctl --list-devices` and
   `v4l2-ctl -d /dev/video0 --list-formats-ext`. Select a video capture node
   and a supported resolution; `/dev/video0` here is an example, not a
   default. Instruments has the `video` group. If no node is present,
   attach the camera to the workstation and scan again after five seconds.
2. Fork and clone, then make a branch:

   ```ts
   fork({ source: 'templates/usb-camera', name: 'bench-camera', clone: '~/bench-camera' });
   bash({ command: 'cd ~/bench-camera && git switch -c capture' });
   ```

3. Customize `camera.py` for acquisition or reduction. Keep data outside
   the checkout. Run `python3 -B -m unittest -v test_camera.py` in the clone.
   These tests never open a camera. Commit the code and push the branch
   before running a saved version:

   ```sh
   git add README.md camera.py test_camera.py
   git commit -m 'Set up bench camera'
   git push -u origin capture
   ```

4. Start one foreground server with the process tools. Use the actual
   fork ID, node, and resolution. Do not add `&`, `nohup`, or a supervisor.

   ```ts
   bash({
     command: 'cd ~/bench-camera && AMBION_SENSOR_REPOSITORY=instruments/bench-camera AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-camera" python3 -u -B camera.py --device /dev/video0 --resolution 1280x720',
     name: 'bench-camera', wait: 0, timeout: 86400,
   });
   ```

   Read `status({ handle })` until `READY {"port": ...}` appears. The
   first usable frame is saved before READY. Capture can take up to 30
   seconds. Startup failures produce no READY; inspect the process output.
   Launch metadata captures repository, commit, branch, and dirty status
   once. A later commit does not relabel earlier evidence.

5. Connect with that process handle and the printed remote sensor port:

   ```ts
   connect({ name: 'bench', process: handle, port });
   observe({ sensor: 'bench/camera' });
   ```

   Each observe acquires a new PNG, skips ten frames for exposure settling,
   and records UTC receipt time, not a hardware exposure timestamp. A
   failed acquisition returns 503 and never substitutes an older frame.
   The workstation server binds only to `127.0.0.1`; Ambion forwards through
   SSH. Do not publish the sensor port in Docker or construct a tunnel.
   The in-process just-bash backend has no endpoints or camera runtime.

6. Cite the returned **manifest snapshot ref**. `observe` verifies frame
   digests and retains the frame and manifest automatically; no extra
   manual snapshot is required. Other specialists can observe the same
   connection and receive exports in their own homes. They need no access
   to Instruments' private home. Use `restore` on the manifest and its
   frame snapshot ref after the server stops. Export paths are mutable;
   cite retained refs as evidence.

7. Aim the camera at the bench before starting capture. This template does
   not crop images or blur faces automatically. For build guidance, inspect the image and report pass, fail, or unclear
   with its ref. For FM radio path A, frame the display and check that every
   digit is legible before reporting a frequency. This template performs
   no OCR and makes no claim about unreadable digits. It captures no audio.

8. `disconnect({ name: 'bench' })` detaches without stopping capture service;
   `cancel({ handle })` stops it. Stop before editing the running checkout.
   Validate, commit, push, start a new handle, and reconnect to replace it.
   Rollback selects a prior commit, then starts and connects a new process.
   After a host restart, inspect `ps`, adopt a surviving process if needed,
   and connect explicitly; no automatic restart or reconnect occurs.

The acquisition directory holds immutable `blobs/<sha256>` and append-only
`observations.jsonl` with each observation's original source metadata.
Nothing reads that log as sensor history; span reads return 422. Restart
and Git rollback preserve it. No data migration, retention policy, or
pruning runs automatically. Choose a new directory if changing its format.
Only successfully observed evidence is retained by the workspace object
store; unobserved acquisition stays the server owner's responsibility.

`--demo` replaces capture with a deterministic synthetic PNG. Both discovery
and every observation label it as synthetic, never a bench measurement.
It still requires a fork ID and an absolute data directory outside the
checkout. Use it to validate the full workflow when hardware is absent.


Workbench protocol validation: `pnpm exec vitest run test/usb-camera-protocol.test.ts`
runs Ambion's `sensorConformance` and standard digest-verifying client
against this server with a fixed synthetic acquisition clock. The optional
`WORKBENCH_WORKSTATION=.workstation/workstation.json pnpm exec vitest run test/usb-camera-workstation.test.ts`
checks fork, save, launch, connect, cross-account observation, cancellation,
and restoration after changing an export. Neither opens camera hardware.

Commit, and push your branch. A push keeps the work.
