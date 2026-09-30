#!/usr/bin/env bash
#
# Install (or reinstall) the staged plugin into the local Paperclip instance.
#
#   tools/install-plugin.sh
#
set -euo pipefail

PF_DATA_DIR="${PF_DATA_DIR:-/home/pohlee/.polyforge}"
STAGE="${POLYFORGE_PLUGIN_STAGE:-$PF_DATA_DIR/plugin}"
PC="${PAPERCLIP_BIN:-/home/pohlee/.npm/_npx/43414d9b790239bb/node_modules/.bin/paperclipai}"
PAPERCLIP_API="${PAPERCLIP_API:-http://127.0.0.1:3100}"
export PATH="/home/pohlee/.hermes/node/bin:$PATH"

head -c 1 "$STAGE/package.json" >/dev/null 2>&1 \
  || { echo "nothing staged at $STAGE; run tools/stage-plugin.sh" >&2; exit 1; }
STAGE="$(realpath -e "$STAGE")"

# Validate the exact files the host will load before removing the currently installed plugin.
# A corrupt, incomplete, or mismatched staged build must be a no-op on the live installation.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPS_DIR="${POLYFORGE_RUN_DIR:-$(dirname "$SCRIPT_DIR")}/ops"
node "$OPS_DIR/verify-staged-plugin.mjs" "$STAGE"
[[ -x "$PC" ]] || { echo "Paperclip CLI is not executable: $PC" >&2; exit 1; }

# Prove the host and its read-only plugin inventory are reachable before removing the current
# installation. The preflight is GET-only; it never probes or attempts an install endpoint.
PREFLIGHT="$(node "$OPS_DIR/install-plugin-target.mjs" preflight "$PAPERCLIP_API" "$STAGE")"
"$PC" plugin list >/dev/null || { echo "Paperclip CLI cannot read the current plugin inventory" >&2; exit 1; }
HAS_EXISTING="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(String(p.installed === true));' "$PREFLIGHT")"
EXISTING_PATH="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.plugin?.packagePath ?? "");' "$PREFLIGHT")"

if [[ "$HAS_EXISTING" == "true" ]]; then
  [[ -n "$EXISTING_PATH" ]] \
    || { echo "existing PolyForge has no package path; refusing replacement without a rollback target" >&2; exit 1; }
  EXISTING_PATH="$(realpath -e "$EXISTING_PATH")" \
    || { echo "existing PolyForge package path is not locally readable; refusing replacement" >&2; exit 1; }
  [[ "$EXISTING_PATH" != "$STAGE" ]] \
    || { echo "stage path equals the installed package path; use a new immutable stage path for recoverable replacement" >&2; exit 1; }
  node "$OPS_DIR/install-plugin-target.mjs" verify "$PAPERCLIP_API" "$EXISTING_PATH" >/dev/null \
    || { echo "existing PolyForge package cannot be verified and restored; refusing replacement" >&2; exit 1; }
fi

restore_previous() {
  [[ "$HAS_EXISTING" == "true" ]] \
    || { echo "no previous PolyForge installation is available to restore" >&2; return 1; }

  local current_preflight current_path
  current_preflight="$(node "$OPS_DIR/install-plugin-target.mjs" preflight "$PAPERCLIP_API" "$STAGE")" \
    || { echo "cannot inspect Paperclip before rollback" >&2; return 1; }
  current_path="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.plugin?.packagePath ?? "");' "$current_preflight")"
  if [[ -n "$current_path" ]]; then
    current_path="$(realpath -e "$current_path")" \
      || { echo "current PolyForge path is not locally readable; refusing speculative rollback" >&2; return 1; }
    if [[ "$current_path" == "$EXISTING_PATH" ]]; then
      node "$OPS_DIR/install-plugin-target.mjs" verify "$PAPERCLIP_API" "$EXISTING_PATH" >/dev/null \
        && { echo "previous PolyForge installation is still ready"; return 0; }
      echo "previous package path remains installed but is not verifiably ready; manual recovery required" >&2
      return 1
    fi
    if [[ "$current_path" != "$STAGE" ]]; then
      echo "Paperclip reports an unexpected PolyForge path; refusing to uninstall it: $current_path" >&2
      return 1
    fi
    "$PC" plugin uninstall polyforge >/dev/null \
      || { echo "could not remove the failed staged package; manual recovery required" >&2; return 1; }
  fi

  "$PC" plugin install "$EXISTING_PATH" \
    || { echo "could not reinstall the previous PolyForge package; manual recovery required" >&2; return 1; }
  node "$OPS_DIR/install-plugin-target.mjs" verify "$PAPERCLIP_API" "$EXISTING_PATH" \
    || { echo "previous PolyForge package was reinstalled but is not ready; manual recovery required" >&2; return 1; }
  echo "previous PolyForge installation restored"
}

