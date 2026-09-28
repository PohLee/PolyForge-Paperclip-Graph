#!/usr/bin/env bash
# Wait for the Windows drive to be visible, then cd into the repository.
#
# The WSL automount intermittently reports a path as present and then refuses to chdir into it,
# which turns a long, otherwise reliable procedure into a random failure. Every script that
# touches the repository goes through here so that flake is handled once.
#
# Usage:  source tools/cd-repo.sh && <command>
cd_repo() {
  local repo="${1:?usage: cd_repo <repo-path>}"
  for _ in $(seq 1 40); do
    if [ -d "$repo" ] && cd "$repo" 2>/dev/null && [ -f package.json ]; then
      return 0
    fi
    sleep 2
  done
  echo "cd_repo: $repo never became usable" >&2
  return 1
}
