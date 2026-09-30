#!/usr/bin/env bash
# Online backup and guarded restore of the PolyForge Runtime SQLite database.
set -euo pipefail

RUN_DIR="${POLYFORGE_RUN_DIR:-/home/pohlee/.polyforge/run}"
OPS_DIR="$RUN_DIR/ops"
[[ -f "$OPS_DIR/pf-db.py" && -f "$OPS_DIR/db_admin.py" ]] || {
  echo "database admin scripts are missing from $OPS_DIR; invoke through tools/px.sh" >&2
  exit 1
}

python3 "$OPS_DIR/pf-db.py" "$@"