echo "staged build:"
sed 's/^/  /' "$STAGE/staged-build.json"

# A local-path install is a development workflow and a re-install is how an upgrade lands. The
# previous plugin row is soft-deleted so its config, state, and history stay readable; that is
# also why this is a *reinstall* and not an upgrade: the stage path is a new directory identity.
if [[ "$HAS_EXISTING" == "true" ]]; then
  "$PC" plugin uninstall polyforge >/dev/null \
    || { echo "could not uninstall the existing PolyForge plugin; staged files are intact" >&2; exit 1; }
else
  echo "no existing PolyForge plugin reported; skipping uninstall"
fi

INSTALLED=0
for attempt in 1 2 3; do
  if OUT="$("$PC" plugin install "$STAGE" 2>&1)"; then
    echo "$OUT" | tail -3
    INSTALLED=1
    break
  fi
  echo "$OUT" | tail -3
  if [ "$attempt" = 3 ]; then
    echo "install failed after 3 attempts" >&2
    if [[ "$HAS_EXISTING" == "true" ]]; then restore_previous || echo "automatic rollback was incomplete" >&2; fi
    exit 1
  fi
  # Some CLI failures happen after the host has accepted the install. Reconcile by observing the
  # host's ready state and exact staged package path before retrying, so an ambiguous response
  # cannot create duplicate install rows.
  if node "$OPS_DIR/install-plugin-target.mjs" verify "$PAPERCLIP_API" "$STAGE" >/dev/null 2>&1; then
    echo "host reports the staged package ready despite the CLI error; not retrying"
    INSTALLED=1
    break
  fi

  CURRENT_PREFLIGHT="$(node "$OPS_DIR/install-plugin-target.mjs" preflight "$PAPERCLIP_API" "$STAGE")" \
    || { echo "cannot reconcile install state; not retrying an ambiguous operation" >&2; exit 1; }
  CURRENT_PATH="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.plugin?.packagePath ?? "");' "$CURRENT_PREFLIGHT")"
  if [[ -n "$CURRENT_PATH" ]]; then
    CURRENT_PATH="$(realpath -e "$CURRENT_PATH")" \
      || { echo "host reports an unreadable PolyForge path; not retrying" >&2; exit 1; }
    if [[ "$CURRENT_PATH" == "$STAGE" ]]; then
      echo "host registered the staged package but it is not ready; stopping retries"
      if [[ "$HAS_EXISTING" == "true" ]]; then restore_previous || echo "automatic rollback was incomplete" >&2; fi
      exit 1
    fi
    if [[ "$CURRENT_PATH" == "$EXISTING_PATH" ]]; then
      echo "the previous package remains installed; not retrying an unaccepted replacement" >&2
      exit 1
    fi
    echo "host reports an unexpected PolyForge path; refusing retry: $CURRENT_PATH" >&2
    exit 1
  fi
  sleep 5
done

[[ "$INSTALLED" == "1" ]] || { echo "installation did not complete" >&2; exit 1; }
if ! node "$OPS_DIR/install-plugin-target.mjs" verify "$PAPERCLIP_API" "$STAGE"; then
  echo "Paperclip did not report the staged package ready at the expected version and path" >&2
  if [[ "$HAS_EXISTING" == "true" ]]; then restore_previous || echo "automatic rollback was incomplete" >&2; fi
  exit 1
fi

echo
"$PC" plugin list
