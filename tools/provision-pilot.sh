#!/usr/bin/env bash
#
# Provision the pilot: create the signing secret, write the plugin config, and publish + activate
# the graph library for one company.
#
# Idempotent by construction. Everything it does is reversible with `unprovision-pilot.sh`, and
# nothing it does grants a capability or a permission: it stores a secret, points the bridge at
# the Runtime Service, and publishes graph versions that only future runs will select.
#
#   tools/provision-pilot.sh <companyId> [projectId]
#
set -euo pipefail

PF_DATA_DIR="${PF_DATA_DIR:-/home/pohlee/.polyforge}"
PC="${PAPERCLIP_BIN:-/home/pohlee/.npm/_npx/43414d9b790239bb/node_modules/.bin/paperclipai}"
PAPERCLIP_API="${PAPERCLIP_API:-http://127.0.0.1:3100}"
PF_SERVICE_URL="${PF_SERVICE_URL:-http://127.0.0.1:8787}"
ISSUER="${POLYFORGE_BRIDGE_ISSUER:-polyforge-bridge}"
export PATH="/home/pohlee/.hermes/node/bin:$PATH"

COMPANY="${1:?usage: provision-pilot.sh <companyId> [projectId]}"
PROJECT="${2:-}"
SECRET_NAME="polyforge-bridge-signing-key"
SECRET_FILE="${POLYFORGE_SECRET_FILE:-$PF_DATA_DIR/bridge.secret}"
BRIDGE_STATE_DIR="$PF_DATA_DIR/bridge"

head -c 1 "$SECRET_FILE" >/dev/null 2>&1 || { echo "no bridge secret at $SECRET_FILE; run tools/ensure-pilot-dirs.sh first" >&2; exit 1; }
mkdir -p "$BRIDGE_STATE_DIR"
chmod 750 "$BRIDGE_STATE_DIR"

# ---------------------------------------------------------------------------
# 1. The signing secret, in the host's own secret store.
# ---------------------------------------------------------------------------
# The secret never appears in a command line, a log, or the plugin database: only the reference
# is stored there, and the worker resolves the value per request.
EXISTING_ID="$(
  "$PC" secrets list --company-id "$COMPANY" --json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const rows = JSON.parse(s);
        const row = (Array.isArray(rows) ? rows : rows.secrets ?? []).find(r => r.name === process.argv[1]);
        if (row) process.stdout.write(String(row.id));
      } catch { /* a store that cannot be read is reported by the next command */ }
    });' "$SECRET_NAME"
)"

if [[ -z "$EXISTING_ID" ]]; then
  echo "creating the signing secret in the host secret store"
  EXISTING_ID="$(POLYFORGE_SECRET_VALUE="$(cat "$SECRET_FILE")" "$PC" secrets create \
    --company-id "$COMPANY" \
    --name "$SECRET_NAME" \
    --key "polyforge.bridge.signing-key" \
    --value-env POLYFORGE_SECRET_VALUE \
    --description "Shared HMAC secret for PolyForge Runtime Service requests. Stored only as a reference in plugin config." \
    --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.id ?? j.secretId ?? ""));});')"
else
  echo "reusing the existing signing secret $EXISTING_ID"
  echo "  rotate it with: paperclipai secrets rotate $EXISTING_ID --company-id $COMPANY"
fi

[[ -n "$EXISTING_ID" ]] || { echo "could not determine the secret id" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2. The plugin configuration.
# ---------------------------------------------------------------------------
# Written straight to the config route rather than through `paperclipai plugin config:set`: that
# subcommand's `--payload-json` is spread into the request body, and the route wants the config
# under a `configJson` key, so the CLI sends `{}` and the host answers 400. The route is the
# contract; this is what it expects.
echo "writing the plugin configuration for company $COMPANY"
CONFIG_JSON="$(cat <<JSON
{
  "runtimeUrl": "$PF_SERVICE_URL",
  "bridgeIssuer": "${POLYFORGE_BRIDGE_ISSUER:-polyforge-bridge}",
  "sharedSecretRef": { "type": "secret_ref", "secretId": "$EXISTING_ID" },
  "allowPrivateRuntimeHost": true,
  "runtimeTransport": "${PF_RUNTIME_TRANSPORT:-direct}",
  "stateDir": "$BRIDGE_STATE_DIR",
  "requestTimeoutMs": 15000,
  "replayWindowSeconds": 120,
  "engineeringEntryLabel": "engineering",
  "engineeringOriginPrefix": "polyforge",
  "workspaceProviderMode": "metadata_only",
  "enableProjections": true,
  "logLevel": "info",
  "experimental": { "decisions": false, "cases": false, "pipelines": false }
}
JSON
)"

node -e '
  const body = JSON.stringify({ companyId: process.argv[1], configJson: JSON.parse(process.argv[2]) });
  fetch(`${process.argv[3]}/api/plugins/polyforge/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).then(async (r) => {
    const text = await r.text();
    if (!r.ok) { process.stderr.write(`config write failed: ${r.status} ${text}\n`); process.exit(1); }
    process.stdout.write("config written\n");
  });
' "$COMPANY" "$CONFIG_JSON" "$PAPERCLIP_API"

echo "  runtime    $PF_SERVICE_URL"
echo "  issuer     ${POLYFORGE_BRIDGE_ISSUER:-polyforge-bridge}"
echo "  state dir  $BRIDGE_STATE_DIR"
echo "  transport  ${PF_RUNTIME_TRANSPORT:-direct} (the host's governed HTTP client refuses private addresses, so a co-located Runtime Service needs 'direct')"
echo "  private hosts allowed: yes (the Runtime Service is on loopback; every company opts in separately)"

# ---------------------------------------------------------------------------
# 3. Verify the bridge can now sign and reach the Runtime.
# ---------------------------------------------------------------------------
sleep 2
echo
echo "plugin health:"
"$PC" plugin health polyforge 2>&1 | head -30
