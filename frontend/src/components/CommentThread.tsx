// Recursive comment renderer, up to MAX_TIER tiers deep.
//
// `onCommentAdded` is expected to already include the indexer-catchup wait
// itself (PostDetailPage passes `refreshAfterIndexerCatchup`, which waits
// ~3s before refetching) - this component just calls the callback after a
// successful reply/flag, it doesn't need its own delay logic.

import { useEffect, useState } from "react";
import { Stack, Group, Text, Button, Textarea, Paper, ActionIcon, useMantineColorScheme } from "@mantine/core";
import { IconFlag, IconMessageCircle, IconDotsVertical } from "@tabler/icons-react";
import type { CommentSummary } from "../lib/api";
import { AuthorLink } from "./AuthorLink";
import { VoteControls } from "./VoteControls";
import { TipButton } from "./TipButton";
import { TipTotal } from "./TipTotal";
import { CollapsedFlagged } from "./CollapsedFlagged";
import { ReadMore } from "./ReadMore";
import { MerkleAuditModal } from "./MerkleAuditModal";
import { formatDate } from "../lib/format";
import { useWallet } from "../context/WalletContext";
import { useFlagTolerance } from "../lib/flagTolerance";
import { uploadJsonToIPFS } from "../lib/ipfs";
import { ipfsCidToBytes32 } from "../lib/hash";
import { getCoreContract } from "../lib/contracts";
import { useTransactions } from "../context/TransactionContext";
import { notifyError, isAlreadyNotified } from "../lib/notify";
import { darkModeInactiveIconColors } from "../theme";

const MAX_TIER = 3;

interface CommentThreadProps {
  comments: CommentSummary[];
  postId: string;
  isMember: boolean;
  karma: number;
  minKarmaToFlag: number;
  onCommentAdded: () => void | Promise<void>;
}

