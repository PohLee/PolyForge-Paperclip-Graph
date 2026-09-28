#!/usr/bin/env bash
# Run a command inside the WSL Ubuntu distro where Paperclip lives.
# Usage: wslsh.sh <script-or-command...>
set -euo pipefail
export PATH="/home/pohlee/.hermes/node/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
exec bash "$@"
