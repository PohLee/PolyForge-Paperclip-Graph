#!/usr/bin/env bash
# Wait until the Windows drive is genuinely readable, not merely stat-able.
#
# The WSL 9p automount intermittently fails *reads* under load while still reporting the file as
# present, so a `-f` test is not readiness. A procedure that trusts it fails at random. This
# helper verifies an actual read of actual content, and every script that touches the repository
# or the build output goes through it, so the flake is handled in one place.
#
#   source tools/env.sh
#   wait_for_path "<repo>" package.json || exit 1
#   wait_for_path "$POLYFORGE_PLUGIN_STAGE" package.json || exit 1
#
# `POLYFORGE_MOUNT_ATTEMPTS` (default 60) and `POLYFORGE_MOUNT_DELAY` (default 5s) bound the wait.

wait_for_path() {
  local dir="${1:?usage: wait_for_path <dir> <sentinel-file>}"
  local sentinel="${2:?usage: wait_for_path <dir> <sentinel-file>}"
  local attempts="${POLYFORGE_MOUNT_ATTEMPTS:-60}"
  local delay="${POLYFORGE_MOUNT_DELAY:-5}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if head -c 1 "$dir/$sentinel" >/dev/null 2>&1; then
      return 0
    fi
    if ((i % 6 == 0)); then
      echo "  …waiting for $dir to become readable (${i}s of $((attempts * delay))s)" >&2
    fi
    sleep "$delay"
  done
  echo "wait_for_path: $dir/$sentinel never became readable" >&2
  return 1
}
