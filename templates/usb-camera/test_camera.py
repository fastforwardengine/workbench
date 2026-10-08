"""Offline checks. No device is opened; synthetic evidence only."""
import copy
import hashlib
import importlib.util
import io
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from array import array
from pathlib import Path
from unittest.mock import patch

import camera

SOURCE = {"repository": "engineer/bench-camera", "commit": "a" * 40, "dirty": False}
FLAT = [100] * 2304
HAS_PILLOW = importlib.util.find_spec("PIL") is not None


def scene(left, top, width=16, height=12, level=200, base=100):
    """A 64x36 grey copy: a flat field with one bright block."""
    return [level if left <= x < left + width and top <= y < top + height else base
            for y in range(36) for x in range(64)]


def jpeg(number):
    """Bytes that look like a JPEG to the splitter and the file route. The ring does not decode them."""
    return b"\xff\xd8\xff" + bytes([number]) * 40 + b"\xff\xd9"


def digest_of(data):
    return hashlib.sha256(data).hexdigest()


class Clock:
    """A clock that the test moves."""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def stamp(seconds):
    return f"2026-01-01T00:00:{seconds:06.3f}Z"


class Pipe:
    """The stdout of a fake process: each read returns the next chunk, then the end of the stream."""

    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.closed = False

    def read1(self, _size):
        return self.chunks.pop(0) if self.chunks else b""

    def close(self):
        self.closed = True


class FakeProcess:
    """Stands in for v4l2-ctl. With `hold`, the stream stays open until terminate."""

    def __init__(self, chunks, hold=False):
        self.stdout = Pipe(chunks)
        self.hold = threading.Event() if hold else None
        self.terminated = False
        if hold:
            self.stdout.read1 = self.waiting(self.stdout.read1)

    def waiting(self, read1):
        def read(size):
            return read1(size) or (self.hold.wait(10) and b"")
        return read

    def terminate(self):
        self.terminated = True
        if self.hold:
            self.hold.set()

    kill = terminate

    def wait(self, timeout=None):
        return 0


def serve(served, timeout=10):
    """Run the server of `served` in a thread. Returns the root URL and a function that stops it."""
    server = camera.open_server(served, timeout=timeout)
    thread = threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True)
    thread.start()

    def stop():
        server.shutdown()
        server.server_close()
        thread.join()
    return f"http://127.0.0.1:{server.server_port}", stop


