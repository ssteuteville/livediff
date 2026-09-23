#!/usr/bin/env bash
set -euo pipefail

# Source-development route: point browser.opener directly at this checkout's compiled helper.
# Deliberately independent of `livediff setup`/the npm persistent install (that path is
# `livediff setup --browser cmux`, in server/setup/browser.ts) — this script serves someone
# building livediff from source, before any persistent install exists.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/dist-server/server/cmux-open.js"

command -v livediff >/dev/null 2>&1 || {
  echo "livediff is not on PATH — run ./install.sh first" >&2
  exit 1
}
[ -f "$HELPER" ] || {
  echo "$HELPER does not exist — run \`pnpm build:server\` first" >&2
  exit 1
}

livediff config set browser.opener "$(command -v node)" "$HELPER"
echo "browser.opener set to: $(livediff config get browser.opener)"
