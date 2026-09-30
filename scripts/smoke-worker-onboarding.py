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
    headers = {"Content-Type": "application/json", "User-Agent": "cybion-release-smoke/1.0"}
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
def download(path, expected=200):
    req = Request(base + path, headers={"User-Agent": "cybion-release-smoke/1.0"})
    try:
        response = urlopen(req, timeout=60)
    except HTTPError as error:
        assert error.code == expected, f"{path}: status {error.code}, expected {expected}"
        return None
    assert response.status == expected
    return response.read()
config = request("/api/config")
release = request("/api/worker-release")
assert len(release["platforms"]) == 5
asset = "cybion-worker-linux-x86_64.tar.gz"
archive = download(f"/worker-release/{release['version']}/{asset}")
checksum_text = download(f"/worker-release/{release['version']}/{asset}.sha256").decode()
fields = checksum_text.split()
assert len(fields) == 2 and fields[1].lstrip("*") == asset, checksum_text
assert hashlib.sha256(archive).hexdigest() == fields[0], "mirrored release download checksum mismatch"
download(f"/worker-release/{release['version']}/cybion-worker-plan9-x86_64.tar.gz", expected=404)
secret = secrets.token_hex(32)
started = request("/worker/v1/pairings", data={"device_secret": secret, "token_hash": hashlib.sha256(secrets.token_bytes(32)).hexdigest(), "hostname": "release-smoke-unapproved", "platform": "smoke-test", "version": "0.1.4"})
assert "access_token" not in started and "device_secret" not in started
poll = request("/worker/v1/pairings/" + started["id"], token=secret)
assert poll["status"] == "pending" and poll["user_id"] is None
request("/api/worker-pairings/" + started["user_code"], data={"label": "must-not-be-created"}, expected=401)
request("/worker/v1/pairings/" + started["id"], token=secrets.token_hex(32), expected=401)
print(json.dumps({"controller_version": config["version"], "worker_version": release["version"], "release_download": "verified", "platforms": 5, "pairing_status": "pending", "unauthorized_approval": "rejected", "wrong_device_proof": "rejected"}))
