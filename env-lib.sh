#!/usr/bin/env bash
#
# env-lib.sh - shared helpers sourced by run-local-sepolia.sh,
# run-public-sepolia.sh, and run-local-hardhat.sh. Not meant to be run
# directly (source it, don't execute it).
#
# Centralizes the trickiest, easiest-to-get-wrong pieces of the dev stack so
# they're only ever implemented in one place:
#
#   1. Swapping backend/.env + frontend/.env between modes without ever
#      losing data or silently reading the wrong mode's variables.
#   2. Bringing Postgres up and ensuring the right *logical* database
#      exists, without ever running `docker compose down -v` (which would
#      wipe EVERY mode's data, not just the one being switched away from).
#   3. Keeping the frontend's runtime-connectivity vars (VITE_API_BASE_URL,
#      VITE_IPFS_API_URL, VITE_IPFS_GATEWAY_URL) pointed at THIS machine's
#      own backend/IPFS daemon in every local-only mode, even though
#      run-public-sepolia.sh patches those same vars in the live
#      frontend/.env with ephemeral Cloudflare tunnel URLs and never resets
#      them - see force_local_connectivity_vars() below for why that matters.
#
# NOTE: the local-Hardhat persistence file is named .env.hardhat, NOT
# .env.local. Vite treats ".env.local" as a magic filename it auto-loads and
# layers on top of ".env" with HIGHER priority, in every mode, no matter
# what these scripts write into frontend/.env - so a real
# frontend/.env.local sitting around would silently keep overriding
# VITE_RPC_URL/contract addresses back to the local chain forever, even
# after switching to Sepolia. This bit this project once already - never
# reuse any of Vite's reserved names (.env.local, .env.<mode>.local) for
# anything other than an actual local Vite override.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Persists whichever env is currently live (backend/.env + frontend/.env)
# back into its own .env.<suffix> file - based on sniffing RPC_URL to tell
# local (127.0.0.1) apart from testnet - then copies the requested suffix's
# files in as the new live .env. Never deletes anything; only ever
# overwrites the two .env.<suffix> backup files and the two live .env files.
persist_current_and_swap_env() {
  local target_suffix="$1"

  if [[ -f "$ROOT_DIR/backend/.env" ]]; then
    local current_rpc
    current_rpc=$(grep -m1 '^RPC_URL=' "$ROOT_DIR/backend/.env" 2>/dev/null | cut -d= -f2-)
    if [[ "$current_rpc" == *127.0.0.1* ]]; then
      echo "Persisting current local .env -> .env.hardhat before switching"
      cp "$ROOT_DIR/backend/.env" "$ROOT_DIR/backend/.env.hardhat"
      cp "$ROOT_DIR/frontend/.env" "$ROOT_DIR/frontend/.env.hardhat"
    elif [[ -n "$current_rpc" ]]; then
      echo "Persisting current testnet .env -> .env.sepolia before switching"
      cp "$ROOT_DIR/backend/.env" "$ROOT_DIR/backend/.env.sepolia"
      cp "$ROOT_DIR/frontend/.env" "$ROOT_DIR/frontend/.env.sepolia"
    fi
  fi

  for f in "backend/.env.$target_suffix" "frontend/.env.$target_suffix"; do
    if [[ ! -f "$ROOT_DIR/$f" ]]; then
      echo "Missing $f - copy it from ${f}.example (or .env.example) and fill in real values first."
      exit 1
    fi
  done

  cp "$ROOT_DIR/backend/.env.$target_suffix" "$ROOT_DIR/backend/.env"
  cp "$ROOT_DIR/frontend/.env.$target_suffix" "$ROOT_DIR/frontend/.env"
  echo "=== Active env: $target_suffix ==="
}

