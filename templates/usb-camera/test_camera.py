"""Offline checks. No device is opened and no tool runs; synthetic evidence and fixtures only."""
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
        live = camera.Camera(self.source, self.folder.name, "4")
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
        self.check_capture_failure(subprocess.TimeoutExpired("ffmpeg", 30))

    def test_capture_error_gives_503(self):
        self.check_capture_failure(subprocess.CalledProcessError(1, "ffmpeg"))

    def test_capture_without_file_gives_503(self):
        self.check_capture_failure(lambda *_args, **_kwargs: None)

    def test_capture_of_other_bytes_gives_503(self):
        def capture(command, **_kwargs):
            Path(command[-1]).write_bytes(b"not a png")
        self.check_capture_failure(capture)

    def test_ffmpeg_capture_arguments_and_receipt_timestamp(self):
        live = camera.Camera(self.source, self.folder.name, "4", "640x480", framerate="15")
        def capture(command, **kwargs):
            self.assertEqual(command[:-1], [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-framerate", "15",
                "-video_size", "640x480", "-i", "4", "-vf", "trim=start_frame=10,setpts=PTS-STARTPTS",
                "-frames:v", "1", "-update", "1"])
            self.assertEqual(Path(command[-1]).name, "frame.png")
            self.assertEqual(kwargs["timeout"], 30)
            self.assertTrue(kwargs["check"])
            Path(command[-1]).write_bytes(camera.demo_png())
        with patch("camera.subprocess.run", side_effect=capture) as run, \
                patch("camera.utc", return_value="2026-01-01T00:00:00.123Z"):
            observation = live.acquire()
        run.assert_called_once()  # An index needs no list of devices.
        self.assertEqual(observation["at"], "2026-01-01T00:00:00.123Z")
        self.assertEqual(observation["parts"][0]["text"],
                         "USB camera AVFoundation video 4; timestamp is capture receipt time.")

    def check_framerate_retry(self, stderr, calls):
        live = camera.Camera(self.source, self.folder.name, "4")
        commands = []
        def capture(command, **_kwargs):
            commands.append(command)
            if len(commands) == 1:
                raise subprocess.CalledProcessError(1, "ffmpeg", stderr=stderr)
            Path(command[-1]).write_bytes(camera.demo_png())
        with patch("camera.subprocess.run", side_effect=capture):
            if calls == 2:
                live.acquire()
            else:
                with self.assertRaises(subprocess.CalledProcessError):
                    live.acquire()
        self.assertEqual(len(commands), calls)
        return commands

    def test_capture_runs_again_without_framerate_when_the_camera_refuses_it(self):
        commands = self.check_framerate_retry(
            b"[avfoundation @ 0x1] Selected framerate (30.000000) is not supported by the device.\n", 2)
        self.assertIn("-framerate", commands[0])
        self.assertNotIn("-framerate", commands[1])
        self.assertEqual([part for part in commands[0] if part not in ("-framerate", "30")], commands[1])

    def test_capture_does_not_run_again_for_another_error(self):
        self.check_framerate_retry(b"[avfoundation @ 0x1] Selected video size (1x1) is not supported.\n", 1)
        self.check_framerate_retry(None, 1)

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

    def live(self, audio_device="1", **options):
        return camera.Camera(self.source, self.folder.name, None, audio_device=audio_device, **options)

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

    def test_ffmpeg_arguments_and_timestamps(self):
        clip = wav_bytes([1000, -1000] * 24000)
        def fake(command, **kwargs):
            self.assertEqual(command[:-1], [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-i", ":1", "-t", "3",
                "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav"])
            self.assertEqual((kwargs["timeout"], kwargs["check"]), (18, True))
            Path(command[-1]).write_bytes(clip)
        times = iter(["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:03.050Z"])
        with patch("camera.subprocess.run", side_effect=fake), patch("camera.utc", side_effect=lambda: next(times)):
            observation = self.live(seconds=3).acquire("microphone")
        self.assertEqual(observation["at"], "2026-01-01T00:00:03.050Z")
        text, file, series = observation["parts"]
        self.assertIn("USB microphone 1; 3 s clip", text["text"])
        self.assertIn("The series starts when ffmpeg is launched", text["text"])
        self.assertNotIn("SYNTHETIC", text["text"])
        self.assertEqual(series["from"], "2026-01-01T00:00:00.000Z")
        self.assertEqual(file["file"], hashlib.sha256(clip).hexdigest())
        self.assertEqual(Path(self.folder.name, "blobs", file["file"]).read_bytes(), clip)

    def test_an_audio_name_goes_to_its_index_at_each_clip(self):
        tools = FakeTools()
        with patch("camera.subprocess.run", side_effect=tools):
            self.live("BRIO").acquire("microphone")
            tools.audio = [(0, "BRIO"), (1, "MacBook Pro Microphone")]
            self.live("BRIO").acquire("microphone")
        self.assertEqual([command[command.index("-i") + 1] for command in tools.captures], [":1", ":0"])

    def test_an_unknown_audio_name_gives_503(self):
        self.start_server(self.live("Studio Mic"))
        with patch("camera.subprocess.run", side_effect=FakeTools()):
            status, body = self.request("/microphone/observe")
        self.assertEqual((status, body["code"]), (503, "unavailable"))

    def test_fake_ffmpeg_on_path(self):
        with tempfile.TemporaryDirectory() as bin_dir:
            script = Path(bin_dir) / "ffmpeg"
            clip = Path(bin_dir) / "source.wav"
            listing = Path(bin_dir) / "list.txt"
            clip.write_bytes(wav_bytes([500] * 4800))
            listing.write_text(FFMPEG_LIST)
            script.write_text(f'#!/bin/sh\ncase "$*" in *list_devices*) cat "{listing}" >&2; exit 1;; esac\n'
                              f'for last; do :; done\ncp "{clip}" "$last"\n')
            script.chmod(0o755)
            with patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ["PATH"]}):
                observation = self.live("BRIO").acquire("microphone")
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
        with patch("camera.subprocess.run", side_effect=subprocess.TimeoutExpired("ffmpeg", 20)):
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
        self.start_server(camera.Camera(self.source, self.folder.name, "4"))
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


