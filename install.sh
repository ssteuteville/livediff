#!/usr/bin/env bash
set -euo pipefail

# livediff installer.
#
# Default: build a real package and install it globally, exactly as `npm publish` would —
# so the day this is published, nothing about the install changes.
# --dev: link the working tree instead, for hacking on livediff itself.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE=install
[ "${1:-}" = "--dev" ] && MODE=dev

info() { printf '\033[36m›\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

# --- Node ---
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (>= 24). Install it and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Node >= 24 required; found $(node -v)." >&2
  exit 1
fi
ok "Node $(node -v)"

if command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif command -v npm >/dev/null 2>&1; then
  PM=npm
  warn "pnpm not found; falling back to npm"
else
  echo "pnpm or npm is required." >&2
  exit 1
fi

# --- Stop any running hub, so the new version isn't shadowed by an old process ---
if command -v livediff >/dev/null 2>&1; then
  livediff stop >/dev/null 2>&1 || true
fi

# --- Remove a previous global link ---
# A `pnpm link --global` symlink and an installed package can both sit on PATH; which one runs
# then depends on directory order, so an "upgrade" can silently keep running old code.
info "Removing any previous global install…"
pnpm uninstall --global livediff >/dev/null 2>&1 || true
npm  uninstall --global livediff >/dev/null 2>&1 || true

info "Installing dependencies…"
"$PM" install

info "Building the UI…"
"$PM" run build

chmod +x dist-server/server/cli.js

if [ "$MODE" = dev ]; then
  info "Linking the working tree globally (--dev)…"
  if [ "$PM" = pnpm ]; then
    pnpm link --global || warn "pnpm link failed — run \`pnpm setup\` once, then re-run."
  else
    npm link || warn "npm link failed — try adding npm's global bin dir to PATH."
  fi
else
  info "Packing and installing globally…"
  # pnpm records the tarball path as the dependency spec in its global manifest and re-resolves it
  # on every later global operation — so the tarball must live at a stable path and must NOT be
  # deleted afterwards, or `pnpm add --global <anything>` breaks for every package.
  DIST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/livediff"
  mkdir -p "$DIST_DIR"
  rm -f livediff-*.tgz
  "$PM" pack >/dev/null
  # Must be absolute: pnpm resolves a relative spec against its own global directory, not $PWD.
  BUILT="$SCRIPT_DIR/$(ls -t livediff-*.tgz | head -1)"
  TARBALL="$DIST_DIR/livediff.tgz"
  mv -f "$BUILT" "$TARBALL"
  if [ "$PM" = pnpm ]; then
    pnpm add --global "$TARBALL" || warn "pnpm add --global failed — run \`pnpm setup\` once, then re-run."
  else
    npm install --global "$TARBALL" || warn "npm install --global failed."
  fi
fi

# --- Verify livediff actually runs ---
# `command -v` succeeds for a dangling symlink, so check that it executes, not that it exists.
if livediff --version >/dev/null 2>&1; then
  ok "\`livediff\` v$(livediff --version) → $(command -v livediff)"
else
  warn "\`livediff\` is not runnable yet."
  if command -v livediff >/dev/null 2>&1; then
    warn "  $(command -v livediff) exists but does not run — likely a stale symlink."
    warn "  Remove it, then re-run this installer."
  else
    warn "  pnpm: run \`pnpm setup\` and open a new shell. Or run it directly:"
    warn "  node \"$SCRIPT_DIR/dist-server/server/cli.js\""
  fi
fi

# --- Native agent plugins ---
# Both marketplaces point at the same package under plugins/livediff, so they always receive the
# same skills without copied, stale-able files.
if command -v claude >/dev/null 2>&1; then
  info "Installing the Claude Code plugin…"
  claude plugin marketplace add "$SCRIPT_DIR" || warn "Claude marketplace already registered or could not be added."
  # `install` reports success when the plugin is already present, without upgrading it, so an
  # `install || update` chain would leave the old version pinned on every re-run. Always update.
  claude plugin install livediff@livediff || warn "Claude plugin could not be installed."
  claude plugin update livediff@livediff || warn "Claude plugin could not be updated."
else
  warn "Claude Code is not installed; skipped its plugin."
fi

if command -v codex >/dev/null 2>&1; then
  info "Installing the Codex plugin…"
  codex plugin marketplace add "$SCRIPT_DIR" || warn "Codex marketplace already registered or could not be added."
  codex plugin add livediff@livediff || warn "Codex plugin is already installed or could not be installed."
else
  warn "Codex is not installed; skipped its plugin."
fi

# --- Migrate off the copied skill ---
# Pre-0.5 installs copied the skill into ~/.claude/skills. The plugin owns it now; leaving the
# copy behind means two stale-able answers to the same question.
LEGACY_SKILL="$HOME/.claude/skills/open-worktree-diff"
if [ -d "$LEGACY_SKILL" ]; then
  info "Removing the pre-0.5 skill copy → $LEGACY_SKILL"
  rm -rf "$LEGACY_SKILL"
  ok "Legacy skill removed"
fi

echo
info "Checking the install…"
if livediff --version >/dev/null 2>&1; then
  livediff doctor || true
else
  node "$SCRIPT_DIR/dist-server/server/cli.js" doctor || true
fi

cat <<EOF

$(ok "Done.")

  cd <any git worktree> && livediff .

That registers the worktree, starts the hub if it isn't running, and opens the
diff.

The Claude Code and Codex plugins were installed when their CLIs were available.
Restart either agent client to load the new skills, then say "show me the diff".

Optional shell completion:
  livediff completion install --activate
EOF
