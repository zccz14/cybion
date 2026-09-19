#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
version="$(python3 -c 'import json; print(json.load(open("worker-release.json"))["version"])')"
git clone --quiet --depth 1 --branch "$version" https://github.com/zccz14/cybion-worker.git "$scratch/worker"
cat scripts/worker-recovery-fixture.rs >> "$scratch/worker/src/dispatch_tests.rs"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
cargo test --locked --no-run --message-format=json > "$scratch/controller.json"
cargo test --locked --manifest-path "$scratch/worker/Cargo.toml" --no-run --message-format=json > "$scratch/worker.json"
python3 - "$scratch" <<'PY'
import json
from pathlib import Path
import subprocess
import sys
binaries = {}
for name in ("controller", "worker"):
    for line in (Path(sys.argv[1]) / f"{name}.json").read_text().splitlines():
        item = json.loads(line)
        if item.get("executable") and item.get("profile", {}).get("test"):
            binaries[name] = item["executable"]
subprocess.run(["python3", "scripts/smoke-thread-recovery.py", "--test-binary", binaries["controller"], "--worker-test-binary", binaries["worker"]], check=True, timeout=90)
PY
