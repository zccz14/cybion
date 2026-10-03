#!/usr/bin/env python3
"""Fail a controller release before publishing broken Worker download links."""
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

manifest = json.loads((Path(__file__).resolve().parents[1] / "worker-release.json").read_text())
headers = {"User-Agent": "cybion-release-check", "Accept": "application/vnd.github+json"}
if token := os.environ.get("GH_TOKEN"):
    headers["Authorization"] = "Bearer " + token


def released_assets(repository, tag):
    request = Request(f"https://api.github.com/repos/{repository}/releases/tags/{tag}", headers=headers)
    with urlopen(request, timeout=30) as response:
        release = json.load(response)
    assert not release["draft"] and not release["prerelease"], f"{repository} release must be stable and published"
    return {asset["name"] for asset in release["assets"]}


assets = released_assets("zccz14/cybion-worker", manifest["version"])
for platform in manifest["platforms"]:
    suffix = "zip" if platform["id"].startswith("windows") else "tar.gz"
    name = f"cybion-worker-{platform['id']}.{suffix}"
    assert name in assets and name + ".sha256" in assets, f"Missing release asset: {name}"

android = manifest.get("android")
if android:
    assets = released_assets("zccz14/cybion-worker-for-android", android["version"])
    for name in ("cybion-worker-android-aarch64.apk", "cybion-worker-android-aarch64.apk.sha256"):
        assert name in assets, f"Missing release asset: {name}"
    print(f"Verified {manifest['version']} CLI platforms and {android['version']} Android APK: all assets and checksum files are published")
else:
    print(f"Verified {manifest['version']}: all five platforms and checksum files are published")
