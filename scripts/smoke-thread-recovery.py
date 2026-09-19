#!/usr/bin/env python3
"""Isolated process-crash test; never connects to production or real models.

Requires test executables with the isolated Controller and Worker fixtures. The
Controller fixture invokes production startup/router/recovery on an ephemeral
loopback port. All state and commands use a temporary HOME. The test SIGKILLs
only its own Controller fixture process while its own Worker
executes a harmless, gated file-counter command.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import shlex
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request


def wait(check, label, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, sqlite3.Error, urllib.error.URLError):
            pass
        time.sleep(0.05)
    raise AssertionError(f"timeout: {label}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker-test-binary", required=True)
    parser.add_argument("--test-binary", required=True)
    args = parser.parse_args()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        address = f"127.0.0.1:{probe.getsockname()[1]}"
    with tempfile.TemporaryDirectory(prefix="cybion-recovery-smoke-") as directory:
        home = Path(directory)
        marker, gate = home / "executions", home / "release"
        metadata, requests = {}, []
        command = f"printf x >> {shlex.quote(str(marker))}; while [ ! -f {shlex.quote(str(gate))} ]; do sleep 0.05; done; printf done"

        class Model(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                answered = any(item.get("type") == "function_call_output" and item.get("call_id") == "smoke-call" for item in body["input"])
                if answered:
                    output = [{"id": "final", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "finished smoke"}]}]
                else:
                    assert len(requests) == 1, "model was called again before original tool settlement"
                    output = [{"id": "tool", "type": "function_call", "call_id": "smoke-call", "name": "bash", "arguments": json.dumps({"worker_id": metadata["worker_id"], "command": command})}]
                encoded = json.dumps({"id": f"response-{len(requests)}", "end_turn": answered, "output": output}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        env = {**os.environ, "HOME": str(home), "CYBION_SMOKE_HOME": str(home), "CYBION_SMOKE_ADDR": address, "CYBION_SMOKE_MODEL_URL": f"http://127.0.0.1:{model.server_port}"}
        subprocess.run([str(Path(args.test_binary).resolve()), "--exact", "cloud::recovery::tests::write_restart_fixture", "--ignored"], env=env, check=True, timeout=20, stdout=subprocess.DEVNULL)
        metadata.update(json.loads((home / "fixture.json").read_text()))
        database = home / ".cybion/users" / f"{metadata['user_id']}.sqlite3"

        def query(sql):
            with sqlite3.connect(database, timeout=2) as db:
                return db.execute(sql).fetchone()[0]

        config = home / "worker.toml"
        config.write_text(f'controller_url = "http://{address}"\nuser_id = "{metadata["user_id"]}"\nmachine_id = "{metadata["worker_id"]}"\naccess_token = "fixture"\n')
        controller = worker = None
        controller_log = (home / "controller.log").open("wb")
        worker_log = (home / "worker.log").open("wb")

        def start_controller():
            process = subprocess.Popen([str(Path(args.test_binary).resolve()), "--exact", "cloud::recovery::tests::serve_smoke_controller", "--ignored", "--nocapture"], env=env, stdout=controller_log, stderr=subprocess.STDOUT)
            wait(lambda: urllib.request.urlopen(f"http://{address}/health", timeout=1).read() == b"ok", "Controller healthy")
            return process

        try:
            controller = start_controller()
            worker = subprocess.Popen([str(Path(args.worker_test_binary).resolve()), "--exact", "dispatch_tests::serve_recovery_fixture", "--ignored", "--nocapture"], env={**env, "CYBION_SMOKE_WORKER_CONFIG": str(config)}, stdout=worker_log, stderr=subprocess.STDOUT)
            wait(lambda: marker.exists(), "first command started")
            boot = wait(lambda: query("SELECT boot_id FROM workers"), "boot recorded")
            assert marker.read_text() == "x"
            controller.kill()
            controller.wait(timeout=10)
            controller = None
            gate.write_text("release")  # Tool finishes while Controller is down.
            time.sleep(1.3)
            assert worker.poll() is None, "Worker exited during outage"
            controller = start_controller()
            wait(lambda: query("SELECT status FROM threads") == "idle", "Thread resumed and completed")
            assert marker.read_text() == "x", "command executed twice"
            assert len(requests) == 2, f"unexpected model attempts: {len(requests)}"
            assert query("SELECT COUNT(*) FROM worker_calls") == 1
            assert query("SELECT COUNT(*) FROM history_records WHERE kind='tool_output'") == 1
            assert query("SELECT COUNT(*) FROM history_records WHERE kind='input'") == 1
            assert query("SELECT boot_id FROM workers") == boot
            assert worker.poll() is None
            print(json.dumps({"controller_restart": "recovered", "command_executions": 1, "tool_outputs": 1, "model_requests": 2, "worker_process_survived": True, "worker_version": query("SELECT version FROM workers")}, indent=2))
        except BaseException:
            controller_log.flush()
            worker_log.flush()
            print((home / "controller.log").read_text(errors="replace"))
            print((home / "worker.log").read_text(errors="replace"))
            raise
        finally:
            for process in [worker, controller]:
                if process is not None and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            model.shutdown()
            controller_log.close()
            worker_log.close()


if __name__ == "__main__":
    main()
