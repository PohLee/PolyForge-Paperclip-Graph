#!/usr/bin/env bash
#
# Build the plugin and stage the build output on the local filesystem.
#
# Installing from a source checkout on a mounted Windows drive makes the running worker depend on
# a mount that can drop, and it ties a production install to files nobody audited. Staging copies
# exactly the artifacts the host loads — the manifest, the worker bundle, the UI bundle, and the
# dependency manifests that describe them — into a directory that is native, immutable in practice,
# and safe to install from.
#
#   tools/stage-plugin.sh          # build + stage, print the staged path
#
set -euo pipefail

# Every variable has an inline default, and nothing is sourced: these scripts are copied to a
# native run directory by `tools/px.sh` precisely so that running the pilot never depends on the
# Windows automount staying readable.
PF_DATA_DIR="${PF_DATA_DIR:-/home/pohlee/.polyforge}"
STAGE="${POLYFORGE_PLUGIN_STAGE:-$PF_DATA_DIR/plugin}"
REPO="${POLYFORGE_REPO_WSL:-/mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph}"
export PATH="/home/pohlee/.hermes/node/bin:$PATH"

# Staging replaces one directory. Resolve both paths before any mkdir/move so a typo or symlink
# cannot turn a stage operation into moving a home directory or an unrelated tree.
PF_ROOT="$(realpath -m "$PF_DATA_DIR")"
STAGE="$(realpath -m "$STAGE")"
case "$STAGE" in
  "$PF_ROOT"/*) ;;
  *) echo "plugin stage must be a child of PF_DATA_DIR ($PF_ROOT): $STAGE" >&2; exit 1 ;;
esac
[[ "$PF_ROOT" != "/" && "$STAGE" != "$PF_ROOT" ]] || {
  echo "refusing unsafe plugin stage target: $STAGE" >&2
  exit 1
}

# The repository lives on a Windows drive reached through the WSL 9p automount, which
# intermittently fails reads while still reporting the file as present. Verify a real read before
# building, and again before copying, so a flaky mount cannot produce a half-staged build.
for _ in $(seq 1 40); do
  head -c 1 "$REPO/package.json" >/dev/null 2>&1 && break
  sleep 3
done
head -c 1 "$REPO/package.json" >/dev/null 2>&1 || { echo "repository not readable: $REPO" >&2; exit 1; }
SRC="$REPO/packages/paperclip-plugin"

# Build into the repository (esbuild is fast enough) and copy the output off the mount. The
# installed plugin therefore has no runtime dependency on D: at all.
#
# `npm --prefix` rather than `cd`: the 9p automount on this machine fails `chdir` into a path
# while still serving reads from it, so a `cd` into the repository is a coin flip that a retry
# loop cannot fix. Addressing every path absolutely removes the failure mode.
npm --prefix "$REPO" run build --workspace @polyforge/protocol >/dev/null
npm --prefix "$REPO" run build --workspace @polyforge/paperclip-plugin >/dev/null

# Re-verify after the build: the build itself reads from the flaky mount, so the output has to be
# confirmed readable before anything is staged from it.
for _ in $(seq 1 20); do
  head -c 1 "$SRC/dist/worker.js" >/dev/null 2>&1 && break
  sleep 2
done
for required in dist/worker.js dist/manifest.js dist/ui/index.js; do
  head -c 1 "$SRC/$required" >/dev/null 2>&1 || { echo "missing build output: $SRC/$required" >&2; exit 1; }
done

mkdir -p "$(dirname "$STAGE")"
NEXT="$(mktemp -d "${STAGE}.next.XXXXXX")"
cleanup() {
  [[ -n "${NEXT:-}" && -d "$NEXT" ]] && rm -rf -- "$NEXT"
}
trap cleanup EXIT
mkdir -p "$NEXT"
cp -R "$SRC/dist" "$NEXT/dist"
cp "$SRC/package.json" "$NEXT/package.json"
[[ -d "$SRC/migrations" ]] && cp -R "$SRC/migrations" "$NEXT/migrations"
[[ -d "$SRC/node_modules" ]] && cp -R "$SRC/node_modules" "$NEXT/node_modules"

# The worker bundle is fully self-contained (esbuild inlines everything), so a staged install
# needs no dependency resolution at runtime. Record what was staged so an operator can tell one
# build from another without trusting a file name.
node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync, writeFileSync } = require("node:fs");
  const base = process.argv[1];
  const files = ["dist/worker.js", "dist/manifest.js", "dist/ui/index.js"];
  const digests = Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(`${base}/${f}`)).digest("hex")]));
  writeFileSync(`${base}/staged-build.json`, JSON.stringify({
    stagedAt: new Date().toISOString(), files: digests,
  }, null, 2) + "\n");
' "$NEXT"

BACKUP=""
if [[ -e "$STAGE" ]]; then
  BACKUP="$(mktemp -d "${STAGE}.previous.XXXXXX")"
  rmdir "$BACKUP"
  mv "$STAGE" "$BACKUP"
fi
if ! mv "$NEXT" "$STAGE"; then
  if [[ -n "$BACKUP" && -d "$BACKUP" && ! -e "$STAGE" ]]; then
    mv "$BACKUP" "$STAGE"
  fi
  echo "could not activate the staged build; previous stage restored" >&2
  exit 1
fi
NEXT=""
trap - EXIT

[[ -z "$BACKUP" ]] || echo "previous stage retained at $BACKUP" >&2
echo "$STAGE"
