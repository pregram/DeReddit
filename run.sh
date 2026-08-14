#!/usr/bin/env bash
#
# run.sh <local-sepolia|public-sepolia|local-hardhat>
#
# Single entry point for the three dev-stack modes below. Just execs the
# matching script - see each one's own header comment for exactly what it
# does and what data-safety guarantees it makes.
#
#   local-sepolia   -> run-local-sepolia.sh   (fully local, real Sepolia data, nothing public)
#   public-sepolia  -> run-public-sepolia.sh  (adds Cloudflare tunnels + updates/redeploys the GitHub Pages site)
#   local-hardhat   -> run-local-hardhat.sh   (fully local, own throwaway local chain + local-only database)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$1" in
  local-sepolia)
    exec "$ROOT_DIR/run-local-sepolia.sh"
    ;;
  public-sepolia)
    exec "$ROOT_DIR/run-public-sepolia.sh"
    ;;
  local-hardhat)
    exec "$ROOT_DIR/run-local-hardhat.sh"
    ;;
  *)
    echo "Usage: $0 <local-sepolia|public-sepolia|local-hardhat>"
    echo
    echo "  local-sepolia   - fully local stack against real Sepolia contracts, nothing public"
    echo "  public-sepolia  - same, plus Cloudflare tunnels + auto-updates the GitHub Pages deploy"
    echo "  local-hardhat   - fully local stack with its own throwaway local chain + database"
    exit 1
    ;;
esac
