#!/usr/bin/env bash
# Repair ownership and permissions on the pilot data directory, and create the bridge secret if
# there is not one yet.
#
# Run as root. The Paperclip host process runs unprivileged as `pohlee`, and everything the pilot
# touches at runtime — the staged plugin, the bridge store, the signing secret, the run directory —
# has to be reachable by that account. A root-created 0700 directory makes the plugin
# *uninstallable*, and the resulting error says "path does not exist", which points at the mount
# rather than at the permission. That cost real time once; this makes it a one-liner.
set -uo pipefail

PF_DATA_DIR="${PF_DATA_DIR:-/home/pohlee/.polyforge}"
OWNER="${POLYFORGE_OWNER:-pohlee}"
SECRET_FILE="${POLYFORGE_SECRET_FILE:-$PF_DATA_DIR/bridge.secret}"
RUN_DIR="${POLYFORGE_RUN_DIR:-$PF_DATA_DIR/run}"

id "$OWNER" >/dev/null 2>&1 || { echo "no such user: $OWNER" >&2; exit 1; }

echo "=== host process owner ==="
pid="$(pgrep -f 'paperclipai onboard' | head -1 || true)"
if [ -n "$pid" ]; then ps -o user=,args= -p "$pid" | head -1; fi

mkdir -p "$PF_DATA_DIR" "$PF_DATA_DIR/bridge" "$RUN_DIR"
if [ ! -f "$SECRET_FILE" ]; then
  umask 077
  python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_urlsafe(48))' > "$SECRET_FILE"
  echo "generated a bridge secret at $SECRET_FILE"
fi

# Traverseable and listable by the host user; the secret itself stays owner-only, because it is the
# one thing here that another account must not read.
chown -R "$OWNER:$OWNER" "$PF_DATA_DIR"
chmod 755 "$PF_DATA_DIR" "$RUN_DIR"
chmod 750 "$PF_DATA_DIR/bridge"
chmod 600 "$SECRET_FILE"

echo "=== after ==="
ls -ld "$PF_DATA_DIR" "$PF_DATA_DIR/bridge" "$RUN_DIR" "$SECRET_FILE" 2>/dev/null

echo
echo "=== reachability as $OWNER ==="
su -s /bin/bash "$OWNER" -c "head -c 1 '$SECRET_FILE' >/dev/null && echo '  secret: readable by owner' || echo '  secret: NOT readable'"
su -s /bin/bash "$OWNER" -c "touch '$RUN_DIR/.probe' && rm -f '$RUN_DIR/.probe' && echo '  run dir: writable' || echo '  run dir: NOT writable'"
