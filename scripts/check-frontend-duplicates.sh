#!/usr/bin/env bash
# Every module exists once. `web/src` and `packages/cybion-components/src` are
# both live: the page renders the package, and web imports it by name, so a file
# that exists in both trees can drift apart without either tree's tests noticing
# (that is how the request_tail fold was fixed in the copy nobody rendered).
#
# This check fails on a duplicate path that is not listed in
# scripts/frontend-duplicates.allowlist, and it also fails when a listed path is
# no longer duplicated, so the list only ever shrinks.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
allow="$root/scripts/frontend-duplicates.allowlist"
web=$(mktemp)
pkg=$(mktemp)
found=$(mktemp)
trap 'rm -f "$web" "$pkg" "$found"' EXIT

(cd "$root/web/src" && find . -type f | sed 's|^\./||' | sort) > "$web"
(cd "$root/packages/cybion-components/src" && find . -type f | sed 's|^\./||' | sort) > "$pkg"
comm -12 "$web" "$pkg" > "$found"
grep -v '^#' "$allow" | sed '/^[[:space:]]*$/d' | sort > "${found}.allow" || true
mv "${found}.allow" "${found}.allowlist"

status=0
new=$(comm -23 "$found" "${found}.allowlist")
stale=$(comm -13 "$found" "${found}.allowlist")
if [ -n "$new" ]; then
  echo "frontend duplicates that are not on the allowlist:" >&2
  echo "$new" | sed 's/^/  /' >&2
  status=1
fi
if [ -n "$stale" ]; then
  echo "allowlist entries that are no longer duplicated (delete them):" >&2
  echo "$stale" | sed 's/^/  /' >&2
  status=1
fi
if [ "$status" -eq 0 ]; then
  echo "frontend duplicates: $(wc -l < "$found" | tr -d ' ') known, all on the allowlist"
fi
exit "$status"
