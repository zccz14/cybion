#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag is required}"
archive_url="${2:?archive URL is required}"
checksum_url="${3:?checksum URL is required}"
archive="cybion-linux-x86_64.tar.gz"
version="${tag#v}"
data_dir="/root/.cybion"
installed_binary="$data_dir/bin/cybion"
release_dir="$data_dir/releases/$tag"
backup_dir="$data_dir/backups/cybion.before-${tag}-$(date -u +%Y%m%dT%H%M%SZ)"
temporary_dir="$(mktemp -d)"
previous_binary="$backup_dir/cybion"

cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

rollback() {
  if [ -f "$previous_binary" ]; then
    install -m 0755 "$previous_binary" "$installed_binary"
    systemctl restart cybion.service || true
  fi
}

curl --fail --location --retry 5 --retry-all-errors \
  --output "$temporary_dir/$archive" \
  "$archive_url"
curl --fail --location --retry 5 --retry-all-errors \
  --output "$temporary_dir/$archive.sha256" \
  "$checksum_url"

cd "$temporary_dir"
sha256sum --check "$archive.sha256"
mkdir package
tar -xzf "$archive" -C package
new_binary="$(find package -type f -name cybion -perm -u+x -print -quit)"
test -n "$new_binary"

install -d -m 0755 "$data_dir/bin" "$data_dir/releases" "$backup_dir" "$release_dir"
if [ -f "$installed_binary" ]; then
  install -m 0755 "$installed_binary" "$previous_binary"
fi
install -m 0755 "$new_binary" "$release_dir/cybion"
install -m 0755 "$release_dir/cybion" "$installed_binary"

if ! systemctl restart cybion.service; then
  rollback
  exit 1
fi

healthy=0
for _ in $(seq 1 30); do
  if config="$(curl --fail --silent --max-time 3 http://127.0.0.1:1858/api/config 2>/dev/null)" \
    && CONFIG="$config" EXPECTED_VERSION="$version" python3 -c '
import json
import os

config = json.loads(os.environ["CONFIG"])
if config.get("version") != os.environ["EXPECTED_VERSION"]:
    raise SystemExit(1)
' \
    && curl --fail --silent --max-time 3 http://127.0.0.1:1858/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  rollback
  systemctl --no-pager --full status cybion.service || true
  exit 1
fi

printf 'deployed=%s\n' "$version"
cat "$data_dir/run/started.json"
