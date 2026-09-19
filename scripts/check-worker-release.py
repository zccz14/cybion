#!/usr/bin/env python3
"""Fail a controller release before publishing broken Worker download links."""
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

manifest = json.loads((Path(__file__).resolve().parents[1] / "worker-release.json").read_text())
tag = manifest["version"]
headers = {"User-Agent": "cybion-release-check", "Accept": "application/vnd.github+json"}
if token := os.environ.get("GH_TOKEN"):
    headers["Authorization"] = "Bearer " + token
request = Request(f"https://api.github.com/repos/zccz14/cybion-worker/releases/tags/{tag}", headers=headers)
with urlopen(request, timeout=30) as response:
    release = json.load(response)
assert not release["draft"] and not release["prerelease"], "Worker release must be stable and published"
assets = {asset["name"] for asset in release["assets"]}
for platform in manifest["platforms"]:
    suffix = "zip" if platform["id"].startswith("windows") else "tar.gz"
    name = f"cybion-worker-{platform['id']}.{suffix}"
    assert name in assets and name + ".sha256" in assets, f"Missing release asset: {name}"
print(f"Verified {tag}: all five platforms and checksum files are published")
