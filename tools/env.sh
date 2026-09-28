#!/usr/bin/env bash
# Common environment for the WSL toolchain used by this repository.
export PATH="/home/pohlee/.hermes/node/bin:$PATH"
export PAPERCLIP_BIN="/home/pohlee/.npm/_npx/43414d9b790239bb/node_modules/.bin/paperclipai"
export PAPERCLIP_API="${PAPERFORGE_PAPERCLIP_API:-${PAPERCLIP_API:-http://127.0.0.1:3100}}"
export REPO_WSL="/mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph"
export PF_DATA_DIR="${PF_DATA_DIR:-/home/pohlee/.polyforge}"
export PF_SERVICE_URL="${PF_SERVICE_URL:-http://127.0.0.1:8787}"

# Everything the pilot touches at runtime lives on the native filesystem. The repository on D: is
# the source of truth, but a running system must not depend on a mount that can drop mid-procedure,
# and a plugin installed from a mount is a plugin that stops existing when the mount does.
export POLYFORGE_PLUGIN_STAGE="${POLYFORGE_PLUGIN_STAGE:-$PF_DATA_DIR/plugin}"
export POLYFORGE_RUN_DIR="${POLYFORGE_RUN_DIR:-$PF_DATA_DIR/run}"

