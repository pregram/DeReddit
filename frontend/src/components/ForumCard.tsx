// The popularity score is only shown when the caller is actively sorting by
// it - otherwise it's a meaningless number next to a "newest" or "members"
// sorted list.

import { useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, Text, Group, Badge, Stack, Image } from "@mantine/core";
import { IconUsers, IconFileText, IconTrendingUp } from "@tabler/icons-react";
import type { ForumSummary } from "../lib/api";
import { ForumIcon } from "./ForumIcon";
import { gradientMeshBackground } from "../lib/gradientMesh";
import { ipfsGatewayUrl } from "../lib/ipfs";

interface ForumCardProps {
  forum: ForumSummary;
  /** The discovery/home page's currently active sort key, e.g. "score" | "members" | "newest". */
  activeSort?: string;
}

export function ForumCard({ forum, activeSort }: ForumCardProps) {
  const navigate = useNavigate();
  const [bannerFailed, setBannerFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  // Tags sit inside the whole-card Link to the forum, so they can't be their
  // own nested <a> - the HTML parser would auto-close the outer anchor as
  // soon as it hit a second one, silently breaking the card's click area.
  // `component="button"` keeps the tag a natively keyboard-operable control
  // (Enter/Space activation for free) without triggering that auto-close.
  const goToTag = (e: MouseEvent, tag: string) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/forums?tags=${encodeURIComponent(tag)}`);
  };

  return (
    <Card component={Link} to={`/f/${forum.forum_key}`} withBorder padding="lg" className="hoverable-card" style={{ textDecoration: "none" }}>
      <Card.Section
        h={90}
        style={{ position: "relative", background: forum.banner_cid && !bannerFailed ? undefined : gradientMeshBackground(forum.name) }}
      >
        {forum.banner_cid && !bannerFailed && (
          <Image
            src={ipfsGatewayUrl(forum.banner_cid)}
            alt=""
            h={90}
            w="100%"
            style={{ objectFit: "cover" }}
            onError={() => setBannerFailed(true)}
          />
        )}
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: -20,
            borderRadius: "50%",
            border: "3px solid var(--app-surface-1)",
            overflow: "hidden",
            background: "var(--app-surface-1)",
            lineHeight: 0,
          }}
        >
          {forum.icon_cid && !iconFailed ? (
            <Image
              src={ipfsGatewayUrl(forum.icon_cid)}
              alt=""
              w={40}
              h={40}
              style={{ objectFit: "cover" }}
              onError={() => setIconFailed(true)}
            />
          ) : (
            <ForumIcon name={forum.name} size={40} />
          )}
        </div>
      </Card.Section>
      <Stack gap="xs" pt={20}>
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} lineClamp={1} style={{ overflowWrap: "anywhere" }}>r/{forum.name}</Text>
          <Badge variant="light">{forum.category}</Badge>
        </Group>
        {forum.description && (
          <Text size="sm" c="dimmed" lineClamp={2} style={{ overflowWrap: "anywhere" }}>{forum.description}</Text>
        )}
        {forum.tags.length > 0 && (
          <Group gap="xs" wrap="wrap">
            {forum.tags.slice(0, 5).map((tag) => (
              <Badge
                key={tag}
                component="button"
                type="button"
                onClick={(e) => goToTag(e, tag)}
                size="xs"
                variant="outline"
                maw={140}
                style={{ overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer", textTransform: "none" }}
              >
                {tag}
              </Badge>
            ))}
          </Group>
        )}
        <Group gap="md">
          <Group gap={4} wrap="nowrap">
            <IconUsers size={14} stroke={1.75} aria-hidden="true" />
            <Text size="xs" c="dimmed" className="tabular-nums">{forum.member_count} members</Text>
          </Group>
          <Group gap={4} wrap="nowrap">
            <IconFileText size={14} stroke={1.75} aria-hidden="true" />
            <Text size="xs" c="dimmed" className="tabular-nums">{forum.post_count} posts</Text>
          </Group>
          {activeSort === "score" && forum.forum_popularity_score != null && (
            <Group gap={4} wrap="nowrap">
              <IconTrendingUp size={14} stroke={1.75} aria-hidden="true" />
              <Text size="xs" c="dimmed" className="tabular-nums">{forum.forum_popularity_score} score</Text>
            </Group>
          )}
        </Group>
      </Stack>
    </Card>
  );
}