// src/pages/HomePage.tsx - Landing page. The backend has no cross-forum
// "global post feed" endpoint (only per-forum post listing exists), so this
// intentionally surfaces recommended/top communities rather than faking a
// global feed - Screen 3's discovery flow is one click away.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Stack, Title, Text, SimpleGrid, Button, Group, Loader, Alert } from "@mantine/core";
import { IconSearch, IconRocket, IconFlame, IconSparkles } from "@tabler/icons-react";
import { api, type ForumSummary } from "../lib/api";
import { ForumCard } from "../components/ForumCard";
import { useWallet } from "../context/WalletContext";

export function HomePage() {
  const { address } = useWallet();
  const [byScore, setByScore] = useState<ForumSummary[]>([]);
  const [byTagOverlap, setByTagOverlap] = useState<ForumSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setLoading(true);
    api
      .getRecommendedForums(address ?? undefined)
      .then((data) => {
        if (cancelled) return;
        setByScore(data.byScore);
        setByTagOverlap(data.byTagOverlap);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [address]);

  return (
    <Stack gap="xl" py="md">
      <Stack gap="xs">
        <Title order={1}>Welcome to DeReddit</Title>
        <Text c="dimmed" maw={640}>
          A decentralized forum. Every post, comment, and vote lives on-chain and on IPFS - this site is
          just a fast, auditable mirror of it.
        </Text>
        <Group mt="xs">
          <Button component={Link} to="/forums" leftSection={<IconSearch size={16} stroke={1.75} aria-hidden="true" />}>
            Discover Communities
          </Button>
          <Button component={Link} to="/forums/new" variant="light" leftSection={<IconRocket size={16} stroke={1.75} aria-hidden="true" />}>
            Create a Forum
          </Button>
        </Group>
      </Stack>

      {loading && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
      {error && <Alert color="red" role="alert">{error}</Alert>}

      {!loading && !error && (
        <>
          <Stack gap="sm">
            <Group gap={8}>
              <IconFlame size={22} stroke={1.75} color="var(--mantine-color-accent-6)" aria-hidden="true" />
              <Title order={2}>Top Communities by Engagement</Title>
            </Group>
            {byScore.length === 0 ? (
              <Text c="dimmed" size="sm">No forums yet - be the first to create one.</Text>
            ) : (
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
                {byScore.map((forum) => <ForumCard key={forum.forum_key} forum={forum} activeSort="score" />)}
              </SimpleGrid>
            )}
          </Stack>

          {address && byTagOverlap.length > 0 && (
            <Stack gap="sm">
              <Group gap={8}>
                <IconSparkles size={22} stroke={1.75} color="var(--mantine-color-accent-6)" aria-hidden="true" />
                <Title order={2}>Because You're In Similar Communities</Title>
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
                {byTagOverlap.map((forum) => <ForumCard key={forum.forum_key} forum={forum} />)}
              </SimpleGrid>
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}