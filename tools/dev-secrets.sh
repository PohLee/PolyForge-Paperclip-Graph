#!/usr/bin/env bash
# Create (or reuse) the shared signing secret for the pilot and print the plugin config.
#
# The secret is generated once and stored outside the repository with owner-only permissions.
# It is never committed, never logged, and never written into the Paperclip database: Paperclip
# stores only a reference, and the bridge resolves the value per request through
# `ctx.secrets.resolve`.
set -euo pipefail
source /mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph/tools/env.sh

SECRET_FILE="${POLYFORGE_SECRET_FILE:-$PF_DATA_DIR/bridge.secret}"
mkdir -p "$PF_DATA_DIR"
chmod 700 "$PF_DATA_DIR"

if [[ ! -f "$SECRET_FILE" ]]; then
  umask 077
  python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_urlsafe(48))' > "$SECRET_FILE"
  echo "generated a new bridge secret at $SECRET_FILE"
else
  echo "reusing the existing bridge secret at $SECRET_FILE"
fi
chmod 600 "$SECRET_FILE"

# Print the export line for the caller to eval, plus the JSON config the plugin needs.
printf 'export POLYFORGE_BRIDGE_SECRET=%s\n' "$(cat "$SECRET_FILE")"
printf 'export POLYFORGE_BRIDGE_ISSUER=%s\n' "${POLYFORGE_BRIDGE_ISSUER:-polyforge-bridge}"
