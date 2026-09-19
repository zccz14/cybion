#!/usr/bin/env python3
"""Exercise public smoke with an HTTP fixture that rejects unidentified clients."""
import json
import os
from pathlib import Path
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

class Handler(BaseHTTPRequestHandler):
    device_secret = None
    def log_message(self, *_args):
        pass
    def reply(self, status, value):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())
    def handle_request(self):
        if self.headers.get("User-Agent") != "cybion-release-smoke/1.0":
            return self.reply(403, {"error": "explicit monitor identity required"})
        if self.path == "/api/config":
            return self.reply(200, {"version": "fixture"})
        if self.path == "/api/worker-release":
            return self.reply(200, {"version": "v0.1.4", "platforms": [1, 2, 3, 4, 5]})
        if self.path == "/worker/v1/pairings" and self.command == "POST":
            value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            Handler.device_secret = value["device_secret"]
            return self.reply(200, {"id": "fixture", "user_code": "ABCD-1234-EF56"})
        if self.path == "/worker/v1/pairings/fixture" and self.headers.get("Authorization") == "Bearer " + Handler.device_secret:
            return self.reply(200, {"status": "pending", "user_id": None})
        return self.reply(401, {"error": "unauthorized"})
    do_GET = handle_request
    do_POST = handle_request

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("smoke-worker-onboarding.py")), f"http://127.0.0.1:{server.server_port}"], check=True, text=True, capture_output=True, timeout=15, env=dict(os.environ, NO_PROXY="localhost,127.0.0.1"))
    summary = json.loads(result.stdout)
    assert summary["controller_version"] == "fixture"
    assert summary["unauthorized_approval"] == "rejected"
    assert summary["wrong_device_proof"] == "rejected"
    print("Public smoke regression passed: explicit user agent on every request")
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