# What system_profiler prints for SPUSBDataType -json. The field names come from the output of macOS 14
# and 15 (an inference: no Mac ran this suite). A hub holds its devices in `_items`. A vendor_id has a text suffix.
SYSTEM_PROFILER = json.dumps({"SPUSBDataType": [{
    "_name": "USB31Bus", "host_controller": "AppleT8112USBXHCI",
    "_items": [
        {"_name": "Logitech BRIO", "manufacturer": "Logitech", "location_id": "0x01100000 / 1",
         "product_id": "0x085e", "vendor_id": "0x046d  (Logitech Inc.)", "serial_num": "A1B2"},
        {"_name": "USB2.0 Hub", "location_id": "0x01200000 / 2", "product_id": "0x0610",
         "vendor_id": "0x05e3  (Genesys Logic, Inc.)", "_items": [
             {"_name": "TOMLOV TM4K-AF", "location_id": "0x01210000 / 4", "product_id": "0xabcd", "vendor_id": "0x1234"},
             {"_name": "USB Serial", "location_id": "0x01220000 / 5", "product_id": "0x7523", "vendor_id": "0x1A86"}]},
    ]}]})

# The same devices, with the keys of a newer macOS, which lists them under SPUSBHostDataType.
SYSTEM_PROFILER_HOST = json.dumps({"SPUSBHostDataType": [{
    "_name": "USB31Bus", "_items": [
        {"_name": "Logitech BRIO", "product_id": "0x085e", "vendor_id": "0x046d  (Logitech Inc.)"}]}]})

# What `ffmpeg -f avfoundation -list_devices true -i ""` prints on stderr.
FFMPEG_LIST = """[AVFoundation indev @ 0x6000012a8000] AVFoundation video devices:
[AVFoundation indev @ 0x6000012a8000] [0] FaceTime HD Camera
[AVFoundation indev @ 0x6000012a8000] [1] Logitech BRIO
[AVFoundation indev @ 0x6000012a8000] [2] TOMLOV TM4K-AF
[AVFoundation indev @ 0x6000012a8000] [3] Capture screen 0
[AVFoundation indev @ 0x6000012a8000] AVFoundation audio devices:
[AVFoundation indev @ 0x6000012a8000] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x6000012a8000] [1] BRIO
[in#0 @ 0x6000012a8100] Error opening input: Input/output error
Error opening input file .
"""


