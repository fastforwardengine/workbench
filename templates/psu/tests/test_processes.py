"""Several processes on one simulated supply."""

import json
import subprocess
import sys
from pathlib import Path

from .support import CONFIG_TWO, Isolated

ROOT = Path(__file__).resolve().parent.parent
WORKER = """
import sys
import psu
channel, config, state = sys.argv[1:4]
for n in range(1, 16):
    code = psu.main(["--config", config, "--sim", state, "set", "--channel", channel, "--voltage", str(n / 10)])
    assert code == 0
"""


class Processes(Isolated):
    def test_two_processes_do_not_lose_each_others_writes(self):
        config = self.directory / "psu.json"
        config.write_text(json.dumps(CONFIG_TWO))
        env = {"PATH": "/usr/bin:/bin", "PSU_LOCK_DIR": str(self.locks)}
        workers = [
            subprocess.Popen([sys.executable, "-B", "-c", WORKER, channel, str(config), str(self.state)], cwd=ROOT, env=env)
            for channel in ("ch1", "ch2")
        ]
        for worker in workers:
            self.assertEqual(worker.wait(timeout=60), 0)
        writes = json.loads(self.state.read_text())["writes"]
        for channel in ("ch1", "ch2"):
            seen = [value for name, key, value in writes if name == channel]
            self.assertEqual(seen, [n / 10 for n in range(1, 16)])
        self.assertEqual(len(writes), 30)

    def test_several_samples_print_one_json_line_each(self):
        config = self.directory / "psu.json"
        config.write_text(json.dumps(CONFIG_TWO))
        command = ["psu.py", "--config", str(config), "--sim", str(self.state), "measure", "--count", "2", "--interval", "0"]
        env = {"PATH": "/usr/bin:/bin", "PSU_LOCK_DIR": str(self.locks)}
        done = subprocess.run([sys.executable, "-B", *command], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        rows = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertEqual(sorted(rows[0]["channels"]), ["ch1", "ch2"])
