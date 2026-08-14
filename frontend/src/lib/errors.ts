// src/lib/errors.ts - Decodes DeRedditCore/DeRedditEscrow custom errors into
// human-readable messages. Ethers v6 attaches parsed revert data to
// `error.data` on a CallExceptionError; we re-run it through the contract's
// own Interface to recover the error name.

import { Interface, type Contract } from "ethers";

const ERROR_MESSAGES: Record<string, string> = {
  AlreadyRegistered: "This wallet already has a username registered.",
  UsernameTaken: "That username is already taken.",
  InvalidUsername: "Username cannot be empty.",
  ForumAlreadyExists: "A forum with this exact name already exists on-chain.",
  ForumNotFound: "This forum doesn't exist on-chain (yet - the indexer may still be catching up).",
  InvalidHandle: "Forum name cannot be empty.",
  AlreadyMember: "You're already a member of this forum.",
  NotMember: "You need to join this forum first.",
  PostNotFound: "This post doesn't exist on-chain.",
  CommentNotFound: "This comment doesn't exist on-chain.",
  TimeCapsuleLocked: "This content is still locked (time capsule hasn't opened yet).",
  NotPostAuthor: "Only the original author can do this.",
  DepthExceeded: "Comments can only be nested 3 levels deep.",
  InvalidTimeCapsule: "Only Time Capsule posts can have a duration set.",
  CommentPostMismatch: "This comment doesn't belong to this post.",
  InvalidDirection: "Invalid vote direction.",
  SameVote: "You've already cast this exact vote.",
  CannotVoteOwnContent: "You can't vote on your own posts or comments.",
  FlaggingNotActive: "Your karma is below this forum's flagging threshold.",
  AlreadyFlagged: "You've already flagged this.",
  NotPoll: "This post isn't a poll.",
  PollNotConfigured: "This poll hasn't been configured yet - try again in a moment.",
  PollAlreadyConfigured: "This poll has already been configured.",
  PollOptionOutOfRange: "Invalid poll option selected.",
  SameVotePoll: "You already voted for this option.",
  PollExpired: "Voting has closed for this poll.",
  NotCrowdfund: "This post isn't a crowdfund.",
  CrowdfundAlreadyLaunched: "This crowdfund has already been launched.",
  NotCampaignCreator: "Only the campaign creator can claim payout.",
  CampaignStillActive: "This campaign hasn't reached its deadline yet.",
  CampaignEnded: "This campaign's funding window has closed.",
  GoalNotReached: "The funding goal wasn't reached - payout can't be claimed.",
  GoalAlreadyReached: "The goal was reached - refunds aren't available.",
  AlreadyClaimed: "The payout has already been claimed.",
  NothingToRefund: "You have no contribution to refund.",
  InvalidGoal: "The funding goal must be greater than zero.",
  InvalidDuration: "Duration must be greater than zero.",
  InvalidAmount: "Amount must be greater than zero.",
  TransferFailed: "The ETH transfer failed - the recipient may be a contract rejecting payment.",
  ZeroAddress: "Invalid (zero) address.",
  Unauthorized: "You're not authorized to perform this action.",
  Reentrancy: "Transaction blocked (reentrancy guard). Please try again.",
};

/**
 * Extracts a human-readable message from a thrown ethers CallExceptionError.
 * Falls back to ethers' own message, then a generic string, if the error
 * can't be decoded (e.g. user rejected the signature, or an RPC-level error).
 */
export function decodeContractError(err: unknown, contract: Contract): string {
  const anyErr = err as { code?: string; reason?: string; data?: string; shortMessage?: string; message?: string };

  if (anyErr?.code === "ACTION_REJECTED") {
    return "Transaction was rejected in your wallet.";
  }

  const errorName =
    anyErr?.reason ??
    (anyErr?.data ? safeParseErrorName(contract.interface, anyErr.data) : undefined);

  if (errorName && ERROR_MESSAGES[errorName]) {
    return ERROR_MESSAGES[errorName];
  }

  return anyErr?.shortMessage ?? anyErr?.message ?? "Transaction failed for an unknown reason.";
}

function safeParseErrorName(iface: Interface, data: string): string | undefined {
  try {
    return iface.parseError(data)?.name;
  } catch {
    return undefined;
  }
}