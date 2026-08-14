// Shared up/down vote widget for both posts and comments. Renders a single
// net score (upvotes - downvotes) between the two arrows instead of two
// separate counters.

import { useEffect, useState } from "react";
import { Group, ActionIcon, Text, useMantineColorScheme } from "@mantine/core";
import { IconArrowBigUp, IconArrowBigDown, IconArrowBigUpFilled, IconArrowBigDownFilled } from "@tabler/icons-react";
import { useWallet } from "../context/WalletContext";
import { getCoreContract } from "../lib/contracts";
import { useTransactions } from "../context/TransactionContext";
import { darkModeInactiveIconColors } from "../theme";

interface VoteControlsProps {
  targetType: "post" | "comment";
  targetId: string;
  upvotes: number;
  downvotes: number;
  initialVoteState: -2 | -1 | 0 | 1;
  onError?: (message: string) => void;
}

export function VoteControls({ targetType, targetId, upvotes, downvotes, initialVoteState, onError }: VoteControlsProps) {
  const { signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();
  const { colorScheme } = useMantineColorScheme();
  const [localScore, setLocalScore] = useState(upvotes - downvotes);
  const [voteState, setVoteState] = useState<number>(initialVoteState);
  const [busy, setBusy] = useState(false);

  // Resync to the latest server-truth whenever the parent refetches -
  // otherwise a refetch triggered by an unrelated action (e.g. flagging,
  // commenting) leaves the score stuck at whatever it was on mount.
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setLocalScore(upvotes - downvotes);
    setVoteState(initialVoteState);
  }, [upvotes, downvotes, initialVoteState]);

  const isDownState = voteState === -1 || voteState === -2;

  const castVote = async (direction: 1 | -1) => {
    if (!requireWallet(`vote on this ${targetType}`) || !signer) return;
    const nextDirection: 1 | -1 | 0 =
      (direction === 1 && voteState === 1) || (direction === -1 && isDownState) ? 0 : direction;

    const contract = getCoreContract(signer);
    setBusy(true);
    try {
      await trackTransaction({
        description: `${nextDirection === 0 ? "Clear vote on" : nextDirection === 1 ? "Upvote" : "Downvote"} ${targetType}`,
        contract,
        send: () =>
          targetType === "post"
            ? contract.votePost(BigInt(targetId), nextDirection)
            : contract.voteComment(BigInt(targetId), nextDirection),
      });

      // -1 and -2 both count as "down" for tally purposes (mirrors
      // _calculateVoteDelta's karma-floor semantics: a swallowed downvote at
      // karma 0 still registers as a vote, only the karma decrement itself
      // is skipped).
      let delta = 0;
      if (voteState === 1) delta -= 1;
      if (isDownState) delta += 1;
      if (nextDirection === 1) delta += 1;
      if (nextDirection === -1) delta -= 1;
      setLocalScore((s) => s + delta);
      setVoteState(nextDirection);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Vote failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group gap={4}>
      <ActionIcon
        size="lg"
        variant={voteState === 1 ? "filled" : "subtle"}
        color="green"
        onClick={() => castVote(1)}
        loading={busy}
        aria-label={voteState === 1 ? "Remove upvote" : "Upvote"}
        aria-pressed={voteState === 1}
      >
        {voteState === 1 ? (
          <IconArrowBigUpFilled size={18} aria-hidden="true" />
        ) : (
          <IconArrowBigUp
            size={18}
            stroke={1.75}
            color={colorScheme === "dark" ? darkModeInactiveIconColors.upvote : undefined}
            aria-hidden="true"
          />
        )}
      </ActionIcon>
      <Text size="sm" fw={500} className="tabular-nums">{localScore}</Text>
      <ActionIcon
        size="lg"
        variant={isDownState ? "filled" : "subtle"}
        color="red"
        onClick={() => castVote(-1)}
        loading={busy}
        aria-label={isDownState ? "Remove downvote" : "Downvote"}
        aria-pressed={isDownState}
      >
        {isDownState ? (
          <IconArrowBigDownFilled size={18} aria-hidden="true" />
        ) : (
          <IconArrowBigDown
            size={18}
            stroke={1.75}
            color={colorScheme === "dark" ? darkModeInactiveIconColors.downvote : undefined}
            aria-hidden="true"
          />
        )}
      </ActionIcon>
    </Group>
  );
}