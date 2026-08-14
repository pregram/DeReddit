// src/lib/usePostSetup.ts - Shared Step 2 contract-call logic for Poll
// (configurePoll) and Crowdfund (launchCrowdfund) posts. Used by both
// CreatePostPage's focused post-Step-1 setup modal and PostDetailPage's
// persistent "finish setup" retry banner, so the actual on-chain call
// logic lives in exactly one place regardless of which UI triggers it.

import { useState } from "react";
import { useWallet } from "../context/WalletContext";
import { getCoreContract, getEscrowContract } from "./contracts";
import { useTransactions } from "../context/TransactionContext";
import { bytes32ToIpfsCid } from "./hash";
import { fetchJsonFromIPFS } from "./ipfs";
import { notifyError, isAlreadyNotified } from "./notify";

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Step 2 setup calls for Poll/Crowdfund posts (`configurePoll` / `launchCrowdfund`).
 * @param postId - on-chain post ID (string form of the uint256).
 * @returns `completePollSetup`, `completeCrowdfundSetup`, and a shared `busy` flag for disabling submit buttons mid-transaction.
 */
export function usePostSetup(postId: string) {
  const { signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();
  const [busy, setBusy] = useState(false);

  const completePollSetup = async (days: number, postIpfsCidBytes32: string): Promise<boolean> => {
    if (!requireWallet("finish setting up this poll") || !signer) return false;
    const contract = getCoreContract(signer);
    setBusy(true);
    try {
      const cid = bytes32ToIpfsCid(postIpfsCidBytes32);
      const metadata = await fetchJsonFromIPFS<{ pollChoices?: string[] }>(cid);
      const optionCount = metadata.pollChoices?.length ?? 0;
      if (optionCount < 2) {
        throw new Error("Could not read at least 2 poll options from this post's IPFS content.");
      }
      await trackTransaction({
        description: "Complete poll setup",
        contract,
        send: () => contract.configurePoll(BigInt(postId), optionCount, days * DAY_SECONDS),
      });
      return true;
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Poll setup failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const completeCrowdfundSetup = async (goalEth: number, days: number): Promise<boolean> => {
    if (!requireWallet("launch this crowdfund") || !signer) return false;
    if (goalEth <= 0) {
      notifyError("Goal must be greater than 0.");
      return false;
    }
    const contract = getEscrowContract(signer);
    setBusy(true);
    try {
      const goalWei = BigInt(Math.round(goalEth * 1e18));
      await trackTransaction({
        description: "Launch crowdfund campaign",
        contract,
        send: () => contract.launchCrowdfund(BigInt(postId), goalWei, days * DAY_SECONDS),
      });
      return true;
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Crowdfund launch failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { completePollSetup, completeCrowdfundSetup, busy };
}
