#!/usr/bin/env bash
set -euo pipefail

# Thin delegate onto the persistent CLI's own setup flow, which owns cmux configuration,
# staleness repair, and legacy-shim migration. See server/setup/browser.ts.

command -v livediff >/dev/null 2>&1 || {
  echo "livediff is not on PATH — run ./install.sh first" >&2
  exit 1
}

exec livediff setup --browser cmux