function buildTree(comments: CommentSummary[]): Map<string | null, CommentSummary[]> {
  const byParent = new Map<string | null, CommentSummary[]>();
  for (const c of comments) {
    const key = c.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  return byParent;
}

export function CommentThread({ comments, postId, isMember, karma, minKarmaToFlag, onCommentAdded }: CommentThreadProps) {
  const byParent = buildTree(comments);
  const roots = byParent.get(null) ?? [];

  return (
    <Stack gap="md">
      {roots.length === 0 ? (
        <Text c="dimmed" size="sm">No comments yet.</Text>
      ) : (
        roots.map((c) => (
          <CommentNode
            key={c.comment_id}
            comment={c}
            byParent={byParent}
            postId={postId}
            isMember={isMember}
            karma={karma}
            minKarmaToFlag={minKarmaToFlag}
            onCommentAdded={onCommentAdded}
          />
        ))
      )}
    </Stack>
  );
}

function CommentNode({
  comment, byParent, postId, isMember, karma, minKarmaToFlag, onCommentAdded,
}: {
  comment: CommentSummary;
  byParent: Map<string | null, CommentSummary[]>;
  postId: string;
  isMember: boolean;
  karma: number;
  minKarmaToFlag: number;
  onCommentAdded: () => void | Promise<void>;
}) {
  const { signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();
  const { colorScheme } = useMantineColorScheme();
  const [userTally] = useFlagTolerance();
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flagging, setFlagging] = useState(false);
  // Tip/Flag/Audit collapse behind this toggle so the default row only
  // shows vote + reply - the primary actions - instead of every control at
  // once (was up to 6 competing buttons per comment).
  const [moreOpen, setMoreOpen] = useState(false);
  // Local override so the audit modal's onCorrected can swap in the real IPFS
  // body when it differs from the DB's cached copy - CommentThread doesn't
  // own the comments array (PostDetailPage does), so this can't be done by
  // updating a shared list item.
  const [displayBody, setDisplayBody] = useState(comment.body);
  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => setDisplayBody(comment.body), [comment.body]);

  const children = byParent.get(comment.comment_id) ?? [];
  const canReply = comment.tier < MAX_TIER;
  const canFlag = isMember && karma >= minKarmaToFlag;

  const submitReply = async () => {
    if (!replyBody.trim()) return;
    if (!requireWallet("post a reply") || !signer) return;
    const contract = getCoreContract(signer);
    setSubmitting(true);
    try {
      const cid = await uploadJsonToIPFS({ body: replyBody.trim() });
      const ipfsCidBytes32 = ipfsCidToBytes32(cid);
      await trackTransaction({
        description: "Post reply",
        contract,
        send: () => contract.createComment(BigInt(postId), BigInt(comment.comment_id), ipfsCidBytes32),
      });
      setReplyBody("");
      setReplying(false);
      await onCommentAdded();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Reply failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitFlag = async () => {
    if (!requireWallet("flag this comment") || !signer) return;
    const contract = getCoreContract(signer);
    setFlagging(true);
    try {
      await trackTransaction({
        description: "Flag comment",
        contract,
        send: () => contract.flagComment(BigInt(postId), BigInt(comment.comment_id)),
      });
      await onCommentAdded();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Flag failed.");
    } finally {
      setFlagging(false);
    }
  };

  return (
    <Paper
      pl={comment.tier > 1 ? "md" : 0}
      style={{ borderLeft: comment.tier > 1 ? "2px solid var(--app-border)" : "none" }}
    >
      <CollapsedFlagged flagTally={comment.flag_tally} userTally={userTally}>
        <Stack gap={4}>
          <Group gap="xs">
            <AuthorLink wallet={comment.author_wallet} username={comment.author_username} profileCid={comment.author_profile_cid} size={16} />
            <Text size="xs" c="dimmed">• {formatDate(comment.created_at)}</Text>
          </Group>
          {displayBody && <ReadMore text={displayBody} threshold={500} maxHeight={100} size="sm" />}
          <Group gap="xs" wrap="wrap">
            <VoteControls
              targetType="comment"
              targetId={comment.comment_id}
              upvotes={comment.upvotes}
              downvotes={comment.downvotes}
              initialVoteState={comment.user_vote as -2 | -1 | 0 | 1}
            />
            {canReply && isMember && (
              <Button size="sm" variant="subtle" leftSection={<IconMessageCircle size={14} stroke={1.75} aria-hidden="true" />} onClick={() => setReplying((r) => !r)}>
                Reply
              </Button>
            )}
            {!canReply && <Text size="xs" c="dimmed">Max depth reached</Text>}
            <TipTotal userTippedWei={comment.user_tipped_wei} />
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={() => setMoreOpen((o) => !o)}
              aria-label={moreOpen ? "Hide more actions" : "Show more actions (tip, flag, audit)"}
              aria-expanded={moreOpen}
            >
              <IconDotsVertical size={16} stroke={1.75} aria-hidden="true" />
            </ActionIcon>
          </Group>

          {moreOpen && (
            <Group gap="xs" wrap="wrap">
              <TipButton
                target={{ type: "comment", commentId: comment.comment_id }}
                recipientWallet={comment.author_wallet}
                recipientUsername={comment.author_username}
                recipientProfileCid={comment.author_profile_cid}
              />
              <Button
                size="sm"
                variant={comment.user_flagged ? "filled" : "subtle"}
                color="orange"
                leftSection={
                  <IconFlag
                    size={14}
                    stroke={1.75}
                    color={!comment.user_flagged && colorScheme === "dark" ? darkModeInactiveIconColors.flag : undefined}
                    aria-hidden="true"
                  />
                }
                onClick={submitFlag}
                loading={flagging}
                disabled={comment.user_flagged || !canFlag}
                title={
                  comment.user_flagged ? "You've already flagged this" :
                  !isMember ? "Join this forum to flag" :
                  !canFlag ? `Requires ${minKarmaToFlag} karma` : undefined
                }
              >
                Flag ({comment.flag_tally})
              </Button>
              <MerkleAuditModal
                entityType="comment"
                entityId={comment.comment_id}
                cachedContent={{ body: comment.body }}
                onCorrected={(content) => setDisplayBody((content.body as string | null) ?? null)}
              />
            </Group>
          )}

          {replying && (
            <Stack gap={4} mt={4}>
              <Textarea
                aria-label="Write a reply"
                placeholder="Write a reply…"
                value={replyBody}
                onChange={(e) => setReplyBody(e.currentTarget.value)}
                minRows={2}
              />
              <Group gap="xs">
                <Button size="xs" onClick={submitReply} loading={submitting}>Post Reply</Button>
                <Button size="xs" variant="subtle" onClick={() => setReplying(false)}>Cancel</Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </CollapsedFlagged>

      {children.length > 0 && (
        <Stack gap="sm" mt="sm">
          {children.map((child) => (
            <CommentNode
              key={child.comment_id}
              comment={child}
              byParent={byParent}
              postId={postId}
              isMember={isMember}
              karma={karma}
              minKarmaToFlag={minKarmaToFlag}
              onCommentAdded={onCommentAdded}
            />
          ))}
        </Stack>
      )}
    </Paper>
  );
}