#!/usr/bin/env bash
#
# Install / upgrade the AI Platform report server on this host (10.101.1.183). No sudo:
# Docker (docker group) + a user crontab, like the existing :8080 report hub.
#
#   bash deploy/install-server.sh            # build image, (re)start container, install nightly backup
#   bash deploy/install-server.sh --no-backup-now
#
# Idempotent. Re-run after `git pull` to deploy a new version: the server re-copies the
# managed files (assets/, docs/, AGENTS.md, client/) into the site on start; topics are
# never touched. Settings: deploy/config.env (+ optional deploy/config.local.env).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$REPO/deploy/config.env"
# shellcheck disable=SC1091
[ -f "$REPO/deploy/config.local.env" ] && . "$REPO/deploy/config.local.env"
BACKUP_NOW=1
[ "${1:-}" = "--no-backup-now" ] && BACKUP_NOW=0

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }

docker info >/dev/null 2>&1 || { echo "cannot talk to docker (are you in the docker group?)" >&2; exit 1; }

say "1/4  image $IMAGE"
docker build -q -f "$REPO/server/Dockerfile" -t "$IMAGE" "$REPO" >/dev/null
ok "built from $REPO ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo 'no git'))"

say "2/4  site data $SITE_DIR"
mkdir -p "$SITE_DIR" "$DATA_ROOT/bin" "$DATA_ROOT/logs"
ok "ready ($(find "$SITE_DIR/topics" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l) topics)"

say "3/4  container $CONTAINER on :$PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --restart always \
  --user "$(id -u):$(id -g)" \
  -p "$PORT:8090" \
  -e PUBLIC_URL="$PUBLIC_URL" -e REPORT_TOKEN="${REPORT_TOKEN:-}" -e SITE_TITLE="${SITE_TITLE:-AI Platform Reports}" \
  -v "$SITE_DIR:/site" \
  --label org.oncosoft.repo="$REPO" \
  "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || { docker logs --tail 50 "$CONTAINER"; echo "server did not come up" >&2; exit 1; }
ok "serving $PUBLIC_URL/  (restart policy: always)"

say "4/4  nightly backup → $BACKUP_DIR"
install -m 0755 "$REPO/deploy/backup.sh" "$DATA_ROOT/bin/backup.sh"
{ cat "$REPO/deploy/config.env"; [ -f "$REPO/deploy/config.local.env" ] && cat "$REPO/deploy/config.local.env"; } > "$DATA_ROOT/bin/config.env"
mkdir -p "$BACKUP_DIR" || { echo "cannot create $BACKUP_DIR (NAS mounted? writable?)" >&2; exit 1; }
BEGIN="# >>> ai-platform-report (managed by deploy/install-server.sh) >>>"
END="# <<< ai-platform-report <<<"
JOB="$BACKUP_AT * * * /usr/bin/flock -n /tmp/ai-platform-report-backup.lock /usr/bin/timeout 4h /bin/bash $DATA_ROOT/bin/backup.sh >> $DATA_ROOT/logs/backup.log 2>&1"
{ crontab -l 2>/dev/null | sed "/^$(printf '%s' "$BEGIN" | sed 's/[]\/$*.^[]/\\&/g')\$/,/^$(printf '%s' "$END" | sed 's/[]\/$*.^[]/\\&/g')\$/d"
  echo "$BEGIN"; echo "$JOB"; echo "$END"; } | crontab -
ok "cron: $BACKUP_AT * * *  (KST) → $DATA_ROOT/logs/backup.log, keep $BACKUP_KEEP snapshots"
if [ "$BACKUP_NOW" = 1 ]; then
  /bin/bash "$DATA_ROOT/bin/backup.sh" | tee -a "$DATA_ROOT/logs/backup.log" | sed 's/^/    /'
fi

cat <<MSG

Done.  Site:    $PUBLIC_URL/
       Clients: curl -fsSL $PUBLIC_URL/client/install.sh | AIREPORT_OWNER="<name>" bash
       Logs:    docker logs $CONTAINER   ·   $DATA_ROOT/logs/backup.log
MSG
