#!/usr/bin/env bash
#
# run-local-hardhat.sh  (Script 3)
#
# Fully local dev stack including its own local Hardhat chain - frontend,
# backend indexer + API, IPFS, Postgres, everything. No Cloudflare tunnels,
# no Sepolia traffic at all.
#
# Data: uses the 'dereddit_local' logical database, completely separate
# from the 'dereddit' database the two Sepolia-mode scripts use (same
# Postgres container, different database - see env-lib.sh). Since a fresh
# `hardhat node` has no chain history on every start, this script resets
# ONLY 'dereddit_local' (never 'dereddit') on every run, so the indexed
# data always matches the fresh chain instead of accumulating stale rows
# from long-dead local chains. The IPFS repo itself is never wiped - IPFS
# content is addressed by hash, so old Sepolia-mode data already pinned
# there is completely unaffected by anything this script does.
#
# Deploys contracts fresh to the local chain on every run (Sepolia's
# contracts are never touched by this script).

set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
source ./env-lib.sh
mkdir -p logs

cleanup() {
  kill "$HARDHAT_PID" "$INDEXER_PID" "$SERVER_PID" "$FRONTEND_PID" 2>/dev/null
}
trap cleanup EXIT

persist_current_and_swap_env hardhat
force_local_connectivity_vars
ensure_postgres_container
recreate_database dereddit_local
ensure_ipfs_daemon

echo "=== Starting Hardhat local chain ==="
# Invoking the binary directly (not `npx hardhat ...`) so $! captures the
# actual node process - npm/npx wrap the command in an intermediate shell
# that doesn't reliably forward SIGTERM to its child, silently orphaning
# the real process on `kill $PID`.
./node_modules/.bin/hardhat node > logs/hardhat.log 2>&1 &
HARDHAT_PID=$!
sleep 5

echo "=== Deploying contracts to localhost ==="
./node_modules/.bin/hardhat run scripts/deploy.ts --network localhost | tee logs/deploy.log

# deploy.ts just wrote fresh addresses into the live backend/.env +
# frontend/.env - persist those into .env.hardhat so they're not lost the
# next time this script (or persist_current_and_swap_env) runs.
cp backend/.env backend/.env.hardhat
cp frontend/.env frontend/.env.hardhat

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
echo " Fully local (Hardhat). Frontend: http://localhost:5173"
echo " Logs in ./logs/*.log - tail -f logs/hardhat.log (etc.)"
echo " Press CTRL+C to stop."
echo "=========================================="

# cleanup() (trapped on EXIT, set near the top) handles teardown here too -
# no separate INT trap needed.
wait
