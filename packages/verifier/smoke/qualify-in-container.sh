#!/usr/bin/env bash
# Runs inside the `qualify` container (Node 22.18.0). Supported-runtime qualification for Gate A checkpoints.
set -uo pipefail
log=/out/qualify.log
: > "$log"
step() { echo "=== $*" | tee -a "$log"; "$@" 2>&1 | tee -a "$log"; return "${PIPESTATUS[0]}"; }
status=0
step node -v || status=1
echo "pnpm $(cat /app/.pnpm-version)" | tee -a "$log"
step pnpm exec tsc --noEmit -p packages/tsconfig.json || status=1
step pnpm exec vitest run tests/v3 || status=1
step pnpm exec vitest run --config vitest.v3-postgres.config.ts || status=1
echo "=== qualify exit $status" | tee -a "$log"
exit "$status"
