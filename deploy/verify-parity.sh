#!/usr/bin/env bash
# One-command verification of the parity waves (W2/W4/W5).
#
# Runs the full chain: typecheck -> unit tests -> frontend build -> reset ->
# re-ingest -> container rebuild -> unfiltered drill sweep -> filtered drill
# sweep. Stops at the first failure so the earliest broken layer is the one
# reported, not a cascade.
#
# Usage:  bash deploy/verify-parity.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── [1/8] backend typecheck ──────────────────────────────────────"
npx tsc -p Backend/tsconfig.json --noEmit

echo "── [2/8] rules unit tests ───────────────────────────────────────"
npx vitest run 2>&1 | tail -4

echo "── [3/8] frontend build ─────────────────────────────────────────"
npm run build -w @pct/frontend 2>&1 | grep -E "error TS|✓ built"

echo "── [4/8] reset published dataset ────────────────────────────────"
docker exec pct-postgres psql -U pct -d pct -q \
  -c "DELETE FROM core.dataset_version;" \
  -c "DELETE FROM ingest.batch;" \
  -c "INSERT INTO core.dataset_pointer(id) VALUES (1) ON CONFLICT DO NOTHING;"

echo "── [5/8] re-ingest real exports ─────────────────────────────────"
npx tsx --env-file=Backend/.env Backend/src/cli/ingest.ts | grep -E "=== |Batch |CAVEAT|BLOCKER" || true

echo "── [6/8] rebuild + restart containers ───────────────────────────"
# compose build reports progress on STDERR; piping stdout to grep -c matches
# nothing, grep exits 1, and set -e killed the whole run. Let build speak for
# itself and rely on its exit code.
docker compose build api web 2>&1 | tail -2
docker compose up -d api web
sleep 14

echo "── [7/8] drill-parity sweep (unfiltered) ────────────────────────"
npx tsx Backend/src/cli/sweep.ts

echo "── [8/8] drill-parity sweep (filtered: plant + month) ───────────"
npx tsx Backend/src/cli/sweep.ts --filter "plant=EU71,EU73;monthKey=2026-03"

echo ""
echo "ALL PARITY CHECKS PASSED"
