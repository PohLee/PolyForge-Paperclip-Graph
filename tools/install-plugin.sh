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
export PATH="/home/pohlee/.hermes/node/bin:$PATH"

head -c 1 "$STAGE/package.json" >/dev/null 2>&1 \
  || { echo "nothing staged at $STAGE; run tools/stage-plugin.sh" >&2; exit 1; }

echo "staged build:"
sed 's/^/  /' "$STAGE/staged-build.json"

# A local-path install is a development workflow and a re-install is how an upgrade lands. The
# previous plugin row is soft-deleted so its config, state, and history stay readable; that is
# also why this is a *reinstall* and not an upgrade: the stage path is a new directory identity.
"$PC" plugin uninstall polyforge >/dev/null 2>&1 || true

for attempt in 1 2 3; do
  if OUT="$("$PC" plugin install "$STAGE" 2>&1)"; then
    echo "$OUT" | tail -3
    break
  fi
  echo "$OUT" | tail -3
  if [ "$attempt" = 3 ]; then
    echo "install failed after 3 attempts" >&2
    exit 1
  fi
  sleep 5
done

echo
"$PC" plugin list
