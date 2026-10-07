# USB camera sensor

This template holds `camera.py`, a sensor server for a UVC camera and its
integrated USB microphone on macOS, such as the Logitech BRIO.
It follows the sensor protocol, version 2, of Ambion. The
[sensor contract](https://github.com/ambionframework/ambion/blob/v0.7.0/examples/workbench/docs/sensors.md)
defines the protocol. The
[Ambion 0.7.0 camera-chat example](https://github.com/ambionframework/ambion/tree/v0.7.0/examples/camera-chat)
shows the same lifecycle.
It needs Python 3.11 or newer and `ffmpeg` with AVFoundation. Homebrew
installs `ffmpeg` (`brew install ffmpeg`), and the workstation of the Mac
puts it on the PATH of each seat. `camera.py` has no pip or npm dependency.
macOS asks for camera and microphone permission. See the last section.

One process owns the USB device and serves two sensors: `camera` and
`microphone`. The camera sensor captures one still PNG. The microphone
sensor records one WAV clip. The server serves each request in its own
thread. A request that arrives while a capture of the same sensor runs
waits for that capture and receives the same observation. Otherwise the
request starts a new capture. The upstream Mac example captures five
frames each second. This server has no preview and no captions.

1. Record the USB ID and the AVFoundation name of the camera in the
   inventory of the `device-scan` fork.
2. List the devices. Run `ffmpeg -f avfoundation -list_devices true -i ""`.
   It prints the video devices and the audio devices on stderr, each with an
   index, such as `[1] Logitech BRIO`, and it ends with an error. That is
   normal. `device-scan` prints the same lists. Select a resolution and a
   frame rate that the camera lists. `1280x720` at `30` is the default.
   `ffmpeg` accepts `-framerate` only for a rate that the camera lists. When
   it refuses the rate, the server captures the frame once more with the rate
   that the camera chooses. Give `--framerate` a listed rate to avoid the
   second capture.
   For the microphone, give `--audio-device` the name of the audio device,
   such as `BRIO`, or its index. The name stays the same after a
   reconnect. The index can change. The server records mono, 48 kHz,
   16-bit samples whatever the format of the microphone is.
3. Select the camera. macOS can give a camera a different AVFoundation
   index after a reconnect or a restart. Give `--usb-id` the USB ID from
   the inventory of `device-scan`, such as `046d:085e`. At each capture the
   server asks `system_profiler SPUSBDataType -json` for the name of that
   USB device. On a newer macOS it also reads `SPUSBHostDataType`. The
   server then finds that name in the `ffmpeg` list and uses its index. A
   reconnect needs no restart. A request for a camera that is absent gives
   status 503. A camera whose AVFoundation name differs from its USB name
   also gives status 503. Two cameras with one USB ID give status 503
   too. For these cases, give `--device` the AVFoundation name or the index
   of the camera. The server stops at start when you give both options.
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

6. Start one foreground server with `bash`. Use your fork ID, USB ID,
   resolution, and audio device. Give `--usb-id` or `--device`,
   `--audio-device`, or both. The server serves a sensor for each option you give. Give the
   process a `name`, such as `camera`, so that the process list names it.
   The workspace sets `$PORT` for the process, and the server listens on
   that port. Do not add `&`, `nohup`, `--port`, or a supervisor.

   The USB ID `046d:085e` in the example is the ID of a BRIO. Use the ID
   of your camera.

   ```ts
   bash({
     command: 'cd ~/bench-camera && AMBION_SENSOR_REPOSITORY=engineer/bench-camera AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-camera" python3 -u -B camera.py --usb-id 046d:085e --resolution 1280x720 --audio-device BRIO --seconds 5',
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
   return a frame that started before the call. A capture runs `ffmpeg`,
   skips ten frames so the exposure settles, writes one PNG, and records
   the UTC time of receipt. A failed capture returns status 503
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
   the time that the server launches `ffmpeg`. The timestamp of the
   observation is the receipt time.
10. Know where the server listens. It binds to `127.0.0.1` and the port in
    `$PORT`. It exits at start when `PORT` is absent. `fetch` reaches the
    port through the endpoint of the workspace on the workstation. Do not
    build a tunnel. The in-process
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
    find the tone, analyze the WAV file in the band around it. `fetch` of
    `/files/<sha256>` saves the WAV file under `~/.fetch/camera/` and names
    that path. Analyze it there with `python3` and numpy.
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

## Two cameras

Run one process and use one data directory for each camera. A process
owns one camera and one microphone.

- Fork the template once for each camera, such as `bench-camera` and
  `scope-camera`. Each fork has its own commit history and its own
  `AMBION_SENSOR_REPOSITORY`.
- Give each process a distinct `name`, such as `bench-camera` and
  `scope-camera`, and a distinct `AMBION_SENSOR_DATA_DIR`.
- Give each process the `--usb-id` of its camera. Two cameras of one
  model share an ID. For them, give each process its `--device`, with
  the index from the `ffmpeg` list.
- A UVC camera reserves isochronous USB bandwidth while it streams. Two
  cameras on one USB 2 bus can fail when both capture at once. Plug them
  into separate USB controllers.

## macOS permission

**macOS asks before a program uses a camera or a microphone.** The
permission belongs to the app that starts the program. A seat runs `ffmpeg`
under `sshd` as a hidden account, so no window can show the question. The
capture can fail, or it can stop until the time limit. Nobody has tested
this on the workstation of the Mac. When a capture fails with status 503, run
`ffmpeg` by hand in a session of the same account, and read its error.
