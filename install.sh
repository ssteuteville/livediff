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
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# --- Node ---
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (>= 22.12.0). Install it and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  echo "Node >= 22.12.0 required; found $(node -v)." >&2
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

# Global ops must ignore our `packageManager` pin: corepack would otherwise point the user's global dir at a store their own pnpm can't read.
user_pm() { COREPACK_ENABLE_PROJECT_SPEC=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }

livediff_runnable() { livediff --version >/dev/null 2>&1; }

npm_global_bin() {
  local prefix
  prefix="$(user_pm npm prefix -g 2>/dev/null || true)"
  if [ -n "$prefix" ]; then printf '%s/bin' "$prefix"; else printf '<unknown — check `npm prefix -g`>'; fi
}

# --- Stop any running hub, so the new version isn't shadowed by an old process ---
if command -v livediff >/dev/null 2>&1; then
  livediff stop >/dev/null 2>&1 || true
fi

# --- Remove a previous global link ---
# A `pnpm link --global` symlink and an installed package can both sit on PATH; which one runs
# then depends on directory order, so an "upgrade" can silently keep running old code.
info "Removing any previous global install…"
user_pm pnpm uninstall --global livediff >/dev/null 2>&1 || true
user_pm npm  uninstall --global livediff >/dev/null 2>&1 || true

info "Installing dependencies…"
"$PM" install

info "Building the UI…"
"$PM" run build

chmod +x dist-server/server/cli.js

if [ "$MODE" = dev ]; then
  info "Linking the working tree globally (--dev)…"
  if [ "$PM" = pnpm ]; then
    user_pm pnpm link --global || die "pnpm link --global failed. If it mentions \`pnpm setup\`, run that once and re-run this installer."
  else
    user_pm npm link || die "npm link failed. Check that npm's global bin dir is writable."
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
    user_pm pnpm add --global "$TARBALL" || die "pnpm add --global failed. If it mentions \`pnpm setup\`, run that once and re-run this installer."
  else
    user_pm npm install --global "$TARBALL" || die "npm install --global failed."
  fi
fi

# `livediff stop` hashed the old binary's path, and bash keeps resolving that deleted path afterwards.
hash -r

# --- Verify livediff actually runs ---
# `command -v` succeeds for a dangling symlink, so check that it executes, not that it exists.
if livediff_runnable; then
  ok "\`livediff\` v$(livediff --version) → $(command -v livediff)"
elif command -v livediff >/dev/null 2>&1; then
  warn "$(command -v livediff) exists but does not run — likely a stale symlink. Remove it, then re-run this installer."
else
  warn "The package installed, but \`livediff\` is not on PATH in this shell yet."
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
if livediff_runnable; then
  livediff doctor || true
else
  node "$SCRIPT_DIR/dist-server/server/cli.js" doctor || true
fi

if ! livediff_runnable; then
  echo
  if command -v livediff >/dev/null 2>&1; then
    warn "Installed, but $(command -v livediff) does not run — likely a stale symlink."
    warn "  Remove it, then re-run this installer."
  else
    warn "Installed, but not usable from this shell yet."
    if [ "$PM" = pnpm ]; then
      warn "  Run \`pnpm setup\`, open a new shell, and re-run this installer."
      warn "  pnpm's global bin dir is: $(user_pm pnpm bin -g 2>/dev/null || echo '<unset — that is the problem>')"
    else
      warn "  Add npm's global bin dir to PATH: $(npm_global_bin)"
    fi
  fi
  warn "  Until then, run it directly: node \"$SCRIPT_DIR/dist-server/server/cli.js\""
  exit 1
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