def get(root, path, method="GET"):
    """One request. Returns the status and the JSON body, or the bytes of a file."""
    request = urllib.request.Request(root + path, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data = response.read()
        kind = response.headers.get_content_type()
        return response.status, data if kind in ("image/png", "image/jpeg", "audio/wav") else json.loads(data)


class CameraTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.source = copy.deepcopy(SOURCE)
        self.camera = camera.Camera(copy.deepcopy(self.source), self.folder.name, None, demo=True)
        self.clock = Clock()
        self.camera.ring = camera.Ring(self.clock)
        self.running = False
        self.start_server()
        self.addCleanup(self.stop_server)

    def start_server(self, served=None, timeout=10):
        self.root, self.stop = serve(served or self.camera, timeout)
        self.running = True

    def stop_server(self):
        if self.running:
            self.running = False
            self.stop()

    def request(self, path, method="GET"):
        return get(self.root, path, method)

    def offer(self, data=camera.DEMO_JPEG, grey=camera.DEMO_GREY, seconds=1.0):
        self.clock.now += seconds
        self.camera.ring.offer(data, grey, stamp(self.clock.now % 60))

    def test_discovery_and_a_frame_that_lives_in_ram(self):
        status, index = self.request("/")
        self.assertEqual(status, 200)
        self.assertEqual(index["api"], 2)
        self.assertEqual(index["source"], self.source)
        self.assertEqual([(sensor["name"], sensor["spans"]) for sensor in index["sensors"]], [("camera", False), ("microphone", False)])
        self.offer()
        status, body = self.request("/camera/observe")
        self.assertEqual(status, 200)
        self.assertEqual(body["api"], 2)
        observation = body["observations"][0]
        self.assertIn("SYNTHETIC", observation["parts"][0]["text"])
        self.assertEqual(observation["parts"][1]["mediaType"], "image/jpeg")
        digest = observation["parts"][1]["file"]
        status, frame = self.request("/files/" + digest)
        self.assertEqual(status, 200)
        self.assertEqual(frame, camera.DEMO_JPEG)
        self.assertEqual(digest_of(frame), digest)
        # A camera frame writes no blob and no log line.
        self.assertEqual([path.name for path in Path(self.folder.name).iterdir()], ["blobs"])
        self.assertEqual(list((Path(self.folder.name) / "blobs").iterdir()), [])

    def test_the_server_binds_to_loopback(self):
        server = camera.open_server(self.camera)
        self.addCleanup(server.server_close)
        self.assertEqual(server.server_address[0], "127.0.0.1")

    def test_content_type_follows_the_bytes(self):
        self.assertEqual(camera.media_type(camera.DEMO_JPEG), "image/jpeg")
        self.assertEqual(camera.media_type(b"\x89PNG\r\n\x1a\n"), "image/png")
        self.assertEqual(camera.media_type(b"RIFF....WAVE"), "audio/wav")
        self.assertEqual(camera.media_type(b"\xff\xd8"), "audio/wav")

    def test_invalid_queries_unknown_paths_and_unsupported_spans(self):
        self.offer()
        first, second = "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"
        for query in [f"from={second}&to={first}", f"from={first}&to={first}", f"from={first}", f"to={second}",
                      "from=x&to=y", "from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
                      "from=2026-02-30T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
                      f"from={first}&to={second}&limit=1", f"from={first}&from={first}&to={second}", "from&to", "x=1"]:
            status, body = self.request("/camera/observe?" + query)
            self.assertEqual((status, body["code"], body["api"]), (400, "invalid", 2), query)
        status, body = self.request(f"/camera/observe?from={first}&to={second}")
        self.assertEqual((status, body["code"], body["api"]), (422, "unavailable", 2))
        self.assertEqual(self.request("/camera/observe?")[0], 200)
        for path, method in [("/missing", "GET"), ("/camera", "GET"), ("/radio/observe", "GET"),
                             ("/files/" + "0" * 64, "GET"), ("/files/../../camera.py", "GET"),
                             ("/files/" + "A" * 64, "GET"), ("/camera/observe", "POST"), ("/", "DELETE")]:
            status, body = self.request(path, method)
            self.assertEqual((status, body["code"], body["api"]), (404, "unknown", 2), f"{method} {path}")
            self.assertIsInstance(body["message"], str)

    def test_a_clip_on_disk_still_serves_next_to_a_frame_in_ram(self):
        self.offer()
        status, body = self.request("/microphone/observe")
        self.assertEqual(status, 200)
        digest = body["observations"][0]["parts"][1]["file"]
        self.assertEqual(self.request("/files/" + digest), (200, camera.demo_wav()))

    def test_idle_connection_does_not_block_observe(self):
        self.offer()
        self.stop_server()
        self.start_server(timeout=0.5)
        with socket.create_connection(("127.0.0.1", int(self.root.rsplit(":", 1)[1]))):
            self.assertEqual(self.request("/camera/observe")[0], 200)

    def check_unavailable(self):
        status, body = self.request("/camera/observe")
        self.assertEqual(status, 503)
        self.assertEqual((body["code"], body["api"]), ("unavailable", 2))
        self.assertNotIn("observations", body)
        self.assertFalse((Path(self.folder.name) / "observations.jsonl").exists())

    def test_no_frame_yet_gives_503(self):
        self.check_unavailable()

    def test_a_stale_stream_gives_503(self):
        self.offer()
        self.assertEqual(self.request("/camera/observe")[0], 200)
        self.clock.now += camera.STALE_SECONDS - 0.5
        self.assertEqual(self.request("/camera/observe")[0], 200)
        self.clock.now += 1
        self.check_unavailable()
        self.offer()
        self.assertEqual(self.request("/camera/observe")[0], 200)

    def test_live_observation_names_the_device_and_the_receipt_time(self):
        live = camera.Camera(self.source, self.folder.name, "/dev/video4", "640x480")
        live.ring = self.camera.ring
        self.offer()
        observation = live.frames()[0]
        self.assertEqual(observation["at"], stamp(self.clock.now % 60))
        self.assertEqual(observation["parts"][0]["text"],
                         "USB camera /dev/video4; timestamp is receipt time. "
                         f"Received {stamp(self.clock.now % 60)}, 0.0 s ago. Kept: the first frame of the stream.")

    def test_launch_source_stays_fixed_when_branch_advances(self):
        with tempfile.TemporaryDirectory() as folder:
            def git(*args):
                return subprocess.check_output(["git", "-C", folder, *args], text=True).strip()
            git("init", "-b", "capture")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            path = Path(folder) / "code.txt"
            path.write_text("first")
            git("add", ".")
            git("commit", "-m", "first")
            path.write_text("dirty")
            source = camera.launch_source(folder, "engineer/bench-camera")
            self.assertTrue(source["dirty"])
            self.assertEqual(source["branch"], "capture")
            git("commit", "-am", "second")
            self.assertNotEqual(source["commit"], git("rev-parse", "HEAD"))
            self.assertTrue(source["dirty"])
            git("checkout", "--detach")
            self.assertNotIn("branch", camera.launch_source(folder, "engineer/bench-camera"))
            with self.assertRaises(ValueError):
                camera.launch_source(folder, "templates/usb-camera")


def wav_bytes(samples, channels=1, rate=48000):
    output = io.BytesIO()
    with wave.open(output, "wb") as clip:
        clip.setnchannels(channels)
        clip.setsampwidth(2)
        clip.setframerate(rate)
        clip.writeframes(array("h", samples).tobytes())
    return output.getvalue()


class ConcurrencyTests(unittest.TestCase):
    """Requests overlap. A request for a clip waits only for a clip. A request for the camera waits for nothing."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.camera = camera.Camera(SOURCE, self.folder.name, None, demo=True)
        self.camera.ring.offer(camera.DEMO_JPEG, camera.DEMO_GREY, stamp(1))
        self.root, stop = serve(self.camera)
        self.release = threading.Event()
        self.addCleanup(stop)
        self.addCleanup(self.release.set)
        self.captures = []
        self.entered = threading.Semaphore(0)
        self.arrivals = threading.Semaphore(0)
        original_record = camera.Camera.record
        original_observe = camera.Camera.observe

        def record(served):
            self.captures.append("microphone")
            self.entered.release()
            if self.held:
                self.assertTrue(self.release.wait(10))
            if self.failing:
                raise OSError("device lost")
            return original_record(served)

        def observe(served, sensor):
            self.arrivals.release()
            return original_observe(served, sensor)

        self.held = True
        self.failing = False
        for name, function in (("record", record), ("observe", observe)):
            patcher = patch.object(camera.Camera, name, function)
            patcher.start()
            self.addCleanup(patcher.stop)

    def request(self, path):
        return get(self.root, path)

    def ask(self, sensor, results):
        thread = threading.Thread(target=lambda: results.append(self.request(f"/{sensor}/observe")))
        thread.start()
        self.addCleanup(thread.join)
        return thread

    def wait_for(self, semaphore, count=1):
        for _ in range(count):
            self.assertTrue(semaphore.acquire(timeout=5))

    def test_requests_for_one_sensor_share_the_capture_in_flight(self):
        results = []
        self.ask("microphone", results)
        self.wait_for(self.entered)
        self.ask("microphone", results)
        self.wait_for(self.arrivals, 2)
        self.release.set()
        self.assertTrue(self.wait_for_result(results, 2))
        self.assertEqual(self.captures, ["microphone"])
        self.assertEqual([status for status, _body in results], [200, 200])
        self.assertEqual(results[0][1], results[1][1])
        log = (Path(self.folder.name) / "observations.jsonl").read_text().splitlines()
        self.assertEqual(len(log), 1)

    def wait_for_result(self, results, count):
        for _ in range(500):
            if len(results) >= count:
                return True
            threading.Event().wait(0.01)
        return False

    def test_a_request_after_the_capture_ends_starts_a_new_capture(self):
        self.held = False
        self.assertEqual(self.request("/microphone/observe")[0], 200)
        self.assertEqual(self.request("/microphone/observe")[0], 200)
        self.assertEqual(self.captures, ["microphone", "microphone"])

    def test_a_camera_request_does_not_wait_for_a_microphone_clip(self):
        clip = []
        self.ask("microphone", clip)
        self.wait_for(self.entered)
        status, body = self.request("/camera/observe")
        self.assertEqual(status, 200)
        self.assertEqual(body["observations"][0]["parts"][1]["kind"], "frame")
        self.assertEqual(clip, [])
        self.release.set()
        self.assertTrue(self.wait_for_result(clip, 1))
        self.assertEqual(clip[0][0], 200)
        self.assertEqual(self.captures, ["microphone"])

    def test_drain_waits_for_the_captures_in_flight(self):
        results = []
        self.ask("microphone", results)
        self.wait_for(self.entered)
        drained = threading.Event()
        waiter = threading.Thread(target=lambda: (self.camera.drain(), drained.set()))
        waiter.start()
        self.addCleanup(waiter.join)
        self.assertFalse(drained.wait(0.2))
        self.release.set()
        self.assertTrue(drained.wait(5))
        self.assertTrue(self.wait_for_result(results, 1))

    def test_drain_returns_at_once_when_no_capture_runs(self):
        self.camera.drain()

    def test_a_failed_capture_gives_503_to_every_waiting_request(self):
        results = []
        self.failing = True
        self.ask("microphone", results)
        self.wait_for(self.entered)
        self.ask("microphone", results)
        self.wait_for(self.arrivals, 2)
        self.release.set()
        self.assertTrue(self.wait_for_result(results, 2))
        self.assertEqual([status for status, _body in results], [503, 503])
        self.assertEqual(self.captures, ["microphone"])


class LevelTests(unittest.TestCase):
    def test_demo_clip_is_a_valid_deterministic_wav(self):
        clip = camera.demo_wav()
        self.assertEqual(clip, camera.demo_wav())
        with wave.open(io.BytesIO(clip)) as parsed:
            self.assertEqual((parsed.getnchannels(), parsed.getsampwidth(), parsed.getframerate()), (1, 2, 48000))
            self.assertEqual(parsed.getnframes(), 48000)

    def test_silence_is_at_the_floor(self):
        peak, rms, envelope = camera.clip_levels(wav_bytes([0] * 4800))
        self.assertEqual((peak, rms), (-120.0, -120.0))
        self.assertEqual(envelope, [-120.0] * 10)

    def test_full_scale_square_is_about_zero_dbfs(self):
        peak, rms, envelope = camera.clip_levels(wav_bytes([32767, -32768] * 960))
        self.assertEqual((peak, rms), (0.0, 0.0))
        self.assertEqual(len(envelope), 4)

    def test_gated_tone_alternates_high_and_low_windows(self):
        peak, _rms, envelope = camera.clip_levels(camera.demo_wav())
        self.assertEqual(len(envelope), 100)
        self.assertAlmostEqual(peak, -6.0, delta=0.1)
        # The gate is on for 50 ms and off for 50 ms: five windows each.
        self.assertTrue(all(level > -12 for level in envelope[0:5]))
        self.assertTrue(all(level == -120.0 for level in envelope[5:10]))
        self.assertTrue(all(level > -12 for level in envelope[10:15]))

    def test_wrong_format_is_a_value_error(self):
        for clip in [wav_bytes([1] * 100, channels=2), wav_bytes([1] * 100, rate=44100),
                     wav_bytes([]), b"not a wav"]:
            with self.assertRaises(ValueError):
                camera.clip_levels(clip)


class MicrophoneTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.source = {"repository": "engineer/bench-camera", "commit": "a" * 40, "dirty": False}
        self.running = False
        self.addCleanup(self.stop_server)

    def start_server(self, served):
        self.served = served
        self.server = camera.open_server(served)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True)
        self.thread.start()
        self.running = True
        self.root = f"http://127.0.0.1:{self.server.server_port}"

    def stop_server(self):
        if self.running:
            self.running = False
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()

    def request(self, path):
        try:
            response = urllib.request.urlopen(self.root + path, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def live(self, **options):
        return camera.Camera(self.source, self.folder.name, None, audio_device="plughw:CARD=BRIO,DEV=0", **options)

    def test_demo_observation_has_text_file_and_series(self):
        self.start_server(camera.Camera(self.source, self.folder.name, None, demo=True))
        status, body = self.request("/microphone/observe")
        self.assertEqual(status, 200)
        text, file, series = body["observations"][0]["parts"]
        self.assertTrue(text["text"].startswith("SYNTHETIC DEMO:"))
        self.assertEqual(file, {"kind": "file", "file": hashlib.sha256(camera.demo_wav()).hexdigest(),
                                "name": "clip.wav", "mediaType": "audio/wav"})
        self.assertEqual((series["channel"], series["unit"], series["intervalMs"]), ("level", "dBFS", 10))
        self.assertEqual(len(series["values"]), 100)
        with urllib.request.urlopen(self.root + "/files/" + file["file"], timeout=5) as response:
            self.assertEqual(response.headers.get_content_type(), "audio/wav")
            self.assertEqual(response.read(), camera.demo_wav())
        log = (Path(self.folder.name) / "observations.jsonl").read_text().splitlines()
        self.assertEqual(json.loads(log[0])["sensor"], "microphone")

    def test_truncated_blob_is_replaced_atomically(self):
        self.start_server(camera.Camera(self.source, self.folder.name, None, demo=True))
        digest = hashlib.sha256(camera.demo_wav()).hexdigest()
        blobs = Path(self.folder.name) / "blobs"
        (blobs / digest).write_bytes(camera.demo_wav()[:10])
        self.assertEqual(self.request("/microphone/observe")[0], 200)
        self.assertEqual((blobs / digest).read_bytes(), camera.demo_wav())
        self.assertEqual([path.name for path in blobs.iterdir()], [digest])

    def test_arecord_arguments_and_timestamps(self):
        clip = wav_bytes([1000, -1000] * 24000)
        def fake(command, **kwargs):
            self.assertEqual(command[:12], ["arecord", "-q", "-D", "plughw:CARD=BRIO,DEV=0", "-f", "S16_LE",
                                            "-r", "48000", "-c", "1", "-d", "3"])
            self.assertEqual(command[12:14], ["-t", "wav"])
            self.assertEqual((kwargs["timeout"], kwargs["check"]), (18, True))
            Path(command[-1]).write_bytes(clip)
        times = iter(["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:03.050Z"])
        with patch("camera.subprocess.run", side_effect=fake), patch("camera.utc", side_effect=lambda: next(times)):
            observation = self.live(seconds=3).record()
        self.assertEqual(observation["at"], "2026-01-01T00:00:03.050Z")
        text, file, series = observation["parts"]
        self.assertIn("USB microphone plughw:CARD=BRIO,DEV=0; 3 s clip", text["text"])
        self.assertNotIn("SYNTHETIC", text["text"])
        self.assertEqual(series["from"], "2026-01-01T00:00:00.000Z")
        self.assertEqual(file["file"], hashlib.sha256(clip).hexdigest())
        self.assertEqual(Path(self.folder.name, "blobs", file["file"]).read_bytes(), clip)

    def test_fake_arecord_on_path(self):
        with tempfile.TemporaryDirectory() as bin_dir:
            script = Path(bin_dir) / "arecord"
            clip = Path(bin_dir) / "source.wav"
            clip.write_bytes(wav_bytes([500] * 4800))
            script.write_text(f'#!/bin/sh\nfor last; do :; done\ncp "{clip}" "$last"\n')
            script.chmod(0o755)
            with patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ["PATH"]}):
                observation = self.live().record()
        self.assertEqual(len(observation["parts"][2]["values"]), 10)

    def test_bad_capture_gives_503_and_keeps_nothing(self):
        self.start_server(self.live())
        for clip in [wav_bytes([1] * 100, channels=2), wav_bytes([1] * 100, rate=44100)]:
            def fake(command, *, clip=clip, **_kwargs):
                Path(command[-1]).write_bytes(clip)
            with patch("camera.subprocess.run", side_effect=fake):
                status, body = self.request("/microphone/observe")
            self.assertEqual((status, body["code"], body["api"]), (503, "unavailable", 2))
            self.assertIn("Microphone", body["message"])
        with patch("camera.subprocess.run", side_effect=subprocess.TimeoutExpired("arecord", 20)):
            self.assertEqual(self.request("/microphone/observe")[0], 503)
        self.assertFalse((Path(self.folder.name) / "observations.jsonl").exists())
        self.assertEqual([path.name for path in Path(self.folder.name).iterdir()], ["blobs"])

    def test_index_lists_only_configured_sensors(self):
        def names():
            return [sensor["name"] for sensor in self.request("/")[1]["sensors"]]

        self.start_server(self.live())
        self.assertEqual(names(), ["microphone"])
        self.assertEqual(self.request("/camera/observe")[0], 404)
        self.stop_server()
        self.start_server(camera.Camera(self.source, self.folder.name, "/dev/video4"))
        self.assertEqual(names(), ["camera"])
        self.assertEqual(self.request("/microphone/observe")[0], 404)
        self.assertEqual(self.request("/radio/observe")[0], 404)
        self.stop_server()
        self.start_server(camera.Camera(self.source, self.folder.name, None, demo=True))
        self.assertEqual(names(), ["camera", "microphone"])

    def test_span_gives_422(self):
        self.start_server(camera.Camera(self.source, self.folder.name, None, demo=True))
        span = "from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z"
        self.assertEqual(self.request("/microphone/observe?" + span)[0], 422)


class ChangeRuleTests(unittest.TestCase):
    """The change rule is a pure function on grey copies of 2304 ints. It needs no Pillow and no numpy."""

    def test_the_first_frame_is_kept(self):
        self.assertEqual(camera.judge(None, FLAT, 0), (True, None))

    def test_a_still_scene_keeps_nothing(self):
        noisy = [value + (index % 5) - 2 for index, value in enumerate(FLAT)]
        keep, share = camera.judge(FLAT, noisy, 60)
        self.assertEqual((keep, share), (False, 0.0))

    def test_a_step_of_brightness_keeps_nothing(self):
        before = scene(10, 10)
        for step in (30, -30, 55):
            keep, share = camera.judge(before, [value + step for value in before], 60)
            self.assertEqual((keep, share), (False, 0.0), step)

    def test_a_moved_block_keeps_one_frame(self):
        keep, share = camera.judge(scene(10, 10), scene(40, 20), 60)
        self.assertTrue(keep)
        self.assertAlmostEqual(share, 2 * 16 * 12 / 2304)

    def test_a_change_under_the_share_keeps_nothing(self):
        # A block of 5x10 pixels is 2.2 % of the copy and over the limit. A block of 4x10 is 1.7 % and under it.
        self.assertTrue(camera.judge(FLAT, scene(10, 10, 5, 10), 60)[0])
        self.assertFalse(camera.judge(FLAT, scene(10, 10, 4, 10), 60)[0])

    def test_a_pixel_must_move_more_than_the_delta(self):
        # A block that rises by the delta moves less than the delta after the mean leaves. One that rises by twice moves more.
        self.assertEqual(camera.changed_share(FLAT, scene(10, 10, level=100 + camera.PIXEL_DELTA)), 0.0)
        self.assertEqual(camera.changed_share(FLAT, scene(10, 10, level=100 + 2 * camera.PIXEL_DELTA)), 192 / 2304)

    def test_the_gap_holds_a_frame_until_min_gap_passed(self):
        before, after = scene(10, 10), scene(40, 20)
        self.assertFalse(camera.judge(before, after, camera.MIN_GAP - 0.1)[0])
        self.assertTrue(camera.judge(before, after, camera.MIN_GAP)[0])

    def test_the_mean_leaves_the_copy(self):
        grey = scene(10, 10)
        self.assertAlmostEqual(sum(camera.centered(grey)), 0.0, places=6)


class SplitterTests(unittest.TestCase):
    def test_two_frames_in_one_read(self):
        splitter = camera.Splitter()
        self.assertEqual(splitter.feed(jpeg(1) + jpeg(2)), [jpeg(1), jpeg(2)])

    def test_a_frame_split_across_reads(self):
        splitter = camera.Splitter()
        data = jpeg(1) + jpeg(2)
        frames = []
        for start in range(0, len(data), 7):
            frames += splitter.feed(data[start:start + 7])
        self.assertEqual(frames, [jpeg(1), jpeg(2)])

    def test_a_marker_split_between_two_reads(self):
        splitter = camera.Splitter()
        frame = jpeg(3)
        self.assertEqual(splitter.feed(b"junk\xff"), [])
        self.assertEqual(splitter.feed(frame[1:-1]), [])
        self.assertEqual(splitter.feed(frame[-1:]), [frame])

    def test_junk_between_frames_goes_away(self):
        splitter = camera.Splitter()
        self.assertEqual(splitter.feed(b"junk" + jpeg(1) + b"\x00\x01noise" + jpeg(2) + b"tail"), [jpeg(1), jpeg(2)])
        self.assertEqual(splitter.buffer, b"")

    def test_the_buffer_stays_bounded_without_an_end_marker(self):
        splitter = camera.Splitter()
        with patch("camera.FRAME_LIMIT", 100):
            self.assertEqual(splitter.feed(b"\xff\xd8" + b"x" * 200), [])
            self.assertEqual(splitter.buffer, b"")
            self.assertEqual(splitter.feed(b"x" * 500 + jpeg(4)), [jpeg(4)])
        self.assertEqual(splitter.feed(b"x" * 100_000), [])
        self.assertEqual(len(splitter.buffer), 0)


class RingTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.ring = camera.Ring(self.clock)

    def offer(self, number, grey, seconds=1.0):
        self.clock.now += seconds
        self.ring.offer(jpeg(number), grey, stamp(self.clock.now % 60))

    def test_a_still_scene_keeps_the_first_frame_only(self):
        for number in range(10):
            self.offer(number, FLAT, 0.5)
        kept, extra, last_at = self.ring.snapshot()
        self.assertEqual([frame.jpeg for frame in kept], [jpeg(0)])
        self.assertEqual(extra.jpeg, jpeg(9))
        self.assertEqual(last_at, kept[0].at)
        self.assertIsNone(kept[0].share)

    def test_a_frame_that_skips_the_rule_is_the_newest_frame_only(self):
        self.offer(0, FLAT)
        self.offer(1, None)
        kept, extra, _last = self.ring.snapshot()
        self.assertEqual(len(kept), 1)
        self.assertEqual(extra.jpeg, jpeg(1))

    def test_a_moved_block_is_kept_after_the_gap(self):
        self.offer(0, scene(10, 10))
        self.offer(1, scene(40, 20), 0.5)  # The change comes at once. The gap holds the frame.
        kept, extra, _last = self.ring.snapshot()
        self.assertEqual(len(kept), 1)
        self.assertGreater(extra.share, camera.CHANGED_SHARE)
        self.offer(2, scene(40, 20), camera.MIN_GAP)
        kept, extra, _last = self.ring.snapshot()
        self.assertEqual([frame.jpeg for frame in kept], [jpeg(0), jpeg(2)])
        self.assertIsNone(extra)
        self.offer(3, scene(40, 20), 0.5)
        self.assertEqual(len(self.ring.snapshot()[0]), 2)

    def test_the_ring_drops_a_frame_after_ring_seconds(self):
        self.offer(0, scene(10, 10))
        self.offer(1, scene(40, 20), 3)
        self.assertEqual(len(self.ring.snapshot()[0]), 2)
        self.clock.now += camera.RING_SECONDS - 2
        self.offer(2, scene(40, 20), 0)
        self.assertEqual([frame.jpeg for frame in self.ring.snapshot()[0]], [jpeg(1)])
        self.assertIsNone(self.ring.find(digest_of(jpeg(0))))
        self.assertEqual(self.ring.find(digest_of(jpeg(1))), jpeg(1))

    def test_the_ring_holds_ring_max_frames(self):
        with patch("camera.RING_SECONDS", 10_000):
            for number in range(camera.RING_MAX + 5):
                self.offer(number, scene(40 * (number % 2), 0), camera.MIN_GAP)
        kept = self.ring.snapshot()[0]
        self.assertEqual(len(kept), camera.RING_MAX)
        self.assertEqual(kept[-1].jpeg, jpeg(camera.RING_MAX + 4))
        self.assertIsNone(self.ring.find(digest_of(jpeg(0))))

    def test_the_last_kept_time_stays_after_the_ring_drops_the_frame(self):
        self.offer(0, FLAT)
        first = self.ring.snapshot()[0][0].at
        for number in range(1, 5):
            self.offer(number, FLAT, 40)
        kept, extra, last_at = self.ring.snapshot()
        self.assertEqual(kept, [])
        self.assertEqual(last_at, first)
        self.assertEqual(extra.jpeg, jpeg(4))

    def test_a_stale_stream_raises_and_a_new_frame_recovers(self):
        with self.assertRaises(ValueError):
            self.ring.snapshot()
        self.offer(0, FLAT)
        self.clock.now += camera.STALE_SECONDS + 1
        with self.assertRaises(ValueError):
            self.ring.snapshot()
        self.offer(1, None)
        self.assertEqual(self.ring.snapshot()[1].jpeg, jpeg(1))

    def test_the_newest_frame_that_an_observation_named_stays_readable(self):
        self.offer(0, FLAT)
        self.offer(1, None)
        named = self.ring.snapshot()[1]
        self.offer(2, None)
        self.offer(3, None)
        self.assertEqual(self.ring.find(named.digest), jpeg(1))
        self.assertIsNone(self.ring.find(digest_of(jpeg(2))))  # No observation named this frame.
        self.clock.now += camera.RING_SECONDS + 1
        self.assertIsNone(self.ring.find(named.digest))


class ObserveTests(unittest.TestCase):
    """The observation of the camera sensor: kept frames, then the newest frame, oldest first."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.clock = Clock()
        self.camera = camera.Camera(SOURCE, self.folder.name, None, demo=True)
        self.camera.ring = camera.Ring(self.clock)
        self.root, stop = serve(self.camera)
        self.addCleanup(stop)

    def offer(self, number, grey, seconds=1.0):
        self.clock.now += seconds
        self.camera.ring.offer(jpeg(number), grey, stamp(self.clock.now % 60))

    def observe(self):
        status, body = get(self.root, "/camera/observe")
        self.assertEqual(status, 200)
        return body["observations"]

    def test_kept_frames_come_first_and_the_newest_frame_comes_last(self):
        self.offer(0, scene(10, 10))
        self.offer(1, scene(40, 20), 5)
        self.offer(2, scene(10, 10), 5)
        self.offer(3, scene(10, 10), 0.4)
        observations = self.observe()
        self.assertEqual([item["parts"][1]["file"] for item in observations],
                         [digest_of(jpeg(number)) for number in (0, 1, 2, 3)])
        self.assertEqual([item["at"] for item in observations], sorted(item["at"] for item in observations))
        texts = [item["parts"][0]["text"] for item in observations]
        self.assertIn("Kept: the first frame of the stream.", texts[0])
        self.assertIn("Kept: 16.7 % of the pixels changed since the previous kept frame.", texts[1])
        self.assertIn("0.4 s ago", texts[2])
        self.assertIn("0.0 s ago", texts[3])
        self.assertIn(f"Not kept: no change since {observations[2]['at']}.", texts[3])
        for item in observations:
            self.assertEqual([part["kind"] for part in item["parts"]], ["text", "frame"])
            self.assertEqual(item["parts"][1]["mediaType"], "image/jpeg")
            self.assertIn("SYNTHETIC DEMO", item["parts"][0]["text"])

    def test_the_newest_frame_is_not_listed_twice_when_the_ring_kept_it(self):
        self.offer(0, scene(10, 10))
        self.offer(1, scene(40, 20), 5)
        observations = self.observe()
        self.assertEqual(len(observations), 2)
        self.assertEqual(observations[-1]["parts"][1]["file"], digest_of(jpeg(1)))

    def test_a_change_inside_the_gap_says_so(self):
        self.offer(0, scene(10, 10))
        self.offer(1, scene(40, 20), 0.5)
        text = self.observe()[-1]["parts"][0]["text"]
        self.assertIn("Not kept yet: 16.7 % of the pixels differ from the kept frame of", text)

    def test_the_status_of_a_newest_frame_before_any_kept_frame_has_no_none(self):
        frame = camera.Frame(stamp(1), 1.0, jpeg(1), digest_of(jpeg(1)), 0.0)
        text = camera.newest_status(frame, None)
        self.assertNotIn("None", text)
        self.assertEqual(text, "Not kept: the ring kept no frame yet.")

    def test_files_come_from_ram_and_a_frame_that_left_the_ring_gives_404(self):
        self.offer(0, scene(10, 10))
        self.offer(1, scene(40, 20), 5)
        old, new = (digest_of(jpeg(number)) for number in (0, 1))
        self.assertEqual(get(self.root, "/files/" + old), (200, jpeg(0)))
        self.assertEqual(get(self.root, "/files/" + new), (200, jpeg(1)))
        self.clock.now += camera.RING_SECONDS - 4
        self.offer(2, scene(40, 20), 0)
        self.assertEqual(get(self.root, "/files/" + old)[0], 404)
        self.assertEqual(get(self.root, "/files/" + new)[0], 200)
        self.assertEqual(sorted(path.name for path in Path(self.folder.name).iterdir()), ["blobs"])

    def test_the_newest_frame_stays_readable_after_the_next_frame(self):
        self.offer(0, scene(10, 10))
        self.offer(1, None, 0.2)
        named = self.observe()[-1]["parts"][1]["file"]
        self.offer(2, None, 0.2)
        self.assertEqual(get(self.root, "/files/" + named), (200, jpeg(1)))

    def test_the_microphone_clip_is_the_only_file_on_disk(self):
        self.offer(0, scene(10, 10))
        self.observe()
        self.assertEqual(list((Path(self.folder.name) / "blobs").iterdir()), [])
        self.assertEqual(get(self.root, "/microphone/observe")[0], 200)
        self.assertEqual(len(list((Path(self.folder.name) / "blobs").iterdir())), 1)
        lines = (Path(self.folder.name) / "observations.jsonl").read_text().splitlines()
        self.assertEqual([json.loads(line)["sensor"] for line in lines], ["microphone"])


class ReaderTests(unittest.TestCase):
    """The reader thread, with a fake process in place of v4l2-ctl."""

    def setUp(self):
        self.ring = camera.Ring()
        self.launched = []
        self.processes = []
        self.resolved = []

    def resolve(self):
        self.resolved.append(len(self.resolved))
        return f"/dev/video{2 * len(self.resolved) - 2}"

    def launch(self, node):
        self.launched.append(node)
        return self.processes.pop(0)

    def reader(self, decode=lambda _jpeg: camera.DEMO_GREY):
        reader = camera.Reader(self.ring, self.resolve, self.launch, decode, pause=0.01)
        self.addCleanup(reader.stop)
        return reader

    def wait_for(self, condition):
        for _ in range(500):
            if condition():
                return
            threading.Event().wait(0.01)
        self.fail("The condition did not hold.")

    def test_the_stream_splits_into_frames_and_the_first_frame_is_kept(self):
        self.processes = [FakeProcess([b"junk" + jpeg(1)[:9], jpeg(1)[9:] + jpeg(2)], hold=True)]
        reader = self.reader()
        reader.start()
        self.wait_for(lambda: self.ring.newest is not None and self.ring.newest.jpeg == jpeg(2))
        kept, extra, _last = self.ring.snapshot()
        self.assertEqual([frame.jpeg for frame in kept], [jpeg(1)])
        self.assertEqual(extra.jpeg, jpeg(2))  # The second frame came inside DETECT_PERIOD: no rule.
        self.assertEqual(extra.share, 0.0)

    def test_a_frame_that_does_not_decode_is_skipped(self):
        process = FakeProcess([jpeg(1) + jpeg(2)], hold=True)
        self.processes = [process]
        reader = self.reader(decode=lambda _jpeg: None)
        reader.start()
        self.wait_for(lambda: process.stdout.chunks == [])
        threading.Event().wait(0.05)
        self.assertIsNone(self.ring.newest)
        self.assertFalse(self.ring.arrived.is_set())

    def test_a_frame_that_is_not_due_must_look_like_a_jpeg(self):
        clock = Clock()
        self.ring = camera.Ring(clock)
        reader = camera.Reader(self.ring, self.resolve, self.launch, lambda _jpeg: camera.DEMO_GREY)
        reader.take(jpeg(1))  # Due: the first frame.
        clock.now += 0.01
        for junk in (b"junk", jpeg(2)[:-2], jpeg(2)[1:], b"\xff\xd8" + b"\x00" * 8 + b"\xff\xd9"):
            reader.take(junk)
            self.assertEqual(self.ring.newest.jpeg, jpeg(1))
        reader.take(jpeg(3))
        self.assertEqual(self.ring.newest.jpeg, jpeg(3))

    def test_a_decode_that_raises_restarts_the_stream(self):
        def decode(data):
            if data == jpeg(1):
                raise RuntimeError("Surprise.")
            return camera.DEMO_GREY

        self.processes = [FakeProcess([jpeg(1)]), FakeProcess([jpeg(2)], hold=True)]
        reader = self.reader(decode=decode)
        reader.start()
        self.wait_for(lambda: self.ring.newest is not None and self.ring.newest.jpeg == jpeg(2))
        self.assertEqual(len(self.launched), 2)
        self.assertTrue(reader.is_alive())
        self.assertEqual(reader.problem, "Surprise.")

    def test_stop_kills_a_process_that_outlives_the_wait(self):
        killed = threading.Event()

        class Stubborn(FakeProcess):
            def terminate(self):
                self.terminated = True  # The process ignores terminate.

            def kill(self):
                killed.set()
                self.hold.set()

        self.processes = [Stubborn([jpeg(1)], hold=True)]
        reader = self.reader()
        reader.start()
        self.wait_for(lambda: self.ring.arrived.is_set())
        reader.stop(timeout=0.05)
        self.assertTrue(killed.is_set())
        reader.join(timeout=5)
        self.assertFalse(reader.is_alive())

    def test_the_stream_restarts_after_it_ends_and_resolves_the_node_again(self):
        self.processes = [FakeProcess([jpeg(1)]), FakeProcess([jpeg(2)]), FakeProcess([jpeg(3)], hold=True)]
        launched = list(self.processes)
        reader = self.reader()
        reader.start()
        self.wait_for(lambda: len(self.launched) == 3 and self.ring.newest.jpeg == jpeg(3))
        self.assertEqual(self.launched, ["/dev/video0", "/dev/video2", "/dev/video4"])
        self.assertTrue(all(process.terminated and process.stdout.closed for process in launched[:2]))
        self.assertEqual(reader.problem, "The stream ended.")

    def test_a_camera_that_is_absent_is_retried(self):
        answers = [ValueError("No capture node has USB ID 046d:085e."), "/dev/video6"]

        def resolve():
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        self.processes = [FakeProcess([jpeg(1)], hold=True)]
        reader = camera.Reader(self.ring, resolve, self.launch, lambda _jpeg: camera.DEMO_GREY, pause=0.01)
        self.addCleanup(reader.stop)
        reader.start()
        self.wait_for(lambda: self.ring.arrived.is_set())
        self.assertEqual(self.launched, ["/dev/video6"])

    def test_a_failed_start_is_kept_as_the_problem(self):
        def launch(_node):
            raise FileNotFoundError("v4l2-ctl")

        reader = camera.Reader(self.ring, lambda: "/dev/video0", launch, lambda _jpeg: None, pause=0.01)
        self.addCleanup(reader.stop)
        reader.start()
        self.wait_for(lambda: reader.problem)
        self.assertEqual(reader.problem, "v4l2-ctl")

    def test_stop_ends_the_process_and_the_thread(self):
        self.processes = [FakeProcess([jpeg(1)], hold=True)]
        reader = self.reader()
        reader.start()
        self.wait_for(lambda: self.ring.arrived.is_set())
        reader.stop()
        self.assertFalse(reader.is_alive())
        self.assertTrue(self.launched and not self.processes)

    def test_the_rule_runs_about_two_times_each_second(self):
        clock = Clock()
        self.ring = camera.Ring(clock)
        decoded = []
        reader = camera.Reader(self.ring, self.resolve, self.launch, lambda data: decoded.append(data) or camera.DEMO_GREY)
        for number in range(5 * camera.STREAM_FPS):  # Five seconds of frames.
            clock.now += 1 / camera.STREAM_FPS
            reader.take(jpeg(number))
        self.assertIn(len(decoded), range(8, 11))
        self.assertEqual(self.ring.newest.jpeg, jpeg(5 * camera.STREAM_FPS - 1))

    def test_the_stream_command(self):
        self.assertEqual(camera.stream_command("/dev/video2", "1920x1080"),
                         ["v4l2-ctl", "-d", "/dev/video2", "--set-fmt-video=width=1920,height=1080,pixelformat=MJPG",
                          "--set-parm=5", "--stream-mmap", "--stream-to=-"])
        with patch("camera.subprocess.Popen") as popen:
            process = camera.start_stream("/dev/video2", "640x480")
        self.assertIs(process, popen.return_value)
        self.assertEqual(popen.call_args.args[0][:3], ["v4l2-ctl", "-d", "/dev/video2"])
        self.assertEqual(popen.call_args.kwargs["stdout"], subprocess.PIPE)


@unittest.skipUnless(HAS_PILLOW, "Pillow is not installed.")
class DecodeTests(unittest.TestCase):
    def test_the_demo_frame_decodes_to_a_grey_copy_of_the_scene(self):
        grey = camera.grey_of(camera.DEMO_JPEG)
        self.assertEqual(len(grey), 2304)
        error = sum(abs(one - other) for one, other in zip(grey, camera.DEMO_GREY)) / 2304
        self.assertLess(error, 10)

    def test_a_frame_that_does_not_decode_gives_none(self):
        self.assertIsNone(camera.grey_of(b"not a jpeg"))
        self.assertIsNone(camera.grey_of(camera.DEMO_JPEG[:300]))
        self.assertIsNone(camera.grey_of(b""))

    def test_a_frame_that_claims_a_huge_size_gives_none(self):
        data = bytearray(camera.DEMO_JPEG)
        marker = next(at for at in range(len(data) - 9) if data[at] == 0xFF and data[at + 1] in (0xC0, 0xC1, 0xC2))
        data[marker + 5:marker + 9] = (60000).to_bytes(2, "big") * 2  # Height and width of the SOF segment.
        self.assertIsNone(camera.grey_of(bytes(data)))


class FakeSysfs:
    """A sysfs tree in a temporary folder: USB devices under `devices`, capture nodes under `video4linux`."""

    def __init__(self, base):
        self.base = Path(base)
        self.root = self.base / "video4linux"
        self.root.mkdir(parents=True)

    def usb(self, name, usb_id):
        """One USB device with one interface. Returns the interface folder."""
        vendor, product = usb_id.split(":")
        device = self.base / "devices" / "usb1" / name
        interface = device / f"{name}:1.0"
        interface.mkdir(parents=True, exist_ok=True)
        (device / "idVendor").write_text(vendor + "\n")
        (device / "idProduct").write_text(product + "\n")
        return interface

    def node(self, number, interface, index=0):
        folder = self.root / f"video{number}"
        folder.mkdir()
        (folder / "index").write_text(f"{index}\n")
        (folder / "device").symlink_to(os.path.relpath(interface, folder))

    def camera(self, name, usb_id, first):
        """A UVC camera: a capture node and a metadata node on one interface."""
        interface = self.usb(name, usb_id)
        self.node(first, interface, 0)
        self.node(first + 1, interface, 1)

    def clear(self):
        for folder in self.root.iterdir():
            for link in folder.iterdir():
                link.unlink()
            folder.rmdir()


class UsbIdTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.sysfs = FakeSysfs(self.folder / "sys")
        self.sysfs.camera("1-1", "046d:085e", 0)
        self.sysfs.camera("1-2", "1234:abcd", 2)
        self.source = {"repository": "engineer/bench-camera", "commit": "a" * 40, "dirty": False}
        self.data = self.folder / "data"

    def live(self, usb_id="046d:085e"):
        return camera.Camera(self.source, self.data, None, usb_id=usb_id)

    def test_the_capture_node_is_the_one_with_index_0(self):
        self.assertEqual(camera.capture_node("046d:085e", self.sysfs.root), "/dev/video0")
        self.assertEqual(camera.capture_node("1234:abcd", self.sysfs.root), "/dev/video2")

    def test_the_usb_id_ignores_case(self):
        (self.sysfs.base / "devices" / "usb1" / "1-2" / "idVendor").write_text("ABCD\n")
        self.assertEqual(camera.capture_node("abcd:abcd", self.sysfs.root), "/dev/video2")

    def test_no_match_raises_value_error(self):
        with self.assertRaisesRegex(ValueError, "No capture node has USB ID 0bda:5801"):
            camera.capture_node("0bda:5801", self.sysfs.root)

    def test_a_missing_root_or_an_unreadable_entry_is_no_match(self):
        with self.assertRaises(ValueError):
            camera.capture_node("046d:085e", self.folder / "absent")
        (self.sysfs.root / "video0" / "index").unlink()
        with self.assertRaises(ValueError):
            camera.capture_node("046d:085e", self.sysfs.root)
        self.assertEqual(camera.capture_node("1234:abcd", self.sysfs.root), "/dev/video2")

    def test_two_cameras_with_one_usb_id_raise_value_error(self):
        self.sysfs.camera("1-3", "046d:085e", 4)
        with self.assertRaisesRegex(ValueError, r"More than one camera has USB ID 046d:085e.*--device"):
            camera.capture_node("046d:085e", self.sysfs.root)

    def test_a_metadata_node_alone_is_no_match(self):
        self.sysfs.node(6, self.sysfs.usb("1-4", "0bda:5801"), index=1)
        with self.assertRaises(ValueError):
            camera.capture_node("0bda:5801", self.sysfs.root)

    def test_each_start_of_the_stream_looks_up_the_node_after_a_reconnect(self):
        live = self.live()
        with patch("camera.VIDEO4LINUX", self.sysfs.root):
            self.assertEqual(live.find_node(), "/dev/video0")
            self.sysfs.clear()
            self.sysfs.camera("1-2", "1234:abcd", 0)
            self.sysfs.camera("1-1", "046d:085e", 2)
            self.assertEqual(live.find_node(), "/dev/video2")
        self.assertEqual(live.node, "/dev/video2")

    def test_the_stream_of_a_usb_id_names_the_node_in_its_observations(self):
        live = self.live()
        started = []

        def start_stream(node, resolution):
            started.append((node, resolution))
            return FakeProcess([camera.DEMO_JPEG], hold=True)

        with patch("camera.VIDEO4LINUX", self.sysfs.root), patch("camera.start_stream", side_effect=start_stream), \
                patch("camera.grey_of", return_value=camera.DEMO_GREY):
            live.start()
            self.addCleanup(live.stop)
            self.assertTrue(live.ready(5))
            observation = live.frames()[0]
        self.assertEqual(started, [("/dev/video0", "1280x720")])
        self.assertTrue(observation["parts"][0]["text"].startswith(
            "USB camera 046d:085e at /dev/video0; timestamp is receipt time. Received "))
        self.assertNotIn("SYNTHETIC", observation["parts"][0]["text"])
        self.assertEqual(observation["parts"][1]["file"], hashlib.sha256(camera.DEMO_JPEG).hexdigest())

    def test_a_missing_camera_gives_503(self):
        self.sysfs.clear()
        live = self.live()
        root, stop = serve(live)
        self.addCleanup(stop)
        with patch("camera.VIDEO4LINUX", self.sysfs.root), patch("camera.start_stream") as start:
            live.start()
            self.addCleanup(live.stop)
            self.assertFalse(live.ready(0.1))
            for _ in range(200):
                if live.reader.problem:
                    break
                threading.Event().wait(0.01)
            self.assertEqual(get(root, "/camera/observe")[0], 503)
        self.assertIn("No capture node has USB ID 046d:085e", live.reader.problem)
        start.assert_not_called()

    def test_the_usb_id_alone_serves_the_camera_sensor(self):
        self.assertEqual(list(self.live().sensors()), ["camera"])


TEMPLATE = Path(__file__).resolve().parent


def free_port():
    """A port that no process holds now."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class MainTests(unittest.TestCase):
    def run_main(self, *args, data, port=None, **env):
        """Start camera.py as bash does: with PORT set, and with no READY line to wait for."""
        port = free_port() if port is None else port
        variables = {**os.environ, "AMBION_SENSOR_REPOSITORY": "engineer/bench-camera",
                     "AMBION_SENSOR_DATA_DIR": data, "PORT": str(port), **env}
        process = subprocess.Popen([sys.executable, "-u", "-B", "camera.py", *args], cwd=TEMPLATE, env=variables,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process.port = port
        return process

    def listening(self, process):
        """Poll the index until it answers, as a reader of the process does."""
        for _ in range(200):
            if process.poll() is not None:
                self.fail(f"camera.py exited with {process.returncode}: {process.stderr.read()}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{process.port}/", timeout=1) as response:
                    return json.load(response)
            except OSError:
                threading.Event().wait(0.05)
        self.fail("camera.py did not listen.")

    def stop(self, process):
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertEqual(process.stdout.read(), "")

    def test_demo_listens_on_port_prints_nothing_and_stops_on_sigterm(self):
        with tempfile.TemporaryDirectory() as data:
            process = self.run_main("--demo", data=data)
            self.addCleanup(process.kill)
            self.addCleanup(process.communicate)
            index = self.listening(process)
            self.assertEqual(index["api"], 2)
            self.assertEqual(index["source"]["repository"], "engineer/bench-camera")
            self.stop(process)

    def test_demo_serves_both_sensors(self):
        with tempfile.TemporaryDirectory() as data:
            process = self.run_main("--demo", data=data)
            self.addCleanup(process.kill)
            self.addCleanup(process.communicate)
            index = self.listening(process)
            self.assertEqual([one["name"] for one in index["sensors"]], ["camera", "microphone"])
            # The microphone clip is the only file on disk. The frames stay in RAM.
            lines = (Path(data) / "observations.jsonl").read_text().splitlines()
            self.assertEqual([json.loads(line)["sensor"] for line in lines], ["microphone"])
            with urllib.request.urlopen(f"http://127.0.0.1:{process.port}/camera/observe", timeout=5) as response:
                parts = json.load(response)["observations"][0]["parts"]
            self.assertEqual(parts[1]["mediaType"], "image/jpeg")
            self.assertEqual([path.name for path in (Path(data) / "blobs").iterdir()],
                             [hashlib.sha256(camera.demo_wav()).hexdigest()])
            self.stop(process)

    @unittest.skipUnless(HAS_PILLOW, "Pillow is not installed.")
    def test_a_fake_v4l2_ctl_on_path_streams_into_the_ring_and_stops_with_the_server(self):
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as bin_dir:
            frame = Path(bin_dir) / "frame.jpg"
            frame.write_bytes(camera.DEMO_JPEG)
            script = Path(bin_dir) / "v4l2-ctl"
            script.write_text(f'#!/bin/sh\necho $$ > "{bin_dir}/pid"\nprintf "%s\\n" "$@" > "{bin_dir}/args"\n'
                              f'while :; do cat "{frame}"; sleep 0.1; done\n')
            script.chmod(0o755)
            path = bin_dir + os.pathsep + os.environ["PATH"]
            process = self.run_main("--device", "/dev/video7", "--resolution", "640x480", data=data, PATH=path)
            self.addCleanup(process.kill)
            self.addCleanup(process.communicate)
            index = self.listening(process)
            self.assertEqual([one["name"] for one in index["sensors"]], ["camera"])
            with urllib.request.urlopen(f"http://127.0.0.1:{process.port}/camera/observe", timeout=5) as response:
                observation = json.load(response)["observations"][0]
            self.assertIn("USB camera /dev/video7; timestamp is receipt time.", observation["parts"][0]["text"])
            self.assertEqual((Path(bin_dir) / "args").read_text().split(),
                             ["-d", "/dev/video7", "--set-fmt-video=width=640,height=480,pixelformat=MJPG",
                              "--set-parm=5", "--stream-mmap", "--stream-to=-"])
            self.assertEqual(list(Path(data).iterdir()), [Path(data) / "blobs"])
            self.assertEqual(list((Path(data) / "blobs").iterdir()), [])
            pid = int((Path(bin_dir) / "pid").read_text())
            self.stop(process)
            for _ in range(100):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                threading.Event().wait(0.05)
            else:
                self.fail("v4l2-ctl still runs.")

    def test_a_port_in_use_exits_with_one_line(self):
        with socket.socket() as holder, tempfile.TemporaryDirectory() as data:
            holder.bind(("127.0.0.1", 0))
            holder.listen()
            process = self.run_main("--demo", data=data, port=holder.getsockname()[1])
            out, err = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(out, "")
        self.assertIn("camera cannot listen on port", err)
        self.assertEqual(len(err.splitlines()), 1)

    def test_a_missing_or_bad_port_exits_with_2(self):
        for value in (None, "", "0", "65536", "http", "-1"):
            with tempfile.TemporaryDirectory() as data:
                env = {key: item for key, item in os.environ.items() if key != "PORT"}
                env.update({"AMBION_SENSOR_REPOSITORY": "engineer/bench-camera", "AMBION_SENSOR_DATA_DIR": data})
                if value is not None:
                    env["PORT"] = value
                done = subprocess.run([sys.executable, "-B", "camera.py", "--demo"], cwd=TEMPLATE, env=env,
                                      capture_output=True, text=True, timeout=10, check=False)
                self.assertEqual(done.returncode, 2, value)
                self.assertEqual(done.stdout, "")
                self.assertIn("Set PORT to an integer from 1 to 65535", done.stderr)
                self.assertFalse((Path(data) / "observations.jsonl").exists())

    def run_copy(self, **changes):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as data:
            copy = Path(folder).resolve() / "camera.py"
            copy.write_bytes((TEMPLATE / "camera.py").read_bytes())
            env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            env.update({"AMBION_SENSOR_REPOSITORY": "engineer/bench-camera", "AMBION_SENSOR_DATA_DIR": data,
                        "PORT": str(free_port()),
                        "GIT_CEILING_DIRECTORIES": str(Path(folder).resolve().parent), **changes})
            done = subprocess.run([sys.executable, "-B", "camera.py", "--demo"], cwd=folder, env=env,
                                  capture_output=True, text=True, timeout=10, check=False)
        return done, copy.parent

    def test_outside_a_git_checkout_exits_with_one_line(self):
        done, folder = self.run_copy()
        self.assertEqual(done.returncode, 2)
        self.assertEqual(done.stdout, "")
        self.assertTrue(done.stderr.startswith(
            f"camera needs a git checkout of your fork at {folder}. "
            "Clone your fork, then start the sensor from the clone (README, the fork and clone step)."), done.stderr)
        self.assertEqual(len(done.stderr.splitlines()), 1)

    def test_missing_git_exits_with_one_line(self):
        with tempfile.TemporaryDirectory() as empty:
            done, folder = self.run_copy(PATH=empty)
        self.assertEqual(done.returncode, 2)
        self.assertEqual(done.stderr, f"camera needs git on PATH to read the commit of your fork at {folder}.\n")

    def test_data_directory_inside_checkout_exits_with_2(self):
        process = self.run_main("--demo", data=str(TEMPLATE / "inside-data"))
        out, _err = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 2)
        self.assertEqual(out, "")
        self.assertFalse((TEMPLATE / "inside-data").exists())

    def test_no_device_and_no_demo_exits_with_2(self):
        with tempfile.TemporaryDirectory() as data:
            process = self.run_main(data=data)
            out, _err = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 2)
            self.assertEqual(out, "")

    def check_exit(self, *args):
        with tempfile.TemporaryDirectory() as data:
            process = self.run_main(*args, data=data)
            out, _err = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 2)
            self.assertEqual(out, "")

    def test_usb_id_options_exit_with_2(self):
        self.check_exit("--device", "/dev/video0", "--usb-id", "046d:085e")
        self.check_exit("--demo", "--device", "/dev/video0", "--usb-id", "046d:085e")
        for value in ("046d085e", "046d:085", "046d:085e0", "046g:085e", "0x46d:085e", "046d:085e ", ""):
            self.check_exit("--usb-id", value)
            self.check_exit("--demo", "--usb-id", value)

    def test_the_select_error_names_usb_id(self):
        with tempfile.TemporaryDirectory() as data:
            process = self.run_main(data=data)
            _out, err = process.communicate(timeout=10)
        self.assertIn("--usb-id", err)

    def test_no_first_frame_exits_with_one_line_and_stops_the_stream(self):
        with tempfile.TemporaryDirectory() as data:
            live = camera.Camera(SOURCE, data, "/dev/video4")
            live.ready = lambda: live.ring.arrived.wait(0.05)  # The real wait is FIRST_FRAME_SECONDS.
            with patch("camera.start_stream", side_effect=lambda *_args: FakeProcess([], hold=True)), \
                    patch("sys.stderr", new_callable=io.StringIO) as err, self.assertRaises(SystemExit) as caught:
                camera.start_evidence(live)
        self.assertEqual(caught.exception.code, 1)
        self.assertTrue(err.getvalue().startswith("camera got no frame in 30 s."), err.getvalue())
        self.assertEqual(len(err.getvalue().splitlines()), 1)
        self.assertFalse(live.reader.is_alive())

    def test_invalid_audio_options_exit_with_2(self):
        self.check_exit("--audio-device", "x;rm")
        self.check_exit("--demo", "--seconds", "0")
        self.check_exit("--demo", "--seconds", "31")


if __name__ == "__main__":
    unittest.main()
