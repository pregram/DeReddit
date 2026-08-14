/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL: string;
  readonly VITE_CORE_CONTRACT_ADDRESS: string;
  readonly VITE_ESCROW_CONTRACT_ADDRESS: string;
  readonly VITE_API_BASE_URL: string;
  readonly VITE_IPFS_API_URL: string;
  readonly VITE_IPFS_GATEWAY_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}