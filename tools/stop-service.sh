#!/usr/bin/env bash
# Stop the PolyForge Runtime Service. Durable state is untouched: a stop is a stop, not a
# rollback. See docs/06-OPERATIONS.md for the difference.
set -euo pipefail
source /mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph/tools/env.sh

PIDFILE="$PF_DATA_DIR/runtime.pid"
if [[ ! -f "$PIDFILE" ]]; then
  echo "no pidfile at $PIDFILE; nothing to stop"
  exit 0
fi
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  for _ in $(seq 1 40); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID"
    echo "sent SIGKILL after the graceful window"
  else
    echo "stopped pid $PID"
  fi
else
  echo "pid $PID is not running"
fi
rm -f "$PIDFILE"
