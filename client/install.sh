#!/usr/bin/env bash
#
# Install the `aireport` CLI and the `ai-report` skill for Claude Code and Codex.
#
#   From the report server (no git needed):
#     curl -fsSL http://10.101.1.183:8090/client/install.sh | bash
#   From a checkout of the ai-platform-report repo:
#     bash client/install.sh
#
# Installs:
#   ~/.local/bin/aireport
#   ~/.claude/skills/ai-report/SKILL.md     (Claude Code)
#   ~/.codex/skills/ai-report/SKILL.md      (Codex)
# Options (env): AIREPORT_URL, AIREPORT_OWNER, BIN_DIR, SKILL_TARGETS="claude codex", LINK=1
# (LINK=1 with a repo checkout symlinks instead of copying, so `git pull` updates both.)
#
set -euo pipefail

URL="${AIREPORT_URL:-__AIREPORT_URL__}"
case "$URL" in __*) URL="http://10.101.1.183:8090" ;; esac
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
TARGETS="${SKILL_TARGETS:-claude codex}"
LINK="${LINK:-0}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()  { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }

SRC=""
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/aireport" ] && [ -f "$here/../skills/ai-report/SKILL.md" ]; then
  SRC="$(cd "$here/.." && pwd)"
fi

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

say "aireport CLI → $BIN_DIR/aireport"
mkdir -p "$BIN_DIR"
if [ -n "$SRC" ] && [ "$LINK" = 1 ]; then
  ln -sfn "$SRC/client/aireport" "$BIN_DIR/aireport"; ok "symlinked from $SRC"
elif [ -n "$SRC" ]; then
  install -m 0755 "$SRC/client/aireport" "$BIN_DIR/aireport"; ok "copied from $SRC"
else
  curl -fsSL "$URL/client/aireport" -o "$BIN_DIR/aireport.tmp" && chmod 0755 "$BIN_DIR/aireport.tmp" \
    && mv "$BIN_DIR/aireport.tmp" "$BIN_DIR/aireport"; ok "downloaded from $URL"
fi

for t in $TARGETS; do
  case "$t" in
    claude) dir="$HOME/.claude/skills/ai-report" ;;
    codex)  dir="${CODEX_HOME:-$HOME/.codex}/skills/ai-report" ;;
    *) echo "unknown skill target $t" >&2; continue ;;
  esac
  say "skill ($t) → $dir/SKILL.md"
  mkdir -p "$dir"
  if [ -n "$SRC" ] && [ "$LINK" = 1 ]; then
    ln -sfn "$SRC/skills/ai-report/SKILL.md" "$dir/SKILL.md"
  elif [ -n "$SRC" ]; then
    install -m 0644 "$SRC/skills/ai-report/SKILL.md" "$dir/SKILL.md"
  else
    curl -fsSL "$URL/client/SKILL.md" -o "$dir/SKILL.md"
  fi
  ok "installed"
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
echo "    Claude Code: /ai-report   ·   Codex: \$ai-report (or just ask for a report)"
