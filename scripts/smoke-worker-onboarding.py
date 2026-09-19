#!/usr/bin/env python3
"""Public production smoke: never grants a device access or logs credentials."""
import hashlib
import json
import secrets
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

base = sys.argv[1] if len(sys.argv) > 1 else "https://cybion.ntnl.io"
def request(path, *, data=None, token=None, expected=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = Request(base + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
    try:
        response = urlopen(req, timeout=20)
    except HTTPError as error:
        assert error.code == expected, f"{path}: status {error.code}, expected {expected}"
        return None
    assert response.status == expected
    return json.load(response)
config = request("/api/config")
release = request("/api/worker-release")
assert len(release["platforms"]) == 5
secret = secrets.token_hex(32)
started = request("/worker/v1/pairings", data={"device_secret": secret, "token_hash": hashlib.sha256(secrets.token_bytes(32)).hexdigest(), "hostname": "release-smoke-unapproved", "platform": "smoke-test", "version": "0.1.4"})
assert "access_token" not in started and "device_secret" not in started
poll = request("/worker/v1/pairings/" + started["id"], token=secret)
assert poll["status"] == "pending" and poll["user_id"] is None
request("/api/worker-pairings/" + started["user_code"], data={"label": "must-not-be-created"}, expected=401)
request("/worker/v1/pairings/" + started["id"], token=secrets.token_hex(32), expected=401)
print(json.dumps({"controller_version": config["version"], "worker_version": release["version"], "platforms": 5, "pairing_status": "pending", "unauthorized_approval": "rejected", "wrong_device_proof": "rejected"}))