class FakeTools:
    """A stand-in for subprocess.run: system_profiler, the ffmpeg list, and the ffmpeg captures.
    Set `video` or `audio` to renumber the devices, and `profiler` to change the USB tree."""

    def __init__(self):
        self.profiler = {"SPUSBDataType": SYSTEM_PROFILER}
        self.video = [(0, "FaceTime HD Camera"), (1, "Logitech BRIO"), (2, "TOMLOV TM4K-AF"), (3, "Capture screen 0")]
        self.audio = [(0, "MacBook Pro Microphone"), (1, "BRIO")]
        self.captures = []
        self.listings = 0

    def listing(self):
        lines = ["[AVFoundation indev @ 0x1] AVFoundation video devices:"]
        lines += [f"[AVFoundation indev @ 0x1] [{index}] {name}" for index, name in self.video]
        lines += ["[AVFoundation indev @ 0x1] AVFoundation audio devices:"]
        lines += [f"[AVFoundation indev @ 0x1] [{index}] {name}" for index, name in self.audio]
        return "\n".join(lines + ["Error opening input file ."]) + "\n"

    def __call__(self, command, **_kwargs):
        if command[0] == "system_profiler":
            return subprocess.CompletedProcess(command, 0, self.profiler.get(command[1], ""), "")
        if "-list_devices" in command:
            self.listings += 1
            return subprocess.CompletedProcess(command, 1, "", self.listing())  # ffmpeg exits with 1 here.
        self.captures.append(command)
        Path(command[-1]).write_bytes(camera.demo_png() if command[-1].endswith(".png") else wav_bytes([700] * 4800))
        return subprocess.CompletedProcess(command, 0, "", "")


class DeviceListTests(unittest.TestCase):
    def test_the_ffmpeg_list_has_video_and_audio_devices(self):
        done = subprocess.CompletedProcess([], 1, "", FFMPEG_LIST)
        with patch("camera.subprocess.run", return_value=done) as run:
            found = camera.avfoundation_devices()
        self.assertEqual(run.call_args.args[0], ["ffmpeg", "-hide_banner", "-f", "avfoundation",
                                                 "-list_devices", "true", "-i", ""])
        self.assertEqual(found["video"], [(0, "FaceTime HD Camera"), (1, "Logitech BRIO"), (2, "TOMLOV TM4K-AF"),
                                          (3, "Capture screen 0")])
        self.assertEqual(found["audio"], [(0, "MacBook Pro Microphone"), (1, "BRIO")])

    def test_an_index_needs_no_list(self):
        with patch("camera.subprocess.run") as run:
            self.assertEqual(camera.pick("video", "2"), (2, None))
        run.assert_not_called()

    def test_a_name_matches_exactly_in_any_case_or_by_a_part(self):
        found = {"video": [(0, "USB Camera"), (1, "Logitech BRIO"), (2, "Logitech BRIO 4K")], "audio": [(0, "BRIO")]}
        self.assertEqual(camera.pick("video", "usb camera", found), (0, "USB Camera"))
        self.assertEqual(camera.pick("video", "Logitech BRIO", found), (1, "Logitech BRIO"))  # Exact beats a part.
        self.assertEqual(camera.pick("video", "4K", found), (2, "Logitech BRIO 4K"))
        self.assertEqual(camera.pick("audio", "Logitech BRIO", found), (0, "BRIO"))

    def test_no_match_and_two_matches_raise_value_error(self):
        found = {"video": [(0, "Logitech BRIO"), (1, "Logitech C920")], "audio": []}
        with self.assertRaisesRegex(ValueError, r"No AVFoundation video device is named Cam\. .*0 Logitech BRIO"):
            camera.pick("video", "Cam", found)
        with self.assertRaisesRegex(ValueError, r"More than one AVFoundation video device matches Logitech.*Use the index"):
            camera.pick("video", "Logitech", found)
        with self.assertRaisesRegex(ValueError, "The audio devices are: none"):
            camera.pick("audio", "BRIO", found)


