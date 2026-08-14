#!/usr/bin/env bash
#
# run-public-sepolia.sh  (Script 2)
#
# Same as run-local-sepolia.sh, but additionally: exposes the backend API +
# IPFS through Cloudflare quick tunnels (so a phone, another machine, or the
# separately-hosted GitHub Pages frontend can reach them), and pushes the
# freshly assigned tunnel URLs into the GitHub repo below as Actions
# secrets, then triggers a redeploy so the *public* site picks them up.
#
# Why both a secret update AND a redeploy are required: VITE_* values are
# baked into the static JS bundle at BUILD time (npm run build) - they are
# NOT read at runtime by the published site. Updating the secret alone does
# nothing until the workflow rebuilds with it. This script does both.
#
# Edit these if you're pointing at a different repo/branch/workflow file:
GH_REPO="pregram/DeReddit"
GH_BRANCH="main"
GH_WORKFLOW="deploy-pages.yml"
GH_OWNER="${GH_REPO%%/*}"
GH_REPO_NAME="${GH_REPO##*/}"

# Data safety: same guarantees as run-local-sepolia.sh - never wipes the
# database or IPFS repo, never redeploys contracts. Also starts a local
# frontend dev server (http://localhost:5173) alongside the public one, for
# convenience while you're testing.

set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
source ./env-lib.sh
mkdir -p logs

cleanup() {
  kill "$INDEXER_PID" "$SERVER_PID" "$TUNNEL_API_PID" "$TUNNEL_GW_PID" "$TUNNEL_IPFSAPI_PID" "$FRONTEND_PID" 2>/dev/null
}
trap cleanup EXIT

persist_current_and_swap_env sepolia
ensure_postgres_container
ensure_database_exists
configure_ipfs_public_cors
ensure_ipfs_daemon

echo "=== Starting Backend Indexer & Server ==="
cd backend
./node_modules/.bin/tsx src/indexer.ts > ../logs/indexer.log 2>&1 &
INDEXER_PID=$!
./node_modules/.bin/tsx src/server.ts > ../logs/server.log 2>&1 &
SERVER_PID=$!
cd ..
sleep 3

echo "=== Opening Cloudflare quick tunnels ==="
cloudflared tunnel --url http://localhost:3001 > logs/tunnel-api.log 2>&1 &
TUNNEL_API_PID=$!
cloudflared tunnel --url http://localhost:8080 > logs/tunnel-ipfs-gateway.log 2>&1 &
TUNNEL_GW_PID=$!
cloudflared tunnel --url http://localhost:5001 > logs/tunnel-ipfs-api.log 2>&1 &
TUNNEL_IPFSAPI_PID=$!

# Quick tunnels need to register with Cloudflare's edge before printing a
# URL - poll instead of a fixed sleep so this doesn't wait longer than it
# has to (or get cut off too early on a slow connection).
echo "Waiting for tunnel URLs..."
TUNNEL_WAIT_MAX_SECS=45
API_URL="" GW_URL="" IPFSAPI_URL=""
for ((i = 0; i < TUNNEL_WAIT_MAX_SECS; i++)); do
  [[ -z "$API_URL" ]] && API_URL=$(grep -o 'https://[a-zA-Z0-9.-]*trycloudflare\.com' logs/tunnel-api.log | head -1)
  [[ -z "$GW_URL" ]] && GW_URL=$(grep -o 'https://[a-zA-Z0-9.-]*trycloudflare\.com' logs/tunnel-ipfs-gateway.log | head -1)
  [[ -z "$IPFSAPI_URL" ]] && IPFSAPI_URL=$(grep -o 'https://[a-zA-Z0-9.-]*trycloudflare\.com' logs/tunnel-ipfs-api.log | head -1)
  [[ -n "$API_URL" && -n "$GW_URL" && -n "$IPFSAPI_URL" ]] && break
  sleep 1
done

if [[ -z "$API_URL" || -z "$GW_URL" || -z "$IPFSAPI_URL" ]]; then
  echo "!! One or more tunnel URLs didn't come up within ${TUNNEL_WAIT_MAX_SECS}s - check logs/tunnel-*.log"
  exit 1
fi

echo "  API tunnel:          $API_URL"
echo "  IPFS gateway tunnel: $GW_URL"
echo "  IPFS API tunnel:     $IPFSAPI_URL"

echo "=== Patching frontend/.env with fresh tunnel URLs ==="
sed -i "s|^VITE_API_BASE_URL=.*|VITE_API_BASE_URL=${API_URL}|" frontend/.env
sed -i "s|^VITE_IPFS_API_URL=.*|VITE_IPFS_API_URL=${IPFSAPI_URL}|" frontend/.env
sed -i "s|^VITE_IPFS_GATEWAY_URL=.*|VITE_IPFS_GATEWAY_URL=${GW_URL}/ipfs/|" frontend/.env

echo "=== Starting local Frontend (optional - the public copy is on GitHub Pages) ==="
cd frontend
./node_modules/.bin/vite > ../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
cd ..

echo "=== Updating GitHub Pages secrets + triggering a redeploy ==="
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh secret set VITE_API_BASE_URL --repo "$GH_REPO" --body "$API_URL" \
    && gh secret set VITE_IPFS_API_URL --repo "$GH_REPO" --body "$IPFSAPI_URL" \
    && gh secret set VITE_IPFS_GATEWAY_URL --repo "$GH_REPO" --body "${GW_URL}/ipfs/" \
    && gh workflow run "$GH_WORKFLOW" --repo "$GH_REPO" --ref "$GH_BRANCH" \
    && echo "Redeploy triggered - check https://github.com/$GH_REPO/actions" \
    || echo "!! GitHub secret update / redeploy failed (see above) - local stack is still up regardless."
else
  echo "!! gh CLI not authenticated - skipping GitHub secret update + redeploy."
  echo "   Run manually once gh is set up:"
  echo "     gh secret set VITE_API_BASE_URL --repo $GH_REPO --body \"$API_URL\""
  echo "     gh secret set VITE_IPFS_API_URL --repo $GH_REPO --body \"$IPFSAPI_URL\""
  echo "     gh secret set VITE_IPFS_GATEWAY_URL --repo $GH_REPO --body \"${GW_URL}/ipfs/\""
  echo "     gh workflow run $GH_WORKFLOW --repo $GH_REPO --ref $GH_BRANCH"
fi

echo "=========================================="
echo " Public API:          $API_URL"
echo " Public IPFS gateway: $GW_URL"
echo " Public IPFS API:     $IPFSAPI_URL"
echo " Local frontend:      http://localhost:5173"
echo " Public frontend:     https://$GH_OWNER.github.io/$GH_REPO_NAME/"
echo ""
echo " NOTE: these tunnel URLs are ephemeral - re-running this script gets"
echo " new ones and re-publishes automatically, but the already-published"
echo " public site keeps pointing at the OLD urls until this script (or a"
echo " manual secret update + redeploy) runs again."
echo " Press CTRL+C to stop."
echo "=========================================="

# cleanup() (trapped on EXIT, set near the top) handles teardown here too -
# no separate INT trap needed.
wait
