// Plain getCoreContract()/getEscrowContract() construct a brand-new Contract
// object every call - fine inside an event handler, but calling one directly
// inside a useEffect/useMemo body makes the new reference an unstable
// dependency that can retrigger that effect every render (the "eth_call
// repeated 18+ times" bug this was added to fix). The hooks below give a
// stable reference tied only to `signer` changing.

import { useMemo } from "react";
import { Contract, type JsonRpcSigner } from "ethers";
import { CORE_ABI, ESCROW_ABI } from "./abi";
import { env } from "./env";

/** Constructs a new signer-bound Core contract instance on every call - use `useCoreContract` inside components/effects instead. */
export function getCoreContract(signer: JsonRpcSigner): Contract {
  return new Contract(env.coreContractAddress, CORE_ABI, signer);
}

/** Constructs a new signer-bound Escrow contract instance on every call - use `useEscrowContract` inside components/effects instead. */
export function getEscrowContract(signer: JsonRpcSigner): Contract {
  return new Contract(env.escrowContractAddress, ESCROW_ABI, signer);
}

/** Stable, memoized core contract instance - safe to put in a useEffect dependency array. */
export function useCoreContract(signer: JsonRpcSigner | null): Contract | null {
  return useMemo(() => (signer ? getCoreContract(signer) : null), [signer]);
}

/** Stable, memoized escrow contract instance - safe to put in a useEffect dependency array. */
export function useEscrowContract(signer: JsonRpcSigner | null): Contract | null {
  return useMemo(() => (signer ? getEscrowContract(signer) : null), [signer]);
}