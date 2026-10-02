"""Offline checks. No device is opened; synthetic evidence only."""
import copy
import hashlib
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
from unittest.mock import patch
import urllib.error
import urllib.request

import camera


class CameraTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.source = {"repository": "instruments/bench-camera", "commit": "a" * 40, "dirty": False}
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

    def request(self, path, body=None):
        request = urllib.request.Request(self.root + path, data=None if body is None else json.dumps(body).encode())
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read()
            return response.status, data if response.headers.get_content_type() == "image/png" else json.loads(data)

    def test_discovery_and_evidence_survive_later_capture_and_shutdown(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(self.request("/")[1]["source"], self.source)
        status, body = self.request("/camera/observe", {"api": 1})
        self.assertEqual(status, 200)
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
        self.assertEqual(records[0], {"source": self.source, "observation": observation})
        self.assertEqual(len(records), 2)
        # Restart/rollback uses the same directory without deleting old evidence.
        restarted = camera.Camera(self.source, self.folder.name, None, demo=True)
        restarted.acquire()
        self.assertEqual((Path(self.folder.name) / "blobs" / digest).read_bytes(), png)
        self.assertEqual(len((Path(self.folder.name) / "observations.jsonl").read_text().splitlines()), 3)

    def test_invalid_requests_unknown_paths_and_unsupported_spans(self):
        for body in [{}, {"api": True}, {"api": 2}, {"api": 1, "extra": 1},
                     {"api": 1, "span": {"from": "x", "to": "y"}},
                     {"api": 1, "span": {"from": "2026-01-02T00:00:00.000Z", "to": "2026-01-01T00:00:00.000Z"}}]:
            self.assertEqual(self.request("/camera/observe", body)[0], 400)
        self.assertEqual(self.request("/camera/observe", {"api": 1, "span": {
            "from": "2026-01-01T00:00:00.000Z", "to": "2026-01-02T00:00:00.000Z"}})[0], 422)
        self.assertEqual(self.request("/missing", {"api": 1})[0], 404)
        self.assertEqual(self.request("/files/" + "0" * 64)[0], 404)
        self.assertEqual(self.request("/files/../../camera.py")[0], 404)
        request = urllib.request.Request(self.root + "/camera/observe", data=b"not json")
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_truncated_blob_is_replaced_atomically(self):
        digest = hashlib.sha256(camera.demo_png()).hexdigest()
        blobs = Path(self.folder.name) / "blobs"
        (blobs / digest).write_bytes(camera.demo_png()[:10])
        self.assertEqual(self.request("/camera/observe", {"api": 1})[0], 200)
        self.assertEqual((blobs / digest).read_bytes(), camera.demo_png())
        self.assertEqual([path.name for path in blobs.iterdir()], [digest])

    def test_idle_connection_does_not_block_observe(self):
        self.stop_server()
        self.start_server(timeout=0.5)
        with socket.create_connection(("127.0.0.1", self.server.server_port)):
            self.assertEqual(self.request("/camera/observe", {"api": 1})[0], 200)

    def check_capture_failure(self, run):
        live = camera.Camera(self.source, self.folder.name, "/dev/video4")
        self.stop_server()
        self.start_server(live)
        log = Path(self.folder.name) / "observations.jsonl"
        before = log.read_text() if log.exists() else ""
        with patch("camera.subprocess.run", side_effect=run):
            status, body = self.request("/camera/observe", {"api": 1})
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "unavailable")
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
            source = camera.launch_source(folder, "instruments/bench-camera")
            self.assertTrue(source["dirty"])
            self.assertEqual(source["branch"], "capture")
            git("commit", "-am", "second")
            self.assertNotEqual(source["commit"], git("rev-parse", "HEAD"))
            self.assertTrue(source["dirty"])
            git("checkout", "--detach")
            self.assertNotIn("branch", camera.launch_source(folder, "instruments/bench-camera"))
            with self.assertRaises(ValueError):
                camera.launch_source(folder, "templates/usb-camera")


TEMPLATE = Path(__file__).resolve().parent


class MainTests(unittest.TestCase):
    def run_main(self, *args, data, wait=10):
        env = {**os.environ, "AMBION_SENSOR_REPOSITORY": "instruments/bench-camera",
               "AMBION_SENSOR_DATA_DIR": data}
        return subprocess.Popen([sys.executable, "-u", "-B", "camera.py", *args], cwd=TEMPLATE, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_demo_prints_ready_serves_and_stops_on_sigterm(self):
        with tempfile.TemporaryDirectory() as data:
            process = self.run_main("--demo", data=data)
            self.addCleanup(process.kill)
            self.addCleanup(process.communicate)
            line = process.stdout.readline()
            self.assertTrue(line.startswith("READY "))
            ready = json.loads(line[6:])
            self.assertEqual(ready["source"]["repository"], "instruments/bench-camera")
            with urllib.request.urlopen(f"http://127.0.0.1:{ready['port']}/", timeout=5) as response:
                self.assertEqual(json.load(response)["source"], ready["source"])
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=10), 0)

    def test_data_directory_inside_checkout_exits_with_2(self):
        process = self.run_main("--demo", data=str(TEMPLATE / "inside-data"))
        out, _err = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 2)
        self.assertNotIn("READY", out)
        self.assertFalse((TEMPLATE / "inside-data").exists())

    def test_no_device_and_no_demo_exits_with_2(self):
        with tempfile.TemporaryDirectory() as data:
            process = self.run_main(data=data)
            out, _err = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 2)
            self.assertNotIn("READY", out)


if __name__ == "__main__":
    unittest.main()
