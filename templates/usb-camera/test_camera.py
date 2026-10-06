"""Offline checks. No device is opened; synthetic evidence only."""
from array import array
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from unittest.mock import patch
import urllib.error
import urllib.request

import camera


class CameraTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.source = {"repository": "engineer/bench-camera", "commit": "a" * 40, "dirty": False}
        self.camera = camera.Camera(copy.deepcopy(self.source), self.folder.name, None, demo=True)
        self.running = False
        self.start_server()
        self.addCleanup(self.stop_server)

    def start_server(self, served=None, timeout=10):
        self.server = camera.open_server(served or self.camera, timeout=timeout)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True)
        self.thread.start()
        self.running = True
        self.root = f"http://127.0.0.1:{self.server.server_port}"

    def stop_server(self):
        if not self.running:
            return
        self.running = False
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, method="GET"):
        request = urllib.request.Request(self.root + path, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read()
            return response.status, data if response.headers.get_content_type() in ("image/png", "audio/wav") else json.loads(data)

    def test_discovery_and_evidence_survive_later_capture_and_shutdown(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, index = self.request("/")
        self.assertEqual(status, 200)
        self.assertEqual(index["api"], 2)
        self.assertEqual(index["source"], self.source)
        self.assertEqual([(sensor["name"], sensor["spans"]) for sensor in index["sensors"]], [("camera", False), ("microphone", False)])
        status, body = self.request("/camera/observe")
        self.assertEqual(status, 200)
        self.assertEqual(body["api"], 2)
        observation = body["observations"][0]
        self.assertIn("SYNTHETIC", observation["parts"][0]["text"])
        digest = observation["parts"][1]["file"]
        status, png = self.request("/files/" + digest)
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(png).hexdigest(), digest)
        self.assertEqual(png, camera.demo_png())
        self.camera.acquire()
        self.assertEqual(self.request("/files/" + digest)[1], png)
        records = [json.loads(row) for row in (Path(self.folder.name) / "observations.jsonl").read_text().splitlines()]
        self.assertEqual(records[0], {"source": self.source, "sensor": "camera", "observation": observation})
        self.assertEqual(len(records), 2)
        # Restart/rollback uses the same directory without deleting old evidence.
        restarted = camera.Camera(self.source, self.folder.name, None, demo=True)
        restarted.acquire()
        self.assertEqual((Path(self.folder.name) / "blobs" / digest).read_bytes(), png)
        self.assertEqual(len((Path(self.folder.name) / "observations.jsonl").read_text().splitlines()), 3)

    def test_invalid_queries_unknown_paths_and_unsupported_spans(self):
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

    def test_truncated_blob_is_replaced_atomically(self):
        digest = hashlib.sha256(camera.demo_png()).hexdigest()
        blobs = Path(self.folder.name) / "blobs"
        (blobs / digest).write_bytes(camera.demo_png()[:10])
        self.assertEqual(self.request("/camera/observe")[0], 200)
        self.assertEqual((blobs / digest).read_bytes(), camera.demo_png())
        self.assertEqual([path.name for path in blobs.iterdir()], [digest])

    def test_idle_connection_does_not_block_observe(self):
        self.stop_server()
        self.start_server(timeout=0.5)
        with socket.create_connection(("127.0.0.1", self.server.server_port)):
            self.assertEqual(self.request("/camera/observe")[0], 200)

    def check_capture_failure(self, run):
        live = camera.Camera(self.source, self.folder.name, "/dev/video4")
        self.stop_server()
        self.start_server(live)
        log = Path(self.folder.name) / "observations.jsonl"
        before = log.read_text() if log.exists() else ""
        with patch("camera.subprocess.run", side_effect=run):
            status, body = self.request("/camera/observe")
        self.assertEqual(status, 503)
        self.assertEqual((body["code"], body["api"]), ("unavailable", 2))
        self.assertNotIn("observations", body)
        self.assertEqual(log.read_text() if log.exists() else "", before)
        self.assertEqual([path.name for path in Path(self.folder.name).iterdir() if path.is_dir()], ["blobs"])

    def test_capture_timeout_gives_503(self):
        self.check_capture_failure(subprocess.TimeoutExpired("fswebcam", 30))

    def test_capture_error_gives_503(self):
        self.check_capture_failure(subprocess.CalledProcessError(1, "fswebcam"))

    def test_capture_without_file_gives_503(self):
        self.check_capture_failure(lambda *_args, **_kwargs: None)

    def test_capture_of_other_bytes_gives_503(self):
        def capture(command, **_kwargs):
            Path(command[-1]).write_bytes(b"not a png")
        self.check_capture_failure(capture)

    def test_v4l2_capture_arguments_and_receipt_timestamp(self):
        live = camera.Camera(self.source, self.folder.name, "/dev/video4", "640x480")
        def capture(command, **kwargs):
            self.assertEqual(command[:5], ["fswebcam", "-d", "/dev/video4", "-r", "640x480"])
            self.assertEqual(kwargs["timeout"], 30)
            self.assertTrue(kwargs["check"])
            Path(command[-1]).write_bytes(camera.demo_png())
        with patch("camera.subprocess.run", side_effect=capture), patch("camera.utc", return_value="2026-01-01T00:00:00.123Z"):
            observation = live.acquire()
        self.assertEqual(observation["at"], "2026-01-01T00:00:00.123Z")
        self.assertNotIn("SYNTHETIC", observation["parts"][0]["text"])

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
    """Requests overlap. A request waits only for a capture of its own sensor."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        source = {"repository": "engineer/bench-camera", "commit": "a" * 40, "dirty": False}
        self.camera = camera.Camera(source, self.folder.name, None, demo=True)
        self.server = camera.open_server(self.camera)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.root = f"http://127.0.0.1:{self.server.server_port}"
        self.release = threading.Event()
        self.addCleanup(self.release.set)
        self.captures = []
        self.entered = threading.Semaphore(0)
        self.arrivals = threading.Semaphore(0)
        original_acquire = camera.Camera.acquire
        original_observe = camera.Camera.observe

        def acquire(served, sensor="camera"):
            self.captures.append(sensor)
            self.entered.release()
            if sensor in self.held:
                self.assertTrue(self.release.wait(10))
            if self.failing:
                raise OSError("device lost")
            return original_acquire(served, sensor)

        def observe(served, sensor):
            self.arrivals.release()
            return original_observe(served, sensor)

        self.held = {"camera", "microphone"}
        self.failing = False
        for name, function in (("acquire", acquire), ("observe", observe)):
            patcher = patch.object(camera.Camera, name, function)
            patcher.start()
            self.addCleanup(patcher.stop)

    def stop_server(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path):
        try:
            response = urllib.request.urlopen(self.root + path, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

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
        self.ask("camera", results)
        self.wait_for(self.entered)
        self.ask("camera", results)
        self.wait_for(self.arrivals, 2)
        self.release.set()
        self.assertTrue(self.wait_for_result(results, 2))
        self.assertEqual(self.captures, ["camera"])
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
        self.held = set()
        self.assertEqual(self.request("/camera/observe")[0], 200)
        self.assertEqual(self.request("/camera/observe")[0], 200)
        self.assertEqual(self.captures, ["camera", "camera"])

    def test_a_camera_request_does_not_wait_for_a_microphone_clip(self):
        clip = []
        self.held = {"microphone"}
        self.ask("microphone", clip)
        self.wait_for(self.entered)
        status, body = self.request("/camera/observe")
        self.assertEqual(status, 200)
        self.assertEqual(body["observations"][0]["parts"][1]["kind"], "frame")
        self.assertEqual(clip, [])
        self.release.set()
        self.assertTrue(self.wait_for_result(clip, 1))
        self.assertEqual(clip[0][0], 200)

    def test_drain_waits_for_the_captures_in_flight(self):
        results = []
        self.ask("camera", results)
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
        self.ask("camera", results)
        self.wait_for(self.entered)
        self.ask("camera", results)
        self.wait_for(self.arrivals, 2)
        self.release.set()
        self.assertTrue(self.wait_for_result(results, 2))
        self.assertEqual([status for status, _body in results], [503, 503])
        self.assertEqual(self.captures, ["camera"])


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
            observation = self.live(seconds=3).acquire("microphone")
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
                observation = self.live().acquire("microphone")
        self.assertEqual(len(observation["parts"][2]["values"]), 10)

    def test_bad_capture_gives_503_and_keeps_nothing(self):
        self.start_server(self.live())
        for clip in [wav_bytes([1] * 100, channels=2), wav_bytes([1] * 100, rate=44100)]:
            def fake(command, **_kwargs):
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

    def capture(self, live):
        """Capture one frame with fswebcam patched. Returns the fswebcam command and the observation."""
        commands = []
        def run(command, **_kwargs):
            commands.append(command)
            Path(command[-1]).write_bytes(camera.demo_png())
        with patch("camera.subprocess.run", side_effect=run), patch("camera.VIDEO4LINUX", self.sysfs.root):
            observation = live.acquire()
        return commands[0], observation

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

    def test_each_capture_looks_up_the_node_after_a_reconnect(self):
        live = self.live()
        command, observation = self.capture(live)
        self.assertEqual(command[:3], ["fswebcam", "-d", "/dev/video0"])
        self.assertEqual(observation["parts"][0]["text"],
                         "USB camera 046d:085e at /dev/video0; timestamp is capture receipt time.")
        self.sysfs.clear()
        self.sysfs.camera("1-2", "1234:abcd", 0)
        self.sysfs.camera("1-1", "046d:085e", 2)
        command, observation = self.capture(live)
        self.assertEqual(command[:3], ["fswebcam", "-d", "/dev/video2"])
        self.assertEqual(observation["parts"][0]["text"],
                         "USB camera 046d:085e at /dev/video2; timestamp is capture receipt time.")

    def test_a_missing_camera_gives_503(self):
        self.sysfs.clear()
        server = camera.open_server(self.live())
        thread = threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/camera/observe"
        with patch("camera.VIDEO4LINUX", self.sysfs.root), patch("camera.subprocess.run") as run, \
                self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url, timeout=5)
        self.assertEqual(caught.exception.code, 503)
        caught.exception.close()
        run.assert_not_called()

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
            self.assertEqual(len((Path(data) / "observations.jsonl").read_text().splitlines()), 2)
            self.stop(process)

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
                                      capture_output=True, text=True, timeout=10)
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
                                  capture_output=True, text=True, timeout=10)
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

    def test_invalid_audio_options_exit_with_2(self):
        self.check_exit("--audio-device", "x;rm")
        self.check_exit("--demo", "--seconds", "0")
        self.check_exit("--demo", "--seconds", "31")


if __name__ == "__main__":
    unittest.main()
