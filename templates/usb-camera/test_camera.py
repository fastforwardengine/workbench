"""Offline checks. No device is opened; synthetic evidence only."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
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
        self.server = camera.open_server(self.camera)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.root = f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
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

    def test_capture_failure_does_not_return_previous_frame(self):
        self.camera.acquire()
        with patch.object(self.camera, "acquire", side_effect=subprocess.TimeoutExpired("fswebcam", 30)):
            status, body = self.request("/camera/observe", {"api": 1})
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "unavailable")
        self.assertNotIn("observations", body)

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


if __name__ == "__main__":
    unittest.main()
