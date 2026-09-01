#!/usr/bin/env bash
set -euo pipefail

# Point livediff's browser opener at cmux, so diffs open in the workspace you are actually reading.
# Installs the opener shim onto PATH and sets `browser.opener` to it. Re-runnable.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_NAME=livediff-cmux-open
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
TARGET="$BIN_DIR/$SHIM_NAME"

info() { printf '\033[36m›\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v livediff >/dev/null 2>&1 || die "livediff is not on PATH — run ./install.sh first"
command -v cmux >/dev/null 2>&1 || warn "cmux is not on PATH; installing anyway, but opens will fail until it is"

info "Installing $SHIM_NAME → $TARGET"
mkdir -p "$BIN_DIR"
install -m 755 "$SCRIPT_DIR/$SHIM_NAME" "$TARGET"
ok "installed"

# The absolute path, not the bare name: the hub inherits its PATH from whichever shell spawned it,
# and that shell is not necessarily one of yours.
info "Pointing browser.opener at it"
livediff config set browser.opener "$TARGET"
ok "$(livediff config get browser.opener)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — livediff will still work, but the shim is easier to test if you add it" ;;
esac

printf '\n'
ok "Done. The next \`livediff .\` opens in your selected cmux workspace."
echo "  Undo with: livediff config unset browser.opener"
