// Wallet-independent provider/contracts, so read-only checks work for a
// visitor who hasn't connected MetaMask yet.

import { JsonRpcProvider, Contract } from "ethers";
import { CORE_ABI, ESCROW_ABI } from "./abi";
import { env } from "./env";

export const readProvider = new JsonRpcProvider(env.rpcUrl);
// Local Hardhat chains mine instantly on tx submission, so the only lag
// before a live listener (e.g. the tip-received toast) notices is this
// poll cycle - shorten it from ethers' 4000ms default.
readProvider.pollingInterval = 1500;
export const coreContractReadOnly = new Contract(env.coreContractAddress, CORE_ABI, readProvider);
export const escrowContractReadOnly = new Contract(env.escrowContractAddress, ESCROW_ABI, readProvider);