class UsbNameTests(unittest.TestCase):
    def test_the_name_of_a_usb_id_comes_from_the_profile_at_any_depth(self):
        with patch("camera.subprocess.run", side_effect=FakeTools()) as run:
            self.assertEqual(camera.usb_name("046d:085e"), "Logitech BRIO")
            self.assertEqual(camera.usb_name("1234:abcd"), "TOMLOV TM4K-AF")
        self.assertEqual(run.call_args.args[0], ["system_profiler", "SPUSBDataType", "-json"])

    def test_the_usb_id_ignores_case_and_the_text_after_the_number(self):
        self.assertEqual(camera.hex_id({"vendor_id": "0x046D  (Logitech Inc.)"}, camera.VENDOR_KEYS), "046d")
        self.assertEqual(camera.hex_id({"product_id": "0x85e"}, camera.PRODUCT_KEYS), "085e")
        self.assertEqual(camera.hex_id({"apple_vendor_id": "0x05ac"}, camera.VENDOR_KEYS), "05ac")
        self.assertIsNone(camera.hex_id({"vendor_id": "none"}, camera.VENDOR_KEYS))
        with patch("camera.subprocess.run", side_effect=FakeTools()):
            self.assertEqual(camera.usb_name("1a86:7523"), "USB Serial")

    def test_no_match_raises_value_error(self):
        with patch("camera.subprocess.run", side_effect=FakeTools()), \
                self.assertRaisesRegex(ValueError, "No USB device has ID 0bda:5801"):
            camera.usb_name("0bda:5801")

    def test_a_newer_macos_lists_the_devices_under_the_host_type(self):
        tools = FakeTools()
        tools.profiler = {"SPUSBHostDataType": SYSTEM_PROFILER_HOST}  # SPUSBDataType prints nothing.
        with patch("camera.subprocess.run", side_effect=tools) as run:
            self.assertEqual(camera.usb_name("046d:085e"), "Logitech BRIO")
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ["SPUSBDataType", "SPUSBHostDataType"])

    def test_two_names_with_one_usb_id_raise_value_error(self):
        tools = FakeTools()
        tree = json.loads(SYSTEM_PROFILER)
        tree["SPUSBDataType"][0]["_items"].append(
            {"_name": "Other BRIO", "product_id": "0x085e", "vendor_id": "0x046d"})
        tools.profiler = {"SPUSBDataType": json.dumps(tree)}
        with patch("camera.subprocess.run", side_effect=tools), \
                self.assertRaisesRegex(ValueError, r"More than one USB device has ID 046d:085e.*--device"):
            camera.usb_name("046d:085e")


class UsbIdTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.source = {"repository": "engineer/bench-camera", "commit": "a" * 40, "dirty": False}
        self.data = self.folder / "data"
        self.tools = FakeTools()
        patcher = patch("camera.subprocess.run", side_effect=self.tools)
        patcher.start()
        self.addCleanup(patcher.stop)

    def live(self, usb_id="046d:085e"):
        return camera.Camera(self.source, self.data, None, usb_id=usb_id)

    def index_of(self, command):
        return command[command.index("-i") + 1]

    def test_each_capture_looks_up_the_index_after_a_reconnect(self):
        live = self.live()
        observation = live.acquire()
        self.assertEqual(self.index_of(self.tools.captures[0]), "1")
        self.assertEqual(observation["parts"][0]["text"],
                         'USB camera 046d:085e, AVFoundation video 1 "Logitech BRIO"; timestamp is capture receipt time.')
        self.tools.video = [(0, "TOMLOV TM4K-AF"), (1, "FaceTime HD Camera"), (2, "Logitech BRIO")]
        observation = live.acquire()
        self.assertEqual(self.index_of(self.tools.captures[1]), "2")
        self.assertEqual(observation["parts"][0]["text"],
                         'USB camera 046d:085e, AVFoundation video 2 "Logitech BRIO"; timestamp is capture receipt time.')

    def test_two_cameras_run_together_each_by_its_usb_id(self):
        bench, scope = self.live("046d:085e"), self.live("1234:abcd")
        bench.acquire()
        scope.acquire()
        self.assertEqual([self.index_of(command) for command in self.tools.captures], ["1", "2"])

    def test_a_device_name_goes_to_its_index_with_no_usb_lookup(self):
        live = camera.Camera(self.source, self.data, "tomlov", usb_id=None)
        observation = live.acquire()
        self.assertEqual(self.index_of(self.tools.captures[0]), "2")
        self.assertIn('USB camera AVFoundation video 2 "TOMLOV TM4K-AF";', observation["parts"][0]["text"])
        self.assertNotIn("system_profiler", [call.args[0][0] for call in camera.subprocess.run.call_args_list])

    def test_a_missing_camera_gives_503(self):
        self.tools.profiler = {"SPUSBDataType": json.dumps({"SPUSBDataType": []})}
        server = camera.open_server(self.live())
        thread = threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/camera/observe"
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url, timeout=5)
        self.assertEqual(caught.exception.code, 503)
        caught.exception.close()
        self.assertEqual(self.tools.captures, [])

    def test_a_camera_that_ffmpeg_does_not_list_gives_503_and_no_capture(self):
        self.tools.video = [(0, "FaceTime HD Camera")]
        with self.assertRaisesRegex(ValueError, "No AVFoundation video device is named Logitech BRIO"):
            self.live().acquire()
        self.assertEqual(self.tools.captures, [])

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
        self.check_exit("--device", "0", "--usb-id", "046d:085e")
        self.check_exit("--demo", "--device", "0", "--usb-id", "046d:085e")
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
        self.check_exit("--device", "x;rm")
        self.check_exit("--demo", "--framerate", "fast")
        self.check_exit("--demo", "--seconds", "0")
        self.check_exit("--demo", "--seconds", "31")


if __name__ == "__main__":
    unittest.main()
