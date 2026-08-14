#!/usr/bin/env bash
#
# run-local-sepolia.sh  (Script 1)
#
# Fully local dev stack (frontend, backend indexer + API, IPFS) pointed at
# the already-deployed Sepolia contracts - no Cloudflare tunnels, nothing
# public. Good for working on the app against real testnet data without
# exposing anything to the internet.
#
# Data safety: NEVER wipes the database or the IPFS repo. Uses the
# 'dereddit' logical database (shared with run-public-sepolia.sh - both
# point at the same Sepolia chain) inside the same long-lived Postgres
# container/volume as every other mode; switching modes never deletes
# another mode's data. NEVER deploys contracts - Sepolia's are already live.

set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
source ./env-lib.sh
mkdir -p logs

cleanup() {
  kill "$INDEXER_PID" "$SERVER_PID" "$FRONTEND_PID" 2>/dev/null
}
trap cleanup EXIT

persist_current_and_swap_env sepolia
force_local_connectivity_vars
ensure_postgres_container
ensure_database_exists
ensure_ipfs_daemon

echo "=== Starting Backend Indexer & Server ==="
cd backend
./node_modules/.bin/tsx src/indexer.ts > ../logs/indexer.log 2>&1 &
INDEXER_PID=$!
./node_modules/.bin/tsx src/server.ts > ../logs/server.log 2>&1 &
SERVER_PID=$!
cd ..

echo "=== Starting Frontend ==="
cd frontend
./node_modules/.bin/vite > ../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
cd ..

echo "=========================================="
echo " Local + Sepolia. Frontend: http://localhost:5173"
echo " Logs in ./logs/*.log - tail -f logs/indexer.log (etc.)"
echo " Press CTRL+C to stop."
echo "=========================================="

# cleanup() (trapped on EXIT, set near the top) handles teardown here too -
# no separate INT trap needed.
wait
