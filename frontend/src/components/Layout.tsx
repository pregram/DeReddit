import { Link, Outlet, useLocation } from "react-router-dom";
import { AppShell, Burger, Group, Button, Text, Badge, Container, Modal, Drawer, Stack, Alert, ActionIcon, Skeleton, useMantineColorScheme } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconSun, IconMoonStars, IconWallet, IconInfoCircle, IconLock } from "@tabler/icons-react";
import { useWallet } from "../context/WalletContext";
import { truncateAddress } from "../lib/format";
import { TransactionTray } from "./TransactionTray";
import { NotificationBell } from "./NotificationBell";
import { UserAvatar } from "./UserAvatar";

export function Layout() {
  const { address, profile, connecting, initializing, error, connect, showInterceptor, interceptorReason, dismissInterceptor } = useWallet();
  const location = useLocation();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);

  return (
    <AppShell header={{ height: { base: 104, "500px": 64 } }} padding="md">
      <AppShell.Header>
        <Container size="lg" h="100%">
          <Group h="100%" justify="space-between">
            <Group gap="xl">
              <Burger opened={navOpened} onClick={toggleNav} hiddenFrom="sm" size="sm" aria-label="Toggle navigation menu" />
              <Link to="/" style={{ textDecoration: "none", display: "contents" }}>
                <Group gap={8} wrap="nowrap">
                  <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={24} height={23} />
                  <Text fw={700} size="lg" c="var(--mantine-color-text)">DeReddit</Text>
                </Group>
              </Link>
              <Group gap="xl" visibleFrom="sm">
                <Button component={Link} to="/forums" variant="subtle" size="sm">Discover</Button>
                <Button component={Link} to="/forums/new" variant="subtle" size="sm">Create Forum</Button>
              </Group>
            </Group>
            <Group>
              <ActionIcon variant="light" size="lg" aria-label="Toggle color scheme" onClick={toggleColorScheme}>
                {colorScheme === "dark" ? (
                  <IconSun size={18} stroke={1.75} aria-hidden="true" />
                ) : (
                  <IconMoonStars size={18} stroke={1.75} aria-hidden="true" />
                )}
              </ActionIcon>
              <TransactionTray />
              {address && <NotificationBell />}
              {address ? (
                <Button
                  component={Link}
                  to={`/u/${address}`}
                  variant="light"
                  leftSection={<UserAvatar wallet={address} profileCid={profile?.profile_cid} size={20} />}
                >
                  {profile?.username ? `u/${profile.username}` : truncateAddress(address)}
                  {profile ? <Badge ml="xs" size="sm" variant="outline">{profile.karma} karma</Badge> : null}
                </Button>
              ) : (
                <Button onClick={connect} loading={connecting} variant="filled" leftSection={<IconWallet size={16} stroke={1.75} aria-hidden="true" />}>
                  Connect Wallet
                </Button>
              )}
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <Drawer opened={navOpened} onClose={closeNav} title="Menu" hiddenFrom="sm" size="xs">
        <Stack gap="xs">
          <Button component={Link} to="/forums" variant="subtle" fullWidth onClick={closeNav}>Discover</Button>
          <Button component={Link} to="/forums/new" variant="subtle" fullWidth onClick={closeNav}>Create Forum</Button>
        </Stack>
      </Drawer>

      <AppShell.Main>
        <Container size="lg">
          {initializing ? (
            <Skeleton height={20} width={220} mb="md" radius="sm" />
          ) : (
            !address && (
              <Alert color="yellow" mb="md" variant="light" icon={<IconInfoCircle size={18} stroke={1.75} aria-hidden="true" />}>
                Read-only mode: connect a wallet to join forums, post, vote, or tip.
              </Alert>
            )
          )}
          {error && <Alert color="red" mb="md">{error}</Alert>}
          <Outlet key={location.pathname} />
        </Container>
      </AppShell.Main>

      <Modal
        opened={showInterceptor}
        onClose={dismissInterceptor}
        title={
          <Group gap={6}>
            <IconLock size={18} stroke={1.75} aria-hidden="true" />
            <Text fw={600}>Transaction Signature Required</Text>
          </Group>
        }
        centered
      >
        <Stack>
          <Text size="sm">
            {interceptorReason
              ? `Connect your wallet to ${interceptorReason}.`
              : "You must connect your cryptographic wallet and sign in to perform this action."}
          </Text>
          <Button onClick={connect} loading={connecting} leftSection={<IconWallet size={16} stroke={1.75} aria-hidden="true" />}>
            Connect Wallet
          </Button>
          <Text size="xs" c="dimmed">
            DeReddit is serverless and identity-free. Your wallet address acts as your unique on-chain
            identity. Reading content is free; write actions require gas.
          </Text>
          <Button variant="subtle" onClick={dismissInterceptor}>Dismiss, keep browsing read-only</Button>
        </Stack>
      </Modal>
    </AppShell>
  );
}