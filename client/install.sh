#!/usr/bin/env bash
#
# Install the `aireport` CLI and the `pl-report` skill for Claude Code and Codex.
#
#   From GitHub or the report server (no git needed):
#     curl -fsSL https://raw.githubusercontent.com/jmleeonco/ai-platform-report/main/client/install.sh | bash
#     curl -fsSL https://plreport.oncosoft.io/client/install.sh | bash
#   From a checkout of the ai-platform-report repo:
#     bash client/install.sh
#
# Installs:
#   ~/.local/bin/aireport
#   ~/.claude/skills/pl-report/SKILL.md     (Claude Code)
#   ~/.codex/skills/pl-report/SKILL.md      (Codex)
# Options (env): AIREPORT_URL, AIREPORT_OWNER, BIN_DIR, SKILL_TARGETS="claude codex", LINK=1
# (LINK=1 with a repo checkout symlinks instead of copying, so `git pull` updates both.)
#
set -euo pipefail

URL="${AIREPORT_URL:-__AIREPORT_URL__}"
case "$URL" in __*) URL="https://plreport.oncosoft.io" ;; esac
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
TARGETS="${SKILL_TARGETS:-claude codex}"
LINK="${LINK:-0}"
GH_RAW="https://raw.githubusercontent.com/jmleeonco/ai-platform-report/main"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()  { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
# fetch <server path> <repo path> <dest>: the report server first, GitHub if it is unreachable
fetch() {
  curl -fsSL "$URL/$1" -o "$3.tmp" 2>/dev/null || curl -fsSL "$GH_RAW/$2" -o "$3.tmp" \
    || { echo "cannot download $2 from $URL or GitHub" >&2; exit 1; }
  mv "$3.tmp" "$3"
}

SRC=""
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/aireport" ] && [ -f "$here/../skills/pl-report/SKILL.md" ]; then
  SRC="$(cd "$here/.." && pwd)"
fi

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

say "aireport CLI → $BIN_DIR/aireport"
mkdir -p "$BIN_DIR"
if [ -n "$SRC" ] && [ "$LINK" = 1 ]; then
  chmod +x "$SRC/client/aireport" 2>/dev/null || true
  ln -sfn "$SRC/client/aireport" "$BIN_DIR/aireport"; ok "symlinked from $SRC"
elif [ -n "$SRC" ]; then
  install -m 0755 "$SRC/client/aireport" "$BIN_DIR/aireport"; ok "copied from $SRC"
else
  fetch client/aireport client/aireport "$BIN_DIR/aireport"; chmod 0755 "$BIN_DIR/aireport"; ok "downloaded"
fi

for t in $TARGETS; do
  case "$t" in
    claude) dir="$HOME/.claude/skills/pl-report" ;;
    codex)  dir="${CODEX_HOME:-$HOME/.codex}/skills/pl-report" ;;
    *) echo "unknown skill target $t" >&2; continue ;;
  esac
  say "skill ($t) → $dir/SKILL.md"
  mkdir -p "$dir"
  if [ -n "$SRC" ] && [ "$LINK" = 1 ]; then
    ln -sfn "$SRC/skills/pl-report/SKILL.md" "$dir/SKILL.md"
  elif [ -n "$SRC" ]; then
    install -m 0644 "$SRC/skills/pl-report/SKILL.md" "$dir/SKILL.md"
  else
    fetch client/SKILL.md skills/pl-report/SKILL.md "$dir/SKILL.md"
  fi
  ok "installed"
  # the skill used to be called ai-report; remove that copy (only if it is ours) so it doesn't trigger twice
  old="$(dirname "$dir")/ai-report"
  if [ -f "$old/SKILL.md" ] && grep -q '^name: ai-report' "$old/SKILL.md" && grep -q aireport "$old/SKILL.md"; then
    rm -f "$old/SKILL.md"; rmdir "$old" 2>/dev/null || true; ok "removed old skill name ai-report"
  fi
done

say "config"
cfg_args=(--url "$URL")
[ -n "${AIREPORT_OWNER:-}" ] && cfg_args+=(--owner "$AIREPORT_OWNER")
"$BIN_DIR/aireport" config "${cfg_args[@]}" >/dev/null
ok "server $URL$( [ -n "${AIREPORT_OWNER:-}" ] && echo ", owner $AIREPORT_OWNER")"
if "$BIN_DIR/aireport" health >/dev/null 2>&1; then ok "server reachable"; else
  printf '    \033[1;33m!\033[0m server not reachable right now (%s)\n' "$URL"; fi

python3 -c "import numpy" 2>/dev/null && { python3 -c "import nibabel" 2>/dev/null || python3 -c "import SimpleITK" 2>/dev/null; } \
  && ok "numpy + nibabel/SimpleITK present (aireport viewer works)" \
  || printf '    \033[1;33m!\033[0m for `aireport viewer`: pip install numpy nibabel scipy\n'
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) printf '    \033[1;33m!\033[0m add %s to PATH\n' "$BIN_DIR" ;; esac
[ -z "${AIREPORT_OWNER:-}" ] && echo "    next: aireport config --owner \"<your name>\""
echo "    Claude Code: /pl-report   ·   Codex: \$pl-report (or just ask for a report)"