# Force-overwrites just the frontend's runtime-connectivity vars (API +
# IPFS URLs) to this machine's own local endpoints, no matter what the
# just-swapped-in .env.<suffix> backup contained.
#
# Why this exists: local-sepolia and public-sepolia both run against the
# same live Sepolia contracts, so they share one backup file
# (frontend/.env.sepolia, chosen by sniffing RPC_URL - see
# persist_current_and_swap_env above). run-public-sepolia.sh patches the
# LIVE frontend/.env in place with freshly-minted Cloudflare tunnel URLs
# every time it starts, but those URLs die the moment that script's tunnels
# are killed, and nothing ever resets the live file back to local values
# before the process exits. The next persist_current_and_swap_env call (from
# either script) then dutifully backs up that still-tunnel-flavored live
# file into the SHARED frontend/.env.sepolia backup - so a later
# local-sepolia run silently inherits yesterday's dead tunnel URLs and the
# frontend can't reach the backend even though everything is running
# locally and correctly. Calling this right after persist_current_and_swap_env
# in every local-only mode makes that mode self-healing: it never trusts the
# backup for these three vars, only for RPC_URL/contract addresses (which
# ARE meant to be shared and don't drift the same way).
#
# Safe to call unconditionally: persist_current_and_swap_env has already
# archived whatever was live before this runs, so nothing is lost by
# overwriting these three lines in the now-live file.
force_local_connectivity_vars() {
  sed -i "s|^VITE_API_BASE_URL=.*|VITE_API_BASE_URL=http://localhost:3001|" "$ROOT_DIR/frontend/.env"
  sed -i "s|^VITE_IPFS_API_URL=.*|VITE_IPFS_API_URL=http://127.0.0.1:5001|" "$ROOT_DIR/frontend/.env"
  sed -i "s|^VITE_IPFS_GATEWAY_URL=.*|VITE_IPFS_GATEWAY_URL=http://127.0.0.1:8080/ipfs/|" "$ROOT_DIR/frontend/.env"
  echo "=== Forced frontend API/IPFS URLs to local endpoints (localhost:3001, 127.0.0.1:5001/8080) ==="
}

# Brings up the Postgres container if it isn't already running. NEVER -v.
ensure_postgres_container() {
  if docker ps --format '{{.Names}}' | grep -qx dereddit-postgres; then
    echo "=== Docker PostgreSQL already running - leaving the container as-is ==="
  else
    echo "=== Starting Docker PostgreSQL (no -v: existing data is preserved) ==="
    (cd "$ROOT_DIR/backend" && docker compose up -d)
  fi

  echo "=== Waiting for Postgres to accept connections ==="
  for i in $(seq 1 30); do
    docker exec dereddit-postgres pg_isready -U dereddit > /dev/null 2>&1 && break
    sleep 1
  done
}

# Creates the logical database named by backend/.env's current POSTGRES_DB,
# if it doesn't already exist. Only ever creates - never drops.
ensure_database_exists() {
  local pg_user pg_db
  pg_user=$(grep -m1 '^POSTGRES_USER=' "$ROOT_DIR/backend/.env" | cut -d= -f2-)
  pg_db=$(grep -m1 '^POSTGRES_DB=' "$ROOT_DIR/backend/.env" | cut -d= -f2-)
  if ! docker exec dereddit-postgres psql -U "$pg_user" -d postgres -tc \
      "SELECT 1 FROM pg_database WHERE datname = '$pg_db'" | grep -q 1; then
    echo "Database '$pg_db' doesn't exist yet - creating it (does not touch any other database)."
    docker exec dereddit-postgres createdb -U "$pg_user" "$pg_db"
    docker exec -i dereddit-postgres psql -U "$pg_user" -d "$pg_db" < "$ROOT_DIR/backend/init.sql" > /dev/null
  fi
}

# Drops + recreates ONE specific logical database by name and reapplies the
# schema. Used only by run-local-hardhat.sh, and only ever called with
# "dereddit_local" - never call this with the Sepolia database's name
# ("dereddit"), since that would destroy indexed Sepolia history.
recreate_database() {
  local db_name="$1"
  local pg_user
  pg_user=$(grep -m1 '^POSTGRES_USER=' "$ROOT_DIR/backend/.env" | cut -d= -f2-)
  echo "=== Resetting local database '$db_name' for a fresh Hardhat chain ==="
  docker exec dereddit-postgres dropdb -U "$pg_user" --if-exists "$db_name"
  docker exec dereddit-postgres createdb -U "$pg_user" "$db_name"
  docker exec -i dereddit-postgres psql -U "$pg_user" -d "$db_name" < "$ROOT_DIR/backend/init.sql" > /dev/null
}

ensure_ipfs_daemon() {
  if ! pgrep -x "ipfs" > /dev/null; then
    ipfs daemon > "$ROOT_DIR/logs/ipfs.log" 2>&1 &
    sleep 3
  else
    echo "IPFS daemon is already running."
  fi
}

# Only needed when IPFS is being exposed through a public Cloudflare tunnel.
configure_ipfs_public_cors() {
  ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]' >/dev/null
  ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT","POST","GET"]' >/dev/null
}
