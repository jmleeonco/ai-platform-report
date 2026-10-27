#!/usr/bin/env bash
#
# Nightly point-in-time snapshot of the report site to the NAS.
#   $BACKUP_DIR/snapshots/<YYYYmmdd-HHMMSS>/   full tree; unchanged files are hard links to
#                                             the previous snapshot (rsync --link-dest)
#   $BACKUP_DIR/latest -> snapshots/<newest>
# Keeps the newest $BACKUP_KEEP snapshots. Refuses to run if $BACKUP_DIR is not on NFS
# (an unmounted NAS would otherwise silently fill the local disk).
#
# Installed by deploy/install-server.sh as a user cron job; run by hand any time:
#   bash ~/ai-platform-report-data/bin/backup.sh
# Restore: cp -a $BACKUP_DIR/latest/topics/<slug> $SITE_DIR/topics/   (then POST /api/reindex)
set -euo pipefail

CONF="${CONF:-$(dirname "$0")/config.env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
: "${SITE_DIR:?}" "${BACKUP_DIR:?}"
KEEP="${BACKUP_KEEP:-90}"
REQUIRE_NFS="${REQUIRE_NFS:-1}"

fs="$(findmnt -n -o FSTYPE -T "$(dirname "$BACKUP_DIR")" || true)"
if [ "$REQUIRE_NFS" = 1 ] && [[ "$fs" != nfs* ]]; then
  echo "[$(date '+%F %T')] ABORT: $BACKUP_DIR is on '$fs', not NFS — is the NAS mounted?" >&2
  exit 2
fi
[ -d "$SITE_DIR" ] || { echo "[$(date '+%F %T')] ABORT: $SITE_DIR missing" >&2; exit 2; }

SNAP="$BACKUP_DIR/snapshots"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP"
LAST="$(find "$SNAP" -mindepth 1 -maxdepth 1 -type d -name '20*' ! -name '*.partial' | sort | tail -n 1)"

# -rlpt (no owner/group): the NAS may squash ids; link-dest still matches on perms+mtime+size
rsync -rlpt --exclude='*.tmp' --exclude='.*.tmp' ${LAST:+--link-dest="$LAST"} "$SITE_DIR"/ "$SNAP/$TS.partial"/
mv "$SNAP/$TS.partial" "$SNAP/$TS"
ln -sfn "snapshots/$TS" "$BACKUP_DIR/latest"

mapfile -t ALL < <(find "$SNAP" -mindepth 1 -maxdepth 1 -type d -name '20*' ! -name '*.partial' | sort)
if [ "${#ALL[@]}" -gt "$KEEP" ]; then
  for ((i = 0; i < ${#ALL[@]} - KEEP; i++)); do rm -rf -- "${ALL[$i]}"; done
fi
find "$SNAP" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mmin +720 -exec rm -rf -- {} + 2>/dev/null || true

echo "[$(date '+%F %T')] snapshot $TS ok — $(find "$SNAP/$TS" -type f | wc -l) files, $(du -sh "$SNAP/$TS" | cut -f1) logical, ${#ALL[@]} snapshot(s) kept"
