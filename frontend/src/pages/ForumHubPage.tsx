// src/pages/ForumHubPage.tsx - Screen 5.
//
// Membership state (`forum.is_member`) comes from the same GET /api/forums/
// :forumKey request as the rest of the header (backed by the indexed
// `forum_memberships` table), not a separate on-chain `forumMembership`
// read - that used to run in its own effect after first paint, which is
// what caused the "Join Community" button to flash before flipping to
// "Leave Community". toggleMembership optimistically flips `is_member` and
// adjusts `member_count` by ±1 - instant and sufficient for a simple
// counter (no need to wait for the indexer here, unlike flag tallies/poll
// tallies/crowdfund totals, which read richer server-computed state).

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useDebouncedValue } from "@mantine/hooks";
import { Stack, Title, Text, Group, Badge, Button, TextInput, Select, SimpleGrid, Loader, Alert, Paper, Modal, Grid, Tooltip, Image } from "@mantine/core";
import { IconUsers, IconFileText, IconScale, IconUserPlus, IconDoorExit, IconInfoCircle, IconAlertTriangle } from "@tabler/icons-react";
import { api, type ForumDetail, type PostSummary } from "../lib/api";
import { useWallet } from "../context/WalletContext";
import { getCoreContract } from "../lib/contracts";
import { PostCard } from "../components/PostCard";
import { MerkleAuditModal } from "../components/MerkleAuditModal";
import { ReadMore } from "../components/ReadMore";
import { AuthorLink } from "../components/AuthorLink";
import { useTransactions } from "../context/TransactionContext";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { ForumIcon } from "../components/ForumIcon";
import { gradientMeshBackground } from "../lib/gradientMesh";
import { ipfsGatewayUrl } from "../lib/ipfs";

const SORTS = [
  { value: "newest", label: "Newest" },
  { value: "top", label: "Top (Most Upvoted)" },
  { value: "deadline", label: "Poll/Crowdfund Deadline" },
];
const PAGE_SIZE = 20;

export function ForumHubPage() {
  const { forumKey = "" } = useParams();
  const { address, signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();

  const [forum, setForum] = useState<ForumDetail | null>(null);
  // Tracks which banner_cid/icon_cid last failed to load, rather than a
  // plain boolean - this route component isn't remounted when forumKey
  // changes (see the titleInput resync effect below for the same caveat),
  // so a boolean would keep a valid banner/icon on a different forum
  // permanently suppressed after an earlier forum's image failed to load.
  const [failedBannerCid, setFailedBannerCid] = useState<string | null>(null);
  const [failedIconCid, setFailedIconCid] = useState<string | null>(null);
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [postsPage, setPostsPage] = useState(1);
  const [postsHasMore, setPostsHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [postsLoading, setPostsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // title: local state for instant keystroke feedback, debounced before it
  // becomes the URL/query value (same rationale as ForumDiscoveryPage's
  // search box). type/sort have no such concern (single-click Select
  // changes) so they read straight from the URL - one source of truth.
  const [searchParams, setSearchParams] = useSearchParams();
  const [titleInput, setTitleInput] = useState(() => searchParams.get("title") ?? "");
  const [debouncedTitle] = useDebouncedValue(titleInput, 300);
  const typeFilter = searchParams.get("type");
  const sort = searchParams.get("sort") ?? "newest";
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);

  // Filters are per-forum query state; when the route's forumKey changes
  // (navigating to a different forum's hub without a full remount, since
  // it's the same route component), the fresh URL won't carry the old
  // forum's ?title= unless the user's link included it - re-seed the local
  // input from whatever the new URL actually has instead of leaving the
  // previous forum's typed text lingering and getting written back onto it.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    setTitleInput(searchParams.get("title") ?? "");
  }, [forumKey]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const setTypeFilter = (value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("type", value);
      else next.delete("type");
      return next;
    }, { replace: true });
  };

  const setSort = (value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sort", value ?? "newest");
      return next;
    }, { replace: true });
  };

  // One-way write: debounced typed title -> URL (replace, so typing doesn't
  // spam browser history).
  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (debouncedTitle) next.set("title", debouncedTitle);
      else next.delete("title");
      return next;
    }, { replace: true });
  }, [debouncedTitle, setSearchParams]);

  /* eslint-disable react-hooks/set-state-in-effect */
  // Forum header details only need to load once per forumKey - kept in its
  // own effect (and its own `loading` flag) so a title/type/sort filter
  // change never re-triggers this page-level loading state.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getForum(forumKey, address ?? undefined)
      .then((forumData) => { if (!cancelled) setForum(forumData); })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load forum"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [forumKey, address]);

  // Posts list refetches (resetting to page 1) on every filter change - uses
  // its own `postsLoading` flag rendered inline (not an early return) so the
  // filter/search controls stay mounted (and focused) across keystrokes
  // instead of unmounting.
  useEffect(() => {
    let cancelled = false;
    setPostsLoading(true);
    api.getForumPosts(forumKey, { title: debouncedTitle || undefined, type: typeFilter ?? undefined, sort, page: 1, limit: PAGE_SIZE, userWallet: address ?? undefined })
      .then((postsData) => {
        if (cancelled) return;
        setPosts(postsData.posts);
        setPostsPage(1);
        setPostsHasMore(postsData.posts.length === PAGE_SIZE);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load posts"))
      .finally(() => !cancelled && setPostsLoading(false));
    return () => { cancelled = true; };
  }, [forumKey, debouncedTitle, typeFilter, sort, address]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMorePosts = () => {
    const nextPage = postsPage + 1;
    setPostsLoading(true);
    api.getForumPosts(forumKey, { title: debouncedTitle || undefined, type: typeFilter ?? undefined, sort, page: nextPage, limit: PAGE_SIZE, userWallet: address ?? undefined })
      .then((postsData) => {
        setPosts((prev) => [...prev, ...postsData.posts]);
        setPostsPage(nextPage);
        setPostsHasMore(postsData.posts.length === PAGE_SIZE);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load posts"))
      .finally(() => setPostsLoading(false));
  };

  const postsSentinelRef = useInfiniteScroll(loadMorePosts, postsHasMore && !postsLoading);

  const toggleMembership = async () => {
    if (!forum) return;
    const wasMember = forum.is_member;
    if (!requireWallet(wasMember ? `leave r/${forum.name}` : `join r/${forum.name}`) || !signer) return;
    const contract = getCoreContract(signer);
    setMembershipBusy(true);
    setError(null);
    try {
      await trackTransaction({
        description: wasMember ? `Leave r/${forum.name}` : `Join r/${forum.name}`,
        contract,
        send: () => (wasMember ? contract.leaveForum(forumKey) : contract.joinForum(forumKey)),
      });
      // Optimistic update - see file header for why this doesn't wait on the indexer.
      setForum((prev) => (prev ? { ...prev, is_member: !wasMember, member_count: prev.member_count + (wasMember ? -1 : 1) } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Membership transaction failed.");
    } finally {
      setMembershipBusy(false);
    }
  };

  // Joining prompts a lightweight, frontend-only rules-acceptance step
  // before the on-chain joinForum call fires; leaving needs no such gate.
  const handleMembershipClick = () => {
    if (!forum) return;
    if (forum.is_member) {
      void toggleMembership();
    } else {
      setRulesModalOpen(true);
    }
  };

  const confirmJoin = async () => {
    setRulesModalOpen(false);
    await toggleMembership();
  };

  if (loading) return <Group justify="center" py="xl"><Loader size="sm" /></Group>;
  if (error && !forum) {
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
  if (!forum) return null;

  const blockPost = Boolean(address) && !forum.is_member;

  return (
    <Stack gap="lg" py="md">
      <div style={{ position: "relative", marginBottom: 44 }}>
        <div
          style={{
            height: 160,
            borderRadius: "var(--mantine-radius-md)",
            overflow: "hidden",
            background: forum.banner_cid && forum.banner_cid !== failedBannerCid ? undefined : gradientMeshBackground(forum.name),
          }}
        >
          {forum.banner_cid && forum.banner_cid !== failedBannerCid && (
            <Image
              src={ipfsGatewayUrl(forum.banner_cid)}
              alt=""
              h={160}
              w="100%"
              style={{ objectFit: "cover" }}
              onError={() => setFailedBannerCid(forum.banner_cid)}
            />
          )}
        </div>
        <div
          style={{
            position: "absolute",
            left: 24,
            top: 124,
            borderRadius: "50%",
            border: "4px solid var(--app-surface-1)",
            overflow: "hidden",
            background: "var(--app-surface-1)",
            lineHeight: 0,
          }}
        >
          {forum.icon_cid && forum.icon_cid !== failedIconCid ? (
            <Image
              src={ipfsGatewayUrl(forum.icon_cid)}
              alt=""
              w={72}
              h={72}
              style={{ objectFit: "cover" }}
              onError={() => setFailedIconCid(forum.icon_cid)}
            />
          ) : (
            <ForumIcon name={forum.name} size={72} />
          )}
        </div>
      </div>
      <Paper withBorder p="lg">
        <Stack gap="xs">
          <Group justify="space-between">
            <Group gap="xs" style={{ minWidth: 0 }}>
              <Title order={1} style={{ overflowWrap: "anywhere", minWidth: 0 }}>r/{forum.name}</Title>
              <MerkleAuditModal
                entityType="forum"
                entityId={forum.forum_key}
                cachedContent={{
                  name: forum.name,
                  description: forum.description,
                  category: forum.category,
                  rules: forum.rules,
                  tags: forum.tags,
                }}
                onCorrected={(content) => setForum((prev) => (prev ? { ...prev, ...content } : prev))}
              />
            </Group>
            <Badge size="lg" variant="light">{forum.category}</Badge>
          </Group>
          {forum.description && (
            <ReadMore text={forum.description} textStyle={{ color: "var(--mantine-color-dimmed)" }} />
          )}
          {forum.tags.length > 0 && (
            <Group gap="xs" wrap="wrap">
              {forum.tags.map((tag) => (
                <Badge
                  key={tag}
                  component={Link}
                  to={`/forums?tags=${encodeURIComponent(tag)}`}
                  size="xs"
                  variant="outline"
                  maw={140}
                  style={{ overflow: "hidden", textOverflow: "ellipsis", textDecoration: "none", cursor: "pointer", textTransform: "none" }}
                >
                  {tag}
                </Badge>
              ))}
            </Group>
          )}
          <Group>
            <Button
              component={Link}
              to={`/f/${forumKey}/submit`}
              disabled={blockPost}
              title={blockPost ? "Join this community to post" : undefined}
              leftSection={<IconFileText size={16} stroke={1.75} aria-hidden="true" />}
            >
              Create Post
            </Button>
            <Button
              variant={forum.is_member ? "outline" : "filled"}
              color={forum.is_member ? "red" : "green"}
              onClick={handleMembershipClick}
              loading={membershipBusy}
              leftSection={forum.is_member ? <IconDoorExit size={16} stroke={1.75} aria-hidden="true" /> : <IconUserPlus size={16} stroke={1.75} aria-hidden="true" />}
            >
              {forum.is_member ? "Leave Community" : "Join Community"}
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Modal
        opened={rulesModalOpen}
        onClose={() => setRulesModalOpen(false)}
        title={
          <Group gap={6}>
            <IconScale size={18} stroke={1.75} aria-hidden="true" />
            <Text fw={600}>Rules & Community Expectations</Text>
          </Group>
        }
      >
        <Stack gap="sm">
          <ReadMore
            text={forum.rules && forum.rules.trim() ? forum.rules : "This community hasn't posted any additional rules yet."}
            size="sm"
            maxHeight={160}
            textStyle={{ whiteSpace: "pre-wrap" }}
          />
          <Text size="xs" c="dimmed">By joining, you agree to follow this community's rules and expectations.</Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" onClick={() => setRulesModalOpen(false)}>Cancel</Button>
            <Button onClick={confirmJoin} loading={membershipBusy}>I Agree, Join</Button>
          </Group>
        </Stack>
      </Modal>

      {error && <Alert color="red" role="alert">{error}</Alert>}

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput placeholder="Filter by title…" value={titleInput} onChange={(e) => setTitleInput(e.currentTarget.value)} />
              <Select placeholder="All types" data={["Standard", "TimeCapsule", "Poll", "Crowdfund"]} value={typeFilter} onChange={setTypeFilter} clearable />
              <Select data={SORTS} value={sort} onChange={(value) => setSort(value ?? "newest")} allowDeselect={false} />
            </SimpleGrid>

            {posts.length === 0 && !postsLoading ? (
              <Text c="dimmed" size="sm">No posts yet in this community.</Text>
            ) : (
              <Stack gap="md">
                {posts.map((post) => <PostCard key={post.post_id} post={post} forumKey={forumKey} />)}
              </Stack>
            )}
            {postsLoading && <Group justify="center"><Loader size="sm" /></Group>}
            {postsHasMore && <div ref={postsSentinelRef} style={{ height: 1 }} />}
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="lg">
            <Paper withBorder p="lg">
              <Stack gap="xs">
                <Group gap={6}>
                  <IconUsers size={14} stroke={1.75} aria-hidden="true" />
                  <Text size="sm" c="dimmed" className="tabular-nums">{forum.member_count} members</Text>
                </Group>
                <Group gap={6}>
                  <IconFileText size={14} stroke={1.75} aria-hidden="true" />
                  <Text size="sm" c="dimmed" className="tabular-nums">{forum.post_count} posts</Text>
                </Group>
                <Group gap={6} align="center">
                  <Text size="sm" c="dimmed">Creator:</Text>
                  <AuthorLink
                    wallet={forum.creator_wallet}
                    username={forum.creator_username}
                    profileCid={forum.creator_profile_cid}
                    size={16}
                  />
                </Group>
                <Group gap={4} wrap="nowrap">
                  <Text size="sm" c="dimmed">Required Karma to Flag: {forum.min_karma_to_flag}</Text>
                  <Tooltip
                    label="Karma is earned when others upvote your content. Higher karma gives your flags more weight in community moderation."
                    multiline
                    w={260}
                    withArrow
                  >
                    <IconInfoCircle size={14} stroke={1.75} style={{ color: "var(--mantine-color-dimmed)", cursor: "help" }} aria-hidden="true" />
                  </Tooltip>
                </Group>
              </Stack>
            </Paper>

            {forum.rules && forum.rules.trim() && (
              <Paper withBorder p="lg">
                <Group gap={6} mb={4}>
                  <IconScale size={16} stroke={1.75} aria-hidden="true" />
                  <Text fw={500} size="sm">Community Rules</Text>
                </Group>
                <ReadMore
                  text={forum.rules}
                  size="sm"
                  textStyle={{ color: "var(--mantine-color-dimmed)", whiteSpace: "pre-wrap" }}
                />
              </Paper>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}