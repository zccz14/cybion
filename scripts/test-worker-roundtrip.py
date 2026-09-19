#!/usr/bin/env python3
"""Run a real Worker against a disposable authenticated controller test fixture.
Usage: python3 scripts/test-worker-roundtrip.py /absolute/path/to/cybion-worker
Requires `cargo test --no-run` first; never reads production credentials/config.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError

root = Path(__file__).resolve().parents[1]
worker = Path(sys.argv[1]).resolve()
urlopen = build_opener(ProxyHandler({})).open
binaries = [p for p in (root / "target/debug/deps").glob("cybion-*") if p.is_file() and os.access(p, os.X_OK) and not p.suffix]
fixture_binary = max(binaries, key=lambda p: p.stat().st_mtime)
with tempfile.TemporaryDirectory(prefix="cybion-roundtrip-") as temporary:
    folder = Path(temporary)
    log = (folder / "fixture.log").open("w")
    environment = dict(os.environ, CYBION_ONBOARDING_FIXTURE_DIR=temporary)
    server = subprocess.Popen([str(fixture_binary), "--exact", "cloud::worker_onboarding::tests::real_worker_fixture", "--ignored", "--nocapture"], env=environment, stdout=log, stderr=subprocess.STDOUT)
    pid = None
    try:
        for _ in range(100):
            if (folder / "fixture.json").exists():
                break
            assert server.poll() is None, "Fixture failed"
            time.sleep(.05)
        settings = json.loads((folder / "fixture.json").read_text())
        def api(path, method="GET", data=None):
            headers = {"Authorization": "Bearer " + settings["token"], "Content-Type": "application/json"}
            request = Request(settings["base"] + path, method=method, data=None if data is None else json.dumps(data).encode(), headers=headers)
            try:
                with urlopen(request, timeout=10) as response:
                    return json.load(response) if response.status != 204 else None
            except HTTPError as error:
                raise RuntimeError(f"Fixture API {path}: {error.code}: {error.read(500).decode()}") from None
        config = api("/api/workers", "POST", {"label": "Disposable real Worker"})
        config["controller_url"] = settings["base"]
        path = folder / "worker.toml"
        path.write_text("\n".join(f"{key} = {json.dumps(value)}" for key, value in config.items()))
        path.chmod(0o600)
        launch = subprocess.run([str(worker), "run", "--background", "--config", str(path)], capture_output=True, text=True, timeout=25)
        assert launch.returncode == 0, launch.stderr
        pid = json.loads(path.with_suffix(".status.json").read_text())["pid"]
        duplicate = subprocess.run([str(worker), "run", "--background", "--config", str(path)], capture_output=True, text=True, timeout=5)
        assert duplicate.returncode != 0 and "already owns" in duplicate.stderr
        check_url = f"/api/workers/{config['machine_id']}/check"
        api(check_url, "POST")
        for _ in range(100):
            check = api(check_url)
            if check["status"] == "completed":
                break
            time.sleep(.1)
        assert check["status"] == "completed", "Real SSE diagnostic check did not complete"
        assert check["result"]["shell"]["status"] == "ready"
        assert check["result"]["browser"]["status"] != "ready"
        assert check["result"]["desktop"]["status"] != "ready"
        api(f"/api/workers/{config['machine_id']}", "DELETE")
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pid = None
                break
            time.sleep(.1)
        assert pid is None, "Revoked Worker kept running"
        print(json.dumps({"real_worker_roundtrip": "passed", "duplicate_instance": "rejected", "revoked_worker": "stopped", "shell": "ready", "browser_desktop": "not_falsely_reported_ready"}))
    finally:
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        server.terminate()
        server.wait(timeout=10)
        log.close()
