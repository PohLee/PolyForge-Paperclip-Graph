#!/usr/bin/env bash
#
# Mirror the repository to the local filesystem and build there.
#
# The repository lives on a Windows drive reached through the WSL 9p automount, which on this
# machine intermittently stops serving reads for seconds at a time — sometimes between two
# consecutive `head` calls on the same file. That makes an in-place build unreliable in a way no
# retry loop can fix: `npm` and `tsc` each open hundreds of files, and the probability of a clean
# run is the probability that none of them lands inside an outage.
#
# So the source of truth stays on D: and the *build environment* is a native mirror. A mirror is
# cheap (the repository is a few megabytes of source), builds are fast, and the staged plugin is
# installed from native storage anyway — the host never reads the mount.
#
#   tools/sync-build.sh            # mirror, install, typecheck, test
#   tools/sync-build.sh --no-test  # mirror and build only
#
set -uo pipefail

REPO="${POLYFORGE_REPO_WSL:-/mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph}"
MIRROR="${POLYFORGE_MIRROR:-/home/pohlee/.polyforge/src}"
export PATH="/home/pohlee/.hermes/node/bin:$PATH"
RUN_TESTS=1
[ "${1:-}" = "--no-test" ] && RUN_TESTS=0

wait_for_read() {
  for _ in $(seq 1 30); do
    # Read three files at different depths in one go: the mount reports itself present while
    # failing reads, so a single probe is not evidence. All three paths must be real files —
    # a typo in a sentinel reports a healthy mount as broken, which is its own kind of outage.
    if head -c 1 "$REPO/package.json" >/dev/null 2>&1 \
      && head -c 1 "$REPO/packages/paperclip-plugin/src/worker.ts" >/dev/null 2>&1 \
      && head -c 1 "$REPO/services/polyforge/src/polyforge/core/runtime/engine.py" >/dev/null 2>&1; then
      return 0
    fi
    sleep 4
  done
  return 1
}

if ! wait_for_read; then
  echo "the repository mount is not readable; run tools/recover-mount.sh first" >&2
  exit 1
fi

echo "=== mirroring to $MIRROR ==="
mkdir -p "$MIRROR"
# `node_modules` and build output are excluded deliberately: the mirror installs its own
# dependencies and builds its own artifacts, and copying either would defeat the point.
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude '*.sqlite3' --exclude '*.sqlite3-wal' --exclude '*.sqlite3-shm' \
  --exclude __pycache__ \
  "$REPO/" "$MIRROR/"

echo "=== installing dependencies in the mirror ==="
if [ -f "$MIRROR/package-lock.json" ]; then
  npm --prefix "$MIRROR" ci --no-audit --no-fund >/dev/null 2>&1 \
    || npm --prefix "$MIRROR" install --no-audit --no-fund >/dev/null 2>&1
else
  npm --prefix "$MIRROR" install --no-audit --no-fund >/dev/null 2>&1
fi

echo "=== building the protocol package first ==="
# Order matters and is easy to get wrong: the plugin resolves `@polyforge/protocol` through the
# workspace link to `packages/protocol/dist`. Typechecking the plugin before that exists makes
# every imported type resolve to `any`, which then produces a screen of *downstream* errors that
# look like real defects and are not.
npm --prefix "$MIRROR" run build --workspace @polyforge/protocol || exit 1

echo "=== typecheck ==="
npm --prefix "$MIRROR" run typecheck --workspace @polyforge/paperclip-plugin || exit 1

echo "=== bundling the plugin (manifest, worker, UI) ==="
# The typecheck proves the types; only esbuild produces the artifacts the host actually loads.
# Staging a typecheck-only tree would install a package with no `dist`, which the host rejects as
# "not a Paperclip plugin" — a confusing error for what is really a missing build step.
npm --prefix "$MIRROR" run build --workspace @polyforge/paperclip-plugin || exit 1
for artifact in dist/worker.js dist/manifest.js dist/ui/index.js; do
  [ -s "$MIRROR/packages/paperclip-plugin/$artifact" ] \
    || { echo "missing build artifact: $artifact" >&2; exit 1; }
done

if [ "$RUN_TESTS" = 1 ]; then
  echo "=== plugin tests ==="
  npm --prefix "$MIRROR" test --workspace @polyforge/paperclip-plugin | tail -8 || exit 1
  echo "=== core tests ==="
  (cd "$MIRROR" && PYTHONPATH=services/polyforge/src python3 -m unittest discover \
      -s services/polyforge/tests -p 'test_*.py' -t . 2>&1 | tail -5) || exit 1
fi

echo "=== staging the plugin from the mirror ==="
STAGE="${POLYFORGE_PLUGIN_STAGE:-/home/pohlee/.polyforge/plugin}"
NEXT="$STAGE.next"
rm -rf "$NEXT"
mkdir -p "$NEXT"
cp -R "$MIRROR/packages/paperclip-plugin/dist" "$NEXT/dist"
cp "$MIRROR/packages/paperclip-plugin/package.json" "$NEXT/package.json"
[ -d "$MIRROR/packages/paperclip-plugin/migrations" ] && cp -R "$MIRROR/packages/paperclip-plugin/migrations" "$NEXT/migrations"
node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync, writeFileSync } = require("node:fs");
  const base = process.argv[1];
  const files = ["dist/worker.js", "dist/manifest.js", "dist/ui/index.js"];
  const digests = Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(`${base}/${f}`)).digest("hex")]));
  writeFileSync(`${base}/staged-build.json`, JSON.stringify({ stagedAt: new Date().toISOString(), source: "mirror", files: digests }, null, 2) + "\n");
' "$NEXT"
rm -rf "$STAGE.previous"
[ -d "$STAGE" ] && mv "$STAGE" "$STAGE.previous"
mv "$NEXT" "$STAGE"
chmod 755 "$STAGE"
sed 's/^/  /' "$STAGE/staged-build.json"

echo "$STAGE"
