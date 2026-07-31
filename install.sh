#!/usr/bin/env bash
set -euo pipefail

# livediff installer: build the app, expose the `livediff` CLI globally, and install
# the Claude skill so any project can ask Claude to "open a diff of my worktree".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info() { printf '\033[36m›\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

# --- Node ---
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (>= 18). Install it and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node >= 18 required; found $(node -v)." >&2
  exit 1
fi
ok "Node $(node -v)"

# --- Package manager ---
if command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif command -v npm >/dev/null 2>&1; then
  PM=npm
  warn "pnpm not found; falling back to npm"
else
  echo "pnpm or npm is required." >&2
  exit 1
fi

info "Installing dependencies…"
"$PM" install

info "Building the UI…"
"$PM" run build

chmod +x server/cli.js

# --- Global CLI ---
info "Linking the \`livediff\` command globally…"
if [ "$PM" = pnpm ]; then
  pnpm link --global || warn "pnpm link failed — you may need to run \`pnpm setup\` once, then re-run."
else
  npm link || warn "npm link failed — try \`sudo npm link\` or add npm's global bin to PATH."
fi

if command -v livediff >/dev/null 2>&1; then
  ok "\`livediff\` is on your PATH"
else
  warn "\`livediff\` isn't on your PATH yet. Ensure your package manager's global bin dir is on PATH"
  warn "  (pnpm: run \`pnpm setup\` and open a new shell). You can also run it directly:"
  warn "  node \"$SCRIPT_DIR/server/cli.js\""
fi

# --- Claude skill (personal scope: available in every project) ---
SKILL_SRC="$SCRIPT_DIR/skills/open-worktree-diff"
SKILL_DST="$HOME/.claude/skills/open-worktree-diff"
info "Installing the Claude skill → $SKILL_DST"
mkdir -p "$HOME/.claude/skills"
rm -rf "$SKILL_DST"
cp -R "$SKILL_SRC" "$SKILL_DST"
ok "Skill installed (personal scope — loads in every project)"

cat <<EOF

$(ok "Done.")

Next:
  livediff                 # start the hub → http://localhost:4180
  cd <any repo> && livediff add .   # register a worktree to show it

In Claude Code, just say "open a diff of my worktree". The skill will register the
current worktree and share the URL. Leave comments in the browser, then ask Claude
to "address my diff comments".

Prefer the plugin system instead of the copied skill? From any machine:
  /plugin marketplace add <this-repo-git-url>
  /plugin install livediff@livediff
(The plugin carries only the skill; the \`livediff\` CLI still comes from this installer.)
EOF
