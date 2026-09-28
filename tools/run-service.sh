#!/usr/bin/env bash
# Start the PolyForge Runtime Service in the WSL distro where Paperclip runs.
#
# The service is a separate process from the plugin on purpose: the Graph Core, its GraphStore,
# and its reconciler must survive a plugin worker restart, and a plugin must never be able to
# hold the canonical state in memory.
set -euo pipefail
source /mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph/tools/env.sh

DB="${POLYFORGE_DB:-$PF_DATA_DIR/polyforge.sqlite}"
PIDFILE="$PF_DATA_DIR/runtime.pid"
LOG="$PF_DATA_DIR/runtime.log"

mkdir -p "$PF_DATA_DIR"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "runtime service already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

: "${POLYFORGE_BRIDGE_SECRET:?POLYFORGE_BRIDGE_SECRET must be set (see tools/dev-secrets.sh)}"

cd "$REPO_WSL"
PYTHONPATH=services/polyforge/src \
PYTHONUNBUFFERED=1 \
POLYFORGE_DB="$DB" \
POLYFORGE_BIND="${POLYFORGE_BIND:-127.0.0.1}" \
POLYFORGE_PORT="${POLYFORGE_PORT:-8787}" \
POLYFORGE_BRIDGE_ISSUER="${POLYFORGE_BRIDGE_ISSUER:-polyforge-bridge}" \
POLYFORGE_BRIDGE_SECRET="$POLYFORGE_BRIDGE_SECRET" \
POLYFORGE_INSTANCE_ROLE="${POLYFORGE_INSTANCE_ROLE:-polyforge.operator}" \
  nohup python3 -m polyforge.services.runtime_api >"$LOG" 2>&1 &

echo $! > "$PIDFILE"

for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "$PF_SERVICE_URL/v1/health/live" >/dev/null 2>&1; then
    echo "runtime service up: pid $(cat "$PIDFILE"), db $DB, log $LOG"
    curl -fsS --max-time 5 "$PF_SERVICE_URL/v1/health/ready" || true
    echo
    exit 0
  fi
  sleep 0.5
done

echo "runtime service failed to become ready; last log lines:" >&2
tail -40 "$LOG" >&2
exit 1
