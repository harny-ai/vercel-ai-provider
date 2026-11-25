#!/usr/bin/env bash
# CI for @harny/vercel-ai-provider.
#
#   bash scripts/ci.sh            install the exact pinned versions (npm ci), build, type-check, test
#   bash scripts/ci.sh --latest   the same, then also try the newest `ai` and `@ai-sdk/provider` in a throwaway copy
#
# The pinned run decides this script's exit code. The --latest run is early warning: its result is printed on its own
# line ("LATEST: PASS|FAIL") and never changes the exit code. No network is used by the tests; `npm ci` needs the registry.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
PKG_DIR="$(pwd)"

# Development needs Node 20.19 or newer (the test runner's requirement). Use an nvm-installed one when the default is older.
node_ok() { node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)'; }
if ! node_ok 2>/dev/null; then
  for candidate in $(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v2[0-9].*/bin 2>/dev/null | sort -V -r); do
    if PATH="$candidate:$PATH" node_ok 2>/dev/null; then PATH="$candidate:$PATH"; break; fi
  done
fi
node_ok 2>/dev/null || { echo "CI: Node 20.19 or newer is required (found $(node -v 2>/dev/null || echo none))." >&2; exit 2; }
echo "CI: node $(node -v), npm $(npm -v)"

run_checks() {
  npm run build
  npm run typecheck
  npm test
}

echo "CI: pinned run (npm ci)"
npm ci --no-audit --no-fund
echo "CI: ai $(node -p "require('./node_modules/ai/package.json').version"), @ai-sdk/provider $(node -p "require('./node_modules/@ai-sdk/provider/package.json').version")"
run_checks
echo "PINNED: PASS"

if [[ "${1:-}" == "--latest" ]]; then
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/harny-vercel-ai-latest.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT
  tar --exclude=node_modules --exclude=dist -cf - . | tar -xf - -C "$TMP"
  set +e
  (
    set -e
    cd "$TMP"
    npm install --no-audit --no-fund --no-package-lock
    npm install --no-audit --no-fund --no-package-lock --no-save ai@latest @ai-sdk/provider@latest
    echo "CI: latest ai $(node -p "require('./node_modules/ai/package.json').version"), @ai-sdk/provider $(node -p "require('./node_modules/@ai-sdk/provider/package.json').version")"
    run_checks
  )
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then echo "LATEST: PASS"; else echo "LATEST: FAIL (exit $status) - informational; the pinned run passed"; fi
fi
cd "$PKG_DIR"
