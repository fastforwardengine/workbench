# USB camera sensor

This template holds `camera.py`, a sensor server for a Linux UVC camera and
its integrated USB microphone, such as the Logitech BRIO.
It follows the sensor protocol, version 2, of Ambion. The
[sensor contract](https://github.com/ambionframework/ambion/blob/v0.7.0/examples/workbench/docs/sensors.md)
defines the protocol. The
[Ambion 0.7.0 camera-chat example](https://github.com/ambionframework/ambion/tree/v0.7.0/examples/camera-chat)
shows the same lifecycle.
It needs Python 3.11 or newer, `v4l2-ctl` and Pillow for the camera, and
`arecord` for the microphone. The workstation has all of them: `v4l2-ctl`
comes from the `v4l-utils` package, Pillow from `python3-pil`, and
`arecord` from `alsa-utils`. The server needs no pip or npm install.

One process owns the USB device and serves two sensors: `camera` and
`microphone`. The camera sensor streams frames all the time, and keeps the
frames of the last two minutes in RAM (section "The camera stream"). The
microphone sensor records one WAV clip for each request. The server
serves each request in its own thread. A microphone request that arrives
while a clip records waits for that clip and receives the same
observation. Otherwise the request starts a new clip. The upstream Mac
example captures five frames each second. This server has no preview and no
captions.

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
3. Select the camera. The kernel can give a camera a different
   `/dev/videoN` number after a reconnect or a reboot. The workstation
   container runs no udev, so it has no `/dev/v4l/by-id/`. There, give
   `--usb-id` the USB ID from the inventory of `device-scan`, such as
   `046d:085e`. The server reads `/sys/class/video4linux` at each start of
   the stream and uses the capture node of that USB device. A reconnect
   needs no restart. The workstation makes the new node within 5 seconds.
   The server tries again each second until the node exists, and a request
   gives status 503 until a frame arrives. Two cameras with one USB ID
   also stop the stream. For them, give `--device`.
   On a host with udev, give `--device` the stable path under
   `/dev/v4l/by-id/`. The server stops at start when you give both
   options.
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
   resolution, and card id. Give `--usb-id` or `--device`, `--audio-device`,
   or both. The server serves a sensor for each option you give. Give the
   process a `name`, such as `camera`, so that the process list names it.
   The workspace sets `$PORT` for the process, and the server listens on
   that port. Do not add `&`, `nohup`, `--port`, or a supervisor.

   The USB ID `046d:085e` in the example is the ID of a BRIO. Use the ID
   of your camera.

   ```ts
   bash({
     command: 'cd ~/bench-camera && AMBION_SENSOR_REPOSITORY=engineer/bench-camera AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench-camera" python3 -u -B camera.py --usb-id 046d:085e --resolution 1280x720 --audio-device plughw:CARD=BRIO,DEV=0 --seconds 5',
     name: 'camera', wait: 0, timeout: 86400,
   });
   ```

7. Check that the server runs with `wait({ handles: [handle], timeout: 0 })`.
   A running process has no exit status. The server prints no ready line.
   It waits for the first streamed frame and records the first clip before
   it listens, so `fetch` fails until both end. The wait for a frame takes
   up to 30 seconds. A clip takes `--seconds` seconds. When no frame
   arrives in 30 seconds, the server prints one line and exits with status
   1. When the server fails at start, `wait` returns the exit status and
   the output holds the reason.
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

9. Know what each `GET /<sensor>/observe` does. A camera request reads
   the ring and starts no capture. It returns the kept frames of the last
   120 seconds and the newest frame, oldest first, each with its UTC time
   of receipt. When no frame arrived for 10 seconds, the request returns
   status 503 and no observation. A microphone request starts a clip, or
   joins the clip that records. A failed clip returns status 503 to every
   request that waits for it. The server closes a connection that stays
   idle for 10 seconds.

   Each microphone request records a clip of `--seconds` seconds. The
   value is an integer from 1 to 30, and the default is 5. The call blocks
   for that time. A camera request does not wait while a clip records. A
   second microphone request during a clip receives that clip. The clip
   is mono, 48 kHz, 16-bit. The observation holds three parts: a text
   with the peak and RMS level in dBFS, the WAV file `clip.wav`, and the
   series `level`. The series holds the RMS level in dBFS of each 10 ms
   window. It starts at the time that the server launches `arecord`. The
   timestamp of the observation is the receipt time.
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
    home. The ring drops a frame after 120 seconds, so fetch the frames
    that you need soon after the observation. Snapshot paths change, so
    cite the refs as evidence. After the server stops, use `restore` on
    the ref of the observation and on the ref of the frame.
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

## The camera stream

**A reader thread streams frames from the camera, and the change rule
decides which frames the ring keeps.** The thread runs this command, with
the node and the `--resolution` of the server:

```sh
v4l2-ctl -d /dev/video0 --set-fmt-video=width=1280,height=720,pixelformat=MJPG \
  --set-parm=5 --stream-mmap --stream-to=-
```

The camera sends MJPEG at 5 frames each second. The thread splits stdout
into JPEG frames at the start marker (`FF D8`) and the end marker
(`FF D9`). A camera that has no MJPEG mode at that resolution gives no
frame: check the modes with `--list-formats-ext`. When the stream ends,
for example after an unplug, the thread waits 1 second, finds the node
again, and starts the stream again. A stop of the server stops `v4l2-ctl`.

- **The change rule.** The thread judges 2 frames each second. It makes a
  grey copy of 64x36 pixels with Pillow and subtracts the mean grey, so a
  change of exposure does not count. A pixel differs when its grey value
  moves by more than 20. The thread keeps a frame when more than 2 % of the
  pixels differ from the last kept frame, and 2 seconds passed since that
  frame. The first frame is kept. A frame that does not decode is skipped.
- **The ring.** The ring holds the kept frames of the last 120 seconds, 60
  frames at most. A frame is the JPEG that the camera sent, with no new
  encode. At 1280x720 a frame has 100 to 200 KB, so the ring holds 6 to
  12 MB. A lock guards the ring, because the server reads it in several
  threads. The ring lives in RAM, and a restart empties it.
- **The observation.** The server answers a camera request with the kept
  frames, and then the newest frame when it is not the last kept frame.
  Each observation has a text part and a `frame` part with
  `mediaType: image/jpeg`. The text gives the receipt time, the age in
  seconds, and the share of changed pixels of a kept frame. On the newest
  frame it says "no change since" the time of the last kept frame, or that
  a change waits for the 2 seconds. The time is the receipt time on the
  workstation. It is no clock of the camera.
- **The files.** `/files/<sha256>` reads the frames in RAM first, and then
  `blobs/`. The server holds each newest frame that an observation named
  for 120 seconds, 20 frames at most, so a `fetch` of that frame works
  after the stream moved on. A frame that left the ring gives status 404.
  The content type follows the first bytes: `image/png`, `image/jpeg`, or
  else `audio/wav`.

The stream holds the camera all the time. Another tool that streams from
the same node, such as `fswebcam`, can fail while the server runs.

## The data directory

The data directory holds the microphone evidence only. A camera frame
writes no blob and no log line. The directory holds two kinds of file:

- `blobs/<sha256>` holds one WAV file for each digest. The
  server writes each blob through a temporary file and renames it, so a
  crash leaves no partial blob. The server replaces a stored blob whose
  bytes do not match its digest.
- `observations.jsonl` holds one line for each clip, with the
  original source metadata and the sensor name. The server only appends to
  it. A lock orders the writes of concurrent clips.

Nothing reads `observations.jsonl` as sensor history. A span read gets
status 422. A restart or a Git rollback keeps both files. No migration,
retention rule, or pruning runs. Choose a new directory when the format
changes. The workspace object store keeps the frames and clips that
`fetch` returned. The owner of the server manages the other files.

`--demo` serves both sensors with fixed synthetic data: a JPEG that the
stream repeats 5 times each second, and a 1 s WAV clip of a 440 Hz tone
that switches on and off 10 times each second. The demo needs no camera and
no Pillow. The scene never changes, so the ring keeps the first frame, and
the newest frame follows it. The discovery text and each observation say
that the data is synthetic. `--demo` still needs a fork ID and an absolute
data directory outside the checkout. Use it to test the workflow when no
camera is present.

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
  model share an ID. For them, give each process its `--device`.
- A UVC camera reserves isochronous USB bandwidth while it streams. The
  stream runs all the time, so the reservation never ends. Two cameras on
  one USB 2 bus can fail when both stream at once. Plug them into separate
  USB controllers.
