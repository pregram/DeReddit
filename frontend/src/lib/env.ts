function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Check frontend/.env`);
  }
  return value;
}

/**
 * Validated Vite env vars for the app. Reading this module throws immediately if any
 * required `VITE_*` var is missing, so a misconfigured build fails at import time instead
 * of surfacing as an undefined deep in an ethers/fetch call.
 */
export const env = {
  rpcUrl: required("VITE_RPC_URL", import.meta.env.VITE_RPC_URL),
  coreContractAddress: required("VITE_CORE_CONTRACT_ADDRESS", import.meta.env.VITE_CORE_CONTRACT_ADDRESS),
  escrowContractAddress: required("VITE_ESCROW_CONTRACT_ADDRESS", import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS),
  apiBaseUrl: required("VITE_API_BASE_URL", import.meta.env.VITE_API_BASE_URL),
  ipfsApiUrl: required("VITE_IPFS_API_URL", import.meta.env.VITE_IPFS_API_URL),
  ipfsGatewayUrl: required("VITE_IPFS_GATEWAY_URL", import.meta.env.VITE_IPFS_GATEWAY_URL),
};