// Action handlers wait out the indexer's poll interval before refetching
// (see refreshAfterIndexerCatchup below) so the reload doesn't race the
// indexer and show stale data right after a transaction confirms.
// loadAll's effect guards against setState after unmount via a `cancelled`
// flag, matching the pattern used in ForumHubPage/ForumDiscoveryPage.

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Stack, Title, Text, Group, Badge, Button, Paper, Loader, Alert,
  Progress, Radio, Textarea, Divider, NumberInput, Popover, Grid,
  useMantineColorScheme, Modal, Image, SimpleGrid,
} from "@mantine/core";
import {
  IconArrowLeft, IconHourglass, IconFlag, IconRocket, IconCash,
  IconCoins, IconHeart, IconShieldCheck, IconBolt, IconAlertTriangle,
} from "@tabler/icons-react";
import { api, type PostDetail, type PollOption, type CommentSummary } from "../lib/api";
import { useWallet } from "../context/WalletContext";
import { getCoreContract, getEscrowContract } from "../lib/contracts";
import { ipfsCidToBytes32 } from "../lib/hash";
import { uploadJsonToIPFS, ipfsGatewayUrl } from "../lib/ipfs";
import { AuthorLink } from "../components/AuthorLink";
import { VoteControls } from "../components/VoteControls";
import { TipButton } from "../components/TipButton";
import { TipTotal } from "../components/TipTotal";
import { CollapsedFlagged } from "../components/CollapsedFlagged";
import { ReadMore } from "../components/ReadMore";
import { CommentThread } from "../components/CommentThread";
import { MerkleAuditModal } from "../components/MerkleAuditModal";
import { PollSetupForm } from "../components/PollSetupForm";
import { CrowdfundSetupForm } from "../components/CrowdfundSetupForm";
import { useFlagTolerance } from "../lib/flagTolerance";
import { darkModeInactiveIconColors } from "../theme";
import { formatDate, weiToEth } from "../lib/format";
import { useTransactions } from "../context/TransactionContext";
import { usePostSetup } from "../lib/usePostSetup";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { notifyError, isAlreadyNotified } from "../lib/notify";

// Mirrors the indexer's own sync-loop poll interval (see backend/src/indexer.ts
// startSyncLoop's 3000ms wait) - a fixed, generous buffer so a refetch right
// after on-chain confirmation doesn't race the indexer's own catch-up.
const INDEXER_CATCHUP_MS = 3000;
// Root (tier-1) comments per page - replies/sub-replies always come back
// in full alongside their root, regardless of this number.
const COMMENTS_PAGE_SIZE = 20;

export function PostDetailPage() {
  const { forumKey = "", postId = "" } = useParams();
  const { address, signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();
  const { colorScheme } = useMantineColorScheme();
  const [userTally] = useFlagTolerance();

  const [post, setPost] = useState<PostDetail | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [failedMediaCids, setFailedMediaCids] = useState<Set<string>>(new Set());
  const [pollOptions, setPollOptions] = useState<PollOption[]>([]);
  const [userPollOption, setUserPollOption] = useState<number | null>(null);
  const [userContribution, setUserContribution] = useState<string | null>(null);
  const [comments, setComments] = useState<CommentSummary[]>([]);
  const [commentsPage, setCommentsPage] = useState(1);
  const [commentsHasMore, setCommentsHasMore] = useState(false);
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false);
  const [karma, setKarma] = useState<number>(0);
  const [minKarmaToFlag, setMinKarmaToFlag] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [commentBody, setCommentBody] = useState("");

  const { completePollSetup, completeCrowdfundSetup, busy: setupBusy } = usePostSetup(postId);

  const [contributeOpen, setContributeOpen] = useState(false);
  const [contributeAmountEth, setContributeAmountEth] = useState<number>(0.1);
  const [contributeBusy, setContributeBusy] = useState(false);

  const cancelledRef = useRef(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [postData, commentsData, forumData] = await Promise.all([
        api.getPost(postId, address ?? undefined),
        api.getPostComments(postId, { userWallet: address ?? undefined, page: 1, limit: COMMENTS_PAGE_SIZE }),
        api.getForum(forumKey),
      ]);
      if (cancelledRef.current) return;
      setPost(postData.post);
      setPollOptions(postData.pollOptions);
      setUserPollOption(postData.userPollOption);
      setUserContribution(postData.userContributionWei);
      setComments(commentsData.comments);
      setCommentsPage(1);
      setCommentsHasMore(commentsData.hasMore);
      setMinKarmaToFlag(Number(forumData.min_karma_to_flag));

      if (address) {
        const userData = await api.getUser(address).catch(() => null);
        if (cancelledRef.current) return;
        setKarma(userData ? Number(userData.user.karma) : 0);
      } else {
        setKarma(0);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load post.");
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [forumKey, postId, address]);

  useEffect(() => {
    cancelledRef.current = false;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    loadAll();
    return () => { cancelledRef.current = true; };
  }, [loadAll]);

  // Waits for the indexer's own poll cycle, then refetches - used after
  // every write action so the reload reflects the just-confirmed change
  // instead of racing the indexer.
  const refreshAfterIndexerCatchup = async () => {
    await new Promise((r) => setTimeout(r, INDEXER_CATCHUP_MS));
    if (!cancelledRef.current) loadAll();
  };

  const loadMoreComments = async () => {
    setCommentsLoadingMore(true);
    try {
      const nextPage = commentsPage + 1;
      const data = await api.getPostComments(postId, { userWallet: address ?? undefined, page: nextPage, limit: COMMENTS_PAGE_SIZE });
      if (cancelledRef.current) return;
      setComments((prev) => [...prev, ...data.comments]);
      setCommentsPage(nextPage);
      setCommentsHasMore(data.hasMore);
    } catch (err) {
      if (!cancelledRef.current) notifyError(err instanceof Error ? err.message : "Failed to load more comments.");
    } finally {
      if (!cancelledRef.current) setCommentsLoadingMore(false);
    }
  };

  const commentsSentinelRef = useInfiniteScroll(loadMoreComments, commentsHasMore && !commentsLoadingMore && !loading);

  const handlePollSetup = async (days: number) => {
    if (!post) return;
    const ok = await completePollSetup(days, post.ipfs_cid);
    if (ok) await refreshAfterIndexerCatchup();
  };

  const handleCrowdfundSetup = async (goalEth: number, days: number) => {
    const ok = await completeCrowdfundSetup(goalEth, days);
    if (ok) await refreshAfterIndexerCatchup();
  };

  const submitComment = async () => {
    if (!commentBody.trim()) return;
    if (!requireWallet("post a comment") || !signer) return;
    const contract = getCoreContract(signer);
    setActionBusy(true);
    try {
      const cid = await uploadJsonToIPFS({ body: commentBody.trim() });
      const ipfsCidBytes32 = ipfsCidToBytes32(cid);
      await trackTransaction({
        description: "Post comment",
        contract,
        send: () => contract.createComment(BigInt(postId), 0n, ipfsCidBytes32),
      });
      setCommentBody("");
      await refreshAfterIndexerCatchup();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Comment failed.");
    } finally {
      setActionBusy(false);
    }
  };

  const castFlag = async () => {
    if (!requireWallet("flag this post") || !signer) return;
    const contract = getCoreContract(signer);
    setActionBusy(true);
    try {
      await trackTransaction({
        description: "Flag post",
        contract,
        send: () => contract.flagPost(BigInt(postId)),
      });
      await refreshAfterIndexerCatchup();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Flag failed.");
    } finally {
      setActionBusy(false);
    }
  };

  const castPollVote = async (optionId: number) => {
    if (!requireWallet("vote in this poll") || !signer) return;
    const contract = getCoreContract(signer);
    setActionBusy(true);
    try {
      await trackTransaction({
        description: "Cast poll vote",
        contract,
        send: () => contract.castPollVote(BigInt(postId), optionId),
      });
      await refreshAfterIndexerCatchup();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Poll vote failed.");
    } finally {
      setActionBusy(false);
    }
  };

  const claimPayout = async () => {
    if (!requireWallet("claim this crowdfund's payout") || !signer) return;
    const contract = getEscrowContract(signer);
    setActionBusy(true);
    try {
      await trackTransaction({
        description: "Claim crowdfund payout",
        contract,
        send: () => contract.claimPayout(BigInt(postId)),
      });
      await refreshAfterIndexerCatchup();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Claim failed.");
    } finally {
      setActionBusy(false);
    }
  };

  const claimRefund = async () => {
    if (!requireWallet("claim your crowdfund refund") || !signer) return;
    const contract = getEscrowContract(signer);
    setActionBusy(true);
    try {
      await trackTransaction({
        description: "Claim crowdfund refund",
        contract,
        send: () => contract.claimRefund(BigInt(postId)),
      });
      await refreshAfterIndexerCatchup();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Refund claim failed.");
    } finally {
      setActionBusy(false);
    }
  };

  const submitContribution = async () => {
    if (!requireWallet("contribute to this crowdfund") || !signer) return;
    if (contributeAmountEth <= 0) {
      notifyError("Contribution amount must be greater than 0.");
      return;
    }
    const contract = getEscrowContract(signer);
    setContributeBusy(true);
    try {
      const valueWei = BigInt(Math.round(contributeAmountEth * 1e18));
      await trackTransaction({
        description: `Contribute ${contributeAmountEth} ETH to crowdfund`,
        contract,
        send: () => contract.contribute(BigInt(postId), { value: valueWei }),
      });
      setContributeOpen(false);
      await refreshAfterIndexerCatchup();
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Contribution failed.");
    } finally {
      setContributeBusy(false);
    }
  };

  if (loading) return <Group justify="center" py="xl"><Loader size="sm" /></Group>;
  if (error && !post) {
    return (
      <Alert color="red" role="alert" icon={<IconAlertTriangle size={18} stroke={1.75} aria-hidden="true" />}>
        <Stack gap="sm">
          <Text>{error}</Text>
          <Button component={Link} to="/forums" variant="light" size="xs" style={{ alignSelf: "flex-start" }}>
            Browse Forums
          </Button>
        </Stack>
      </Alert>
    );
  }
  if (!post) return null;

  // API only nulls title/body for a TimeCapsule pre-reveal (except to the
  // author) - this also hides votes/media/flags client-side rather than
  // leaking engagement data about content the API otherwise redacts.
  const isLocked =
    post.post_type === "TimeCapsule" &&
    post.visible_after !== null &&
    new Date(post.visible_after) > new Date() &&
    post.author_wallet.toLowerCase() !== (address?.toLowerCase() ?? "");

  const cfDeadlinePassed = post.cf_deadline ? new Date(post.cf_deadline) < new Date() : false;
  const cfGoalReached = post.cf_target_goal ? Number(post.cf_funds_raised ?? 0) >= Number(post.cf_target_goal) : false;
  const isAuthor = post.author_wallet.toLowerCase() === (address?.toLowerCase() ?? "");
  const needsPollConfig = post.post_type === "Poll" && !post.poll_option_count;
  const needsCfConfig = post.post_type === "Crowdfund" && !post.cf_target_goal;
  const pollTotal = pollOptions.reduce((sum, o) => sum + o.vote_count, 0) || 1;
  const pollClosed = post.poll_deadline ? new Date(post.poll_deadline) < new Date() : false;
  const canContribute = post.post_type === "Crowdfund" && !needsCfConfig && !cfDeadlinePassed;

  return (
    <Stack gap="lg" py="md">
      <Button
        component={Link}
        to={`/f/${forumKey}`}
        variant="subtle"
        size="xs"
        leftSection={<IconArrowLeft size={14} stroke={1.75} aria-hidden="true" />}
        style={{ alignSelf: "flex-start" }}
      >
        Back to forum
      </Button>

      {isAuthor && needsPollConfig && (
        <Alert color="blue" title="This poll hasn't been configured yet">
          <PollSetupForm
            onSubmit={handlePollSetup}
            busy={setupBusy}
            helperText="Votes can't be cast until setup finishes. This is retryable at any time."
          />
        </Alert>
      )}

      {isAuthor && needsCfConfig && (
        <Alert color="blue" title="This crowdfund hasn't been launched yet">
          <CrowdfundSetupForm
            onSubmit={handleCrowdfundSetup}
            busy={setupBusy}
            helperText="Contributions can't be accepted until it's launched. This is retryable at any time."
          />
        </Alert>
      )}

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {isLocked ? (
              <Paper withBorder p="xl">
                <Stack align="center" gap={4}>
                  <IconHourglass size={28} stroke={1.75} color="var(--mantine-color-dimmed)" aria-hidden="true" />
                  <Text fw={500} c="dimmed">A post will appear here</Text>
                  <Text size="sm" c="dimmed">Unlocks {formatDate(post.visible_after!)}</Text>
                </Stack>
              </Paper>
            ) : (
              <CollapsedFlagged flagTally={post.flag_tally} userTally={userTally}>
                <Paper withBorder p="lg">
                  <Stack gap="sm">
                    <Group gap="xs">
                      <AuthorLink wallet={post.author_wallet} username={post.author_username} profileCid={post.author_profile_cid} size={20} />
                      <Text size="sm" c="dimmed">• {formatDate(post.created_at)}</Text>
                      <Badge variant="light">{post.post_type}</Badge>
                    </Group>

                    <Title order={2} style={{ overflowWrap: "anywhere" }}>{post.title ?? "(untitled)"}</Title>
                    {post.body && <ReadMore text={post.body} textStyle={{ maxWidth: "65ch", overflowWrap: "anywhere" }} />}

                    {post.media_cids && post.media_cids.filter((cid) => !failedMediaCids.has(cid)).length > 0 && (
                      <SimpleGrid cols={{ base: 1, xs: post.media_cids.length > 1 ? 2 : 1 }} spacing="sm">
                        {post.media_cids.filter((cid) => !failedMediaCids.has(cid)).map((cid) => (
                          <Image
                            key={cid}
                            src={ipfsGatewayUrl(cid)}
                            alt=""
                            radius="sm"
                            style={{ cursor: "zoom-in", maxHeight: 480, objectFit: "cover" }}
                            onClick={() => setLightboxSrc(ipfsGatewayUrl(cid))}
                            onError={() => setFailedMediaCids((prev) => new Set(prev).add(cid))}
                          />
                        ))}
                      </SimpleGrid>
                    )}

                    {post.post_type === "Poll" && pollOptions.length > 0 && (
                      <Stack gap={4}>
                        <Radio.Group
                          value={userPollOption !== null ? String(userPollOption) : undefined}
                          onChange={(v) => castPollVote(Number(v))}
                        >
                          <Stack gap={4}>
                            {pollOptions.map((opt) => {
                              const pct = Math.round((opt.vote_count / pollTotal) * 100);
                              return (
                                <Group key={opt.option_id} gap="sm" wrap="wrap" align="flex-start">
                                  <Radio
                                    value={String(opt.option_id)}
                                    label={opt.choice_text}
                                    disabled={actionBusy || pollClosed}
                                    styles={{ label: { overflowWrap: "anywhere" } }}
                                    style={{ flex: "1 1 200px", minWidth: 0 }}
                                  />
                                  <Group gap="xs" wrap="nowrap" style={{ flex: "1 1 160px", minWidth: 140 }}>
                                    <Progress value={pct} style={{ flex: 1 }} />
                                    <Text size="xs" c="dimmed" w={60} style={{ flexShrink: 0 }}>{opt.vote_count} ({pct}%)</Text>
                                  </Group>
                                </Group>
                              );
                            })}
                          </Stack>
                        </Radio.Group>
                        {userPollOption !== null && (
                          <Text size="xs" c="dimmed">
                            You can change your vote while the poll is open, but a vote can't be fully retracted.
                          </Text>
                        )}
                        {post.poll_deadline && (
                          <Text size="xs" c="dimmed">{pollClosed ? "Closed" : "Closes"} {formatDate(post.poll_deadline)}</Text>
                        )}
                      </Stack>
                    )}

                    {post.post_type === "Crowdfund" && post.cf_target_goal && (
                      <Stack gap={4}>
                        <Text size="sm" c="dimmed">
                          Raised {weiToEth(post.cf_funds_raised ?? "0")} / {weiToEth(post.cf_target_goal)} ETH
                          {post.cf_deadline ? ` • Deadline ${formatDate(post.cf_deadline)}` : ""}
                        </Text>
                        <Progress value={Math.min(100, (Number(post.cf_funds_raised ?? 0) / Number(post.cf_target_goal)) * 100)} />
                        {userContribution && Number(userContribution) > 0 && (
                          <Group gap={4} wrap="nowrap">
                            <IconHeart size={14} stroke={1.75} color="var(--mantine-color-green-6)" aria-hidden="true" />
                            <Text size="xs">You backed {weiToEth(userContribution)} ETH</Text>
                          </Group>
                        )}

                        {canContribute && (
                          <Popover opened={contributeOpen} onChange={setContributeOpen} withArrow>
                            <Popover.Target>
                              <Button
                                size="xs"
                                onClick={() => setContributeOpen((o) => !o)}
                                leftSection={<IconCash size={14} stroke={1.75} aria-hidden="true" />}
                                style={{ alignSelf: "flex-start" }}
                              >
                                Contribute
                              </Button>
                            </Popover.Target>
                            <Popover.Dropdown>
                              <Stack gap="xs" w={200}>
                                <NumberInput
                                  label="Amount (ETH)"
                                  value={contributeAmountEth}
                                  onChange={(v) => setContributeAmountEth(typeof v === "number" ? v : 0)}
                                  min={0.0001}
                                  decimalScale={4}
                                />
                                <Button size="xs" onClick={submitContribution} loading={contributeBusy}>Confirm Contribution</Button>
                              </Stack>
                            </Popover.Dropdown>
                          </Popover>
                        )}

                        {isAuthor && cfDeadlinePassed && cfGoalReached && !post.cf_claimed && (
                          <Button size="xs" onClick={claimPayout} loading={actionBusy} leftSection={<IconCoins size={14} stroke={1.75} aria-hidden="true" />}>
                            Claim Payout
                          </Button>
                        )}
                        {!isAuthor && cfDeadlinePassed && !cfGoalReached && userContribution && Number(userContribution) > 0 && (
                          <Button size="xs" color="orange" onClick={claimRefund} loading={actionBusy} leftSection={<IconCoins size={14} stroke={1.75} aria-hidden="true" />}>
                            Claim Refund
                          </Button>
                        )}
                        {cfDeadlinePassed && !cfGoalReached && (
                          <Alert color="red" variant="light">Campaign failed to reach its goal.</Alert>
                        )}
                      </Stack>
                    )}

                    <Group gap="sm">
                      <VoteControls
                        targetType="post"
                        targetId={post.post_id}
                        upvotes={post.upvotes}
                        downvotes={post.downvotes}
                        initialVoteState={post.user_vote as -2 | -1 | 0 | 1}
                      />
                      <Button
                        size="xs"
                        variant={post.user_flagged ? "filled" : "subtle"}
                        color="orange"
                        leftSection={
                          <IconFlag
                            size={14}
                            stroke={1.75}
                            color={!post.user_flagged && colorScheme === "dark" ? darkModeInactiveIconColors.flag : undefined}
                            aria-hidden="true"
                          />
                        }
                        onClick={castFlag}
                        loading={actionBusy}
                        disabled={post.user_flagged || !post.is_member || karma < minKarmaToFlag}
                        title={
                          post.user_flagged ? "You've already flagged this" :
                          !post.is_member ? "Join this forum to flag" :
                          karma < minKarmaToFlag ? `Requires ${minKarmaToFlag} karma` : undefined
                        }
                      >
                        Flag ({post.flag_tally})
                      </Button>
                    </Group>
                  </Stack>
                </Paper>
              </CollapsedFlagged>
            )}

            <Divider label="Comments" />

            {post.is_member ? (
              <Stack gap="xs">
                <Textarea
                  aria-label="Add a comment"
                  placeholder="Add a public response…"
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.currentTarget.value)}
                  minRows={3}
                />
                <Button
                  size="sm"
                  onClick={submitComment}
                  loading={actionBusy}
                  leftSection={<IconRocket size={14} stroke={1.75} aria-hidden="true" />}
                  style={{ alignSelf: "flex-end" }}
                >
                  Post Comment
                </Button>
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">Join this forum to comment.</Text>
            )}

            <CommentThread
              comments={comments}
              postId={postId}
              isMember={post.is_member}
              karma={karma}
              minKarmaToFlag={minKarmaToFlag}
              onCommentAdded={refreshAfterIndexerCatchup}
            />
            {commentsLoadingMore && <Group justify="center"><Loader size="sm" /></Group>}
            {commentsHasMore && <div ref={commentsSentinelRef} style={{ height: 1 }} />}
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="lg">
            <Paper withBorder p="lg">
              <Stack gap="xs">
                <Group gap={6}>
                  <IconShieldCheck size={18} stroke={1.75} aria-hidden="true" />
                  <Text fw={600}>Verify this post</Text>
                </Group>
                <Text size="xs" c="dimmed">
                  Verify Content Integrity - Prove this post hasn't been tampered with or deleted by checking its on-chain cryptographic signature.
                </Text>
                <MerkleAuditModal
                  entityType="post"
                  entityId={post.post_id}
                  cachedContent={isLocked ? undefined : { title: post.title, body: post.body }}
                  onCorrected={(content) => setPost((prev) => (prev ? { ...prev, ...content } : prev))}
                  trigger="prominent"
                />
              </Stack>
            </Paper>

            <Paper withBorder p="lg">
              <Stack gap="xs">
                <Group gap={6}>
                  <IconBolt size={18} stroke={1.75} aria-hidden="true" />
                  <Text fw={600}>Support this post</Text>
                </Group>
                <TipButton
                  target={{ type: "post", postId: post.post_id }}
                  recipientWallet={post.author_wallet}
                  recipientUsername={post.author_username}
                  recipientProfileCid={post.author_profile_cid}
                />
                <TipTotal userTippedWei={post.user_tipped_wei} />
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>

      <Modal opened={lightboxSrc !== null} onClose={() => setLightboxSrc(null)} size="auto" padding={0} withCloseButton centered>
        {lightboxSrc && <Image src={lightboxSrc} alt="" fit="contain" mah="85vh" />}
      </Modal>
    </Stack>
  );
}