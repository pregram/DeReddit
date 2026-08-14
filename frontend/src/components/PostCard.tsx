// Read-only post summary card shown in a forum's feed. Links to the post
// detail page when a forumKey is supplied by the caller (PostSummary itself
// has no forum_key - the caller already knows it from route context).
//
// TimeCapsule posts render as a locked placeholder while `visible_after` is
// in the future, matching the API's withholding of title/body for the same
// window - once the reveal time passes, the post simply appears normally on
// the next feed load, no "just revealed" marker (intentionally not tracked,
// to avoid a revealed_recently column).
//
// Vote buttons are wired directly to the feed's embedded user_vote so users
// don't have to open the post detail page just to vote. Title/body stay a
// Link to the detail page; only the vote control row is pulled out of that
// link so a vote click doesn't also navigate away.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Group, Text, Badge, Stack, Progress, Image, useMantineColorScheme } from "@mantine/core";
import { IconHourglass, IconFlag, IconChartBar } from "@tabler/icons-react";
import type { PostSummary } from "../lib/api";
import { weiToEth, formatDate } from "../lib/format";
import { AuthorLink } from "./AuthorLink";
import { VoteControls } from "./VoteControls";
import { CollapsedFlagged } from "./CollapsedFlagged";
import { useFlagTolerance } from "../lib/flagTolerance";
import { TipTotal } from "./TipTotal";
import { darkModeInactiveIconColors } from "../theme";
import { ipfsGatewayUrl } from "../lib/ipfs";


interface PostCardProps {
  post: PostSummary;
  forumKey?: string;
}

