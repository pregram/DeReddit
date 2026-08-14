import { defineConfig, devices } from "@playwright/test";

// E2E journeys mock both the wallet (fake EIP-1193 provider, see
// e2e/mockWallet.ts) and the backend API (route interception per-test), so
// this only needs the Vite dev server up - no Hardhat node / Postgres /
// IPFS daemon required, unlike the full start-dev.sh stack. That trades
// true full-stack integration for deterministic, fast CI runs.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 5173",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_RPC_URL: "http://127.0.0.1:8545",
      VITE_CORE_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      VITE_ESCROW_CONTRACT_ADDRESS: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      VITE_API_BASE_URL: "http://127.0.0.1:3001",
      VITE_IPFS_API_URL: "http://127.0.0.1:5001",
      VITE_IPFS_GATEWAY_URL: "http://127.0.0.1:8080/ipfs/",
    },
  },
});
