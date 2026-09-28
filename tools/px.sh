#!/usr/bin/env bash
#
# Run a repository script without depending on the Windows drive being readable while it runs.
#
# The repository lives on D: and reaches this distro through the 9p automount, which intermittently
# fails reads under load — including a `-f` test that says the file is there. Nothing about the
# *pilot* needs the mount; only the source does. So this copies the small set of shell scripts and
# the ops directory to the native filesystem, exports the environment itself, and executes there.
# One short mount touch per invocation instead of a long dependency on a mount that can vanish
# mid-procedure.
#
#   tools/px.sh tools/stage-plugin.sh
#   tools/px.sh tools/provision-pilot.sh -- <companyId>
#
set -uo pipefail

SRC_ROOT="${POLYFORGE_REPO_WSL:-/mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph}"
RUN_DIR="${POLYFORGE_RUN_DIR:-/home/pohlee/.polyforge/run}"

# Wait for a *real read*, not a stat: the automount reports files as present while failing reads.
ready=0
for _ in $(seq 1 40); do
  if head -c 1 "$SRC_ROOT/package.json" >/dev/null 2>&1; then ready=1; break; fi
  sleep 3
done
[ "$ready" = 1 ] || { echo "px: the repository on $SRC_ROOT is not readable" >&2; exit 1; }

SCRIPT="${1:?usage: px.sh <script-path> [-- args...]}"
shift || true
[ "${1:-}" = "--" ] && shift

mkdir -p "$RUN_DIR"
rm -rf "$RUN_DIR/tools" "$RUN_DIR/ops"
cp -R "$SRC_ROOT/tools" "$RUN_DIR/tools"
cp -R "$SRC_ROOT/ops" "$RUN_DIR/ops"
chmod 755 "$RUN_DIR"
chmod -R u+rwX,go+rX "$RUN_DIR/tools" "$RUN_DIR/ops"
chmod +x "$RUN_DIR/tools"/*.sh

# The environment is exported here rather than sourced from the copied `env.sh`, so a script never
# has to read anything to find out where the pilot keeps its data.
export PATH="/home/pohlee/.hermes/node/bin:$PATH"
export POLYFORGE_REPO_WSL="$SRC_ROOT"
export POLYFORGE_RUN_DIR="$RUN_DIR"
export PAPERCLIP_BIN="/home/pohlee/.npm/_npx/43414d9b790239bb/node_modules/.bin/paperclipai"
export PAPERCLIP_API="${PAPERCLIP_API:-http://127.0.0.1:3100}"
export PF_DATA_DIR="${PF_DATA_DIR:-/home/pohlee/.polyforge}"
export PF_SERVICE_URL="${PF_SERVICE_URL:-http://127.0.0.1:8787}"
export POLYFORGE_PLUGIN_STAGE="${POLYFORGE_PLUGIN_STAGE:-$PF_DATA_DIR/plugin}"
export POLYFORGE_BRIDGE_ISSUER="${POLYFORGE_BRIDGE_ISSUER:-polyforge-bridge}"
export POLYFORGE_BRIDGE_SECRET_FILE="${POLYFORGE_BRIDGE_SECRET_FILE:-$PF_DATA_DIR/bridge.secret}"
[ -f "$POLYFORGE_BRIDGE_SECRET_FILE" ] && export POLYFORGE_BRIDGE_SECRET="$(cat "$POLYFORGE_BRIDGE_SECRET_FILE")"

# Run as the host's own user: the Paperclip server runs unprivileged, and anything the bridge
# needs to read or write has to be reachable by that account. Running as root produces root-owned
# 0700 directories that the host then cannot open.
TARGET="${POLYFORGE_RUN_AS:-pohlee}"
if [ "$(id -un)" = "$TARGET" ]; then
  exec bash "$RUN_DIR/$SCRIPT" "$@"
fi
if id "$TARGET" >/dev/null 2>&1; then
  quoted=()
  for a in "$@"; do quoted+=("$(printf '%q' "$a")"); done
  exec su -s /bin/bash "$TARGET" -c "exec bash '$RUN_DIR/$SCRIPT' ${quoted[*]-}"
fi
echo "px: no such user: $TARGET" >&2
exit 1