export function PostCard({ post, forumKey }: PostCardProps) {
  const [userTally] = useFlagTolerance();
  const { colorScheme } = useMantineColorScheme();
  const [failedMediaCids, setFailedMediaCids] = useState<Set<string>>(new Set());
  const isLocked =
    post.post_type === "TimeCapsule" &&
    post.visible_after !== null &&
    new Date(post.visible_after) > new Date();

  // Two fully-separate branches per link target below (rather than a shared
  // conditionally-shaped `linkProps` object spread into each element) -
  // spreading a "full object | {}" union into a polymorphic component's
  // props makes TS infer `to` as `string | undefined`, which react-router's
  // `To` type rejects. A literal `component={Link}` with an always-defined
  // `to` in one branch, and no `component`/`to` at all in the other, keeps
  // each branch's prop types concrete.
  const detailPath = forumKey ? `/f/${forumKey}/p/${post.post_id}` : null;
  const linkStyle = { textDecoration: "none", color: "inherit" };

  if (isLocked) {
    const revealDate = new Date(post.visible_after!);
    const daysLeft = Math.max(0, Math.ceil((revealDate.getTime() - Date.now()) / 86_400_000));
    const lockedContent = (
      <Stack gap={4} align="center">
        <IconHourglass size={28} stroke={1.75} color="var(--mantine-color-dimmed)" aria-hidden="true" />
        <Text fw={500} c="dimmed">A post will appear here</Text>
        <Text size="sm" c="dimmed">
          Unlocks {formatDate(post.visible_after!)} (~{daysLeft} day{daysLeft === 1 ? "" : "s"})
        </Text>
      </Stack>
    );
    return detailPath ? (
      <Card component={Link} to={detailPath} withBorder padding="lg" className="hoverable-card" style={{ opacity: 0.7, ...linkStyle }}>
        {lockedContent}
      </Card>
    ) : (
      <Card withBorder padding="lg" style={{ opacity: 0.7 }}>
        {lockedContent}
      </Card>
    );
  }

  // Post-type badge + date are pulled out into their own fragment so they
  // can stay wrapped in the post-detail Link below, separately from the
  // author identicon/username - AuthorLink is its own Link to the author's
  // profile, and nesting two <a> tags (one inside the other) is invalid
  // HTML, so it can't sit inside the post-detail Link too.
  const typeAndDate = (
    <>
      <Badge size="xs" variant="light">{post.post_type}</Badge>
      <Text size="xs" c="dimmed">{formatDate(post.created_at)}</Text>
    </>
  );

  const pollOptions = post.poll_options ?? [];
  const visiblePollOptions = pollOptions.slice(0, 3);
  const hiddenPollOptionCount = pollOptions.length - visiblePollOptions.length;

  const titleAndBody = (
    <>
      <Text fw={600} lineClamp={1} style={{ overflowWrap: "anywhere" }}>{post.title ?? "(untitled)"}</Text>
      {post.body && (
        <Text size="sm" c="dimmed" lineClamp={3} style={{ overflowWrap: "anywhere" }}>
          {post.body}
        </Text>
      )}

      {post.media_cids && post.media_cids.filter((cid) => !failedMediaCids.has(cid)).length > 0 && (
        <Group gap={4} wrap="nowrap" style={{ overflow: "hidden" }}>
          {post.media_cids.filter((cid) => !failedMediaCids.has(cid)).slice(0, 4).map((cid) => (
            <Image
              key={cid}
              src={ipfsGatewayUrl(cid)}
              alt=""
              h={72}
              w={72}
              radius="sm"
              style={{ objectFit: "cover", flexShrink: 0 }}
              onError={() => setFailedMediaCids((prev) => new Set(prev).add(cid))}
            />
          ))}
        </Group>
      )}

      {post.post_type === "Crowdfund" && post.cf_target_goal && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Raised {weiToEth(post.cf_funds_raised ?? "0")} / {weiToEth(post.cf_target_goal)} ETH
            {post.cf_deadline ? ` • Deadline ${formatDate(post.cf_deadline)}` : ""}
          </Text>
          <Progress value={Math.min(100, (Number(post.cf_funds_raised ?? 0) / Number(post.cf_target_goal)) * 100)} />
        </Stack>
      )}

      {post.post_type === "Poll" && visiblePollOptions.length > 0 && (
        <Stack gap={4}>
          {visiblePollOptions.map((opt) => (
            <Text key={opt.option_id} size="xs" c="dimmed">
              • {opt.choice_text} ({opt.vote_count})
            </Text>
          ))}
          {hiddenPollOptionCount > 0 && (
            // Not its own link - the whole title/body area this sits inside
            // is already wrapped in a Link to the post (see below), so this
            // is just an indicator, not a second nested anchor.
            <Badge size="xs" variant="outline" style={{ width: "fit-content" }}>
              +{hiddenPollOptionCount} more option{hiddenPollOptionCount === 1 ? "" : "s"}
            </Badge>
          )}
        </Stack>
      )}
      {post.post_type === "Poll" && post.poll_deadline && (
        <Group gap={4} wrap="nowrap">
          <IconChartBar size={14} stroke={1.75} aria-hidden="true" />
          <Text size="xs" c="dimmed">Poll closes {formatDate(post.poll_deadline)}</Text>
        </Group>
      )}
    </>
  );

  return (
    <Card withBorder padding="lg" className={detailPath ? "hoverable-card" : undefined}>
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <AuthorLink wallet={post.author_wallet} username={post.author_username} profileCid={post.author_profile_cid} size={18} />
            {detailPath ? (
              // Group/Stack aren't fully polymorphic (their `component` prop
              // doesn't widen the accepted props the way Card's does, so
              // `to` isn't a valid prop on them directly) - wrap in a
              // `display: contents` Link instead, which doesn't introduce
              // an extra box in the flex layout but still makes this area
              // clickable to the post (separate from AuthorLink above,
              // which navigates to the author's profile instead).
              <Link to={detailPath} style={{ ...linkStyle, display: "contents" }}>
                <Group gap={4}>{typeAndDate}</Group>
              </Link>
            ) : (
              <Group gap={4}>{typeAndDate}</Group>
            )}
          </Group>
          {post.flag_tally > 0 && (
            <Badge
              color="orange"
              variant="light"
              size="sm"
              leftSection={
                <IconFlag
                  size={12}
                  stroke={1.75}
                  color={colorScheme === "dark" ? darkModeInactiveIconColors.flag : undefined}
                  aria-hidden="true"
                />
              }
            >
              {post.flag_tally} flags
            </Badge>
          )}
        </Group>

        <CollapsedFlagged flagTally={post.flag_tally} userTally={userTally}>
          {detailPath ? (
            <Link to={detailPath} style={{ ...linkStyle, display: "contents" }}>
              <Stack gap="xs">{titleAndBody}</Stack>
            </Link>
          ) : (
            <Stack gap="xs">{titleAndBody}</Stack>
          )}
        </CollapsedFlagged>

        <Group gap="lg">
          <VoteControls
            targetType="post"
            targetId={post.post_id}
            upvotes={post.upvotes}
            downvotes={post.downvotes}
            initialVoteState={post.user_vote as -2 | -1 | 0 | 1}
          />
          <TipTotal userTippedWei={post.user_tipped_wei} />
        </Group>
      </Stack>
    </Card>
  );
}