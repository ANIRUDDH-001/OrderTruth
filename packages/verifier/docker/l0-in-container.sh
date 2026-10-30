#!/usr/bin/env bash
# Gate A rung L0 (plan Task 10): runs inside the read-only `l0` container on Node 22.18.0. Writable: /tmp (including the XDG
# data home vitest uses for its API token) and the vitest cache only.
# Local binaries are called directly (what `pnpm exec` resolves to), so pnpm needs no writable home.
# Prints one line per step, "L0 <step> <exit status>", so the controller can record each as trusted output.
set -u
echo "L0 node $(node -v)"
./node_modules/.bin/tsc --noEmit -p packages/tsconfig.json > /tmp/tsc.log 2>&1; echo "L0 packages_typecheck $?"
./node_modules/.bin/vitest run tests/v3 --configLoader runner > /tmp/vitest.log 2>&1; echo "L0 offline_tests $?"
tail -n 5 /tmp/tsc.log | sed 's/^/L0-tsc: /'
if grep -qE "Tests +[0-9]" /tmp/vitest.log; then grep -E "Tests|Test Files" /tmp/vitest.log | sed 's/^/L0-vitest: /'; else tail -n 15 /tmp/vitest.log | sed 's/^/L0-vitest: /'; fi
