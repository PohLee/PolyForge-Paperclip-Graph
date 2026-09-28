#!/usr/bin/env bash
# Recover a wedged Windows-drive mount, then verify a real path on it.
#
# The 9p automount intermittently stops serving reads while still reporting the mount present,
# which blocks every build and deploy with an ENOENT on a file that demonstrably exists. A lazy
# unmount plus a fresh drvfs mount clears it. Only the repository on D: is involved: the Paperclip
# instance keeps its data under /home/pohlee and is not touched.
#
#   tools/recover-mount.sh                       # remount D: and confirm the repository reads
#   tools/recover-mount.sh "C:/x/y/file.txt"     # confirm some other path on C:
#
# The probe must be a *real read of a real file at a real depth*. Probing only the mount root
# passes while the whole tree is unreadable, which is exactly the failure this exists to clear.
set -uo pipefail

DRIVE="${POLYFORGE_MOUNT_DRIVE:-D:}"
MNT="/mnt/${DRIVE%:}"
MNT="${MNT,,}"
SENTINEL="${1:-/mnt/d/Projects/00.Own/05.AI-Ops/PolyForge-Paperclip-Graph/package.json}"

[ -d "$MNT" ] || { echo "$MNT does not exist; nothing to recover" >&2; exit 1; }

probe() { head -c 1 "$SENTINEL" >/dev/null 2>&1; }

echo "=== before ==="
mount | grep " $MNT " | head -1
if probe; then echo "  readable: $SENTINEL"; exit 0; fi
echo "  wedged: $SENTINEL is not readable though the mount is present"

# Retry the *read* before touching the mount. The 9p failure is usually a brief client-side cache
# glitch that clears on its own, and unmounting on the first failed probe tears down a working
# mount and restarts the outage — which is strictly worse than waiting. A remount is considered
# only after several consecutive failures.
FAILURES=0
for i in $(seq 1 24); do
  if probe; then
    [ "$FAILURES" -gt 0 ] && echo "  readable after $i probe(s), $FAILURES remount(s): $SENTINEL"
    exit 0
  fi
  FAILURES=$((FAILURES + 1))
  if [ "$FAILURES" -ge 3 ] && [ $((FAILURES % 3)) -eq 0 ]; then
    echo "  $i probes failed; remounting $DRIVE"
    # `-l` because a busy 9p mount will not detach cleanly, and a lazy detach is safe here:
    # nothing in the pilot holds a file open across the remount.
    umount -l "$MNT" 2>&1 | head -3 || true
    sleep 2
    mount -t drvfs "$DRIVE" "$MNT" -o metadata,uid=1000,gid=1000 2>&1 | head -3 || true
    sleep 3
  else
    sleep 5
  fi
done

echo "=== after ==="
mount | grep " $MNT " | head -1
echo "  still unreadable: $SENTINEL" >&2
exit 1
