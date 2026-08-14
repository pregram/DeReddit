import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: ["**/node_modules/**", "**/e2e/**"],
    setupFiles: ["./src/test/setup.ts"],
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
