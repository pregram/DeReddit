// src/pages/UserProfilePage.tsx - see USER_GUIDE.md for the registration/
// tipping UX. Registration routes through the transaction tray.

import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Stack, Title, Text, Group, Badge, Button, Paper, Loader, Alert,
  TextInput, Tabs, Slider, Tooltip, FileInput,
} from "@mantine/core";
import {
  IconTrendingUp, IconBuildingCommunity, IconFileText, IconMessageCircle,
  IconMedal, IconBolt, IconMoneybag, IconInfoCircle, IconAlertTriangle, IconPhoto,
} from "@tabler/icons-react";
import {
  api, type UserProfile, type BadgeSummary, type ForumSummary,
  type UserPostSummary, type UserCommentSummary, type ContributionSummary,
} from "../lib/api";
import { useWallet } from "../context/WalletContext";
import { coreContractReadOnly } from "../lib/readProvider";
import { getCoreContract } from "../lib/contracts";
import { encodeUsernameBytes32, ipfsCidToBytes32, ZERO_BYTES32 } from "../lib/hash";
import { uploadFileToIPFS } from "../lib/ipfs";
import { UserAvatar } from "../components/UserAvatar";
import { TipButton } from "../components/TipButton";
import { useFlagTolerance } from "../lib/flagTolerance";
import { truncateAddress, formatDate, weiToEth } from "../lib/format";
import { useTransactions } from "../context/TransactionContext";
import { notifyError, isAlreadyNotified } from "../lib/notify";

export function UserProfilePage() {
  const { wallet = "" } = useParams();
  const { address, signer, requireWallet } = useWallet();
  const { trackTransaction, onAnyConfirmed } = useTransactions();
  const [userTally, setUserTally] = useFlagTolerance();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [badges, setBadges] = useState<BadgeSummary[]>([]);
  const [forums, setForums] = useState<ForumSummary[]>([]);
  const [posts, setPosts] = useState<UserPostSummary[]>([]);
  const [comments, setComments] = useState<UserCommentSummary[]>([]);
  const [contributions, setContributions] = useState<ContributionSummary[]>([]);
  const [tipsReceivedWei, setTipsReceivedWei] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [registering, setRegistering] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [avatarDraft, setAvatarDraft] = useState<File | null>(null);
  const [regBusy, setRegBusy] = useState(false);

  const [changingAvatar, setChangingAvatar] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const isOwnProfile = address?.toLowerCase() === wallet.toLowerCase();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getUser(wallet)
      .then((userData) => {
        setProfile(userData.user);
        setBadges(userData.badges);
        setForums(userData.forums);
      })
      .catch((err) => {
        // Graceful 404: a wallet with zero on-chain activity the indexer
        // has ever seen isn't an error state - it's just a brand-new
        // account. Synthesize a stub profile instead of showing a crash.
        const isNotFound = err instanceof Error && err.message.toLowerCase().includes("not found");
        if (isNotFound) {
          setProfile({
            wallet_address: wallet.toLowerCase(),
            username: null,
            karma: "0",
            profile_cid: null,
            joined_at: new Date().toISOString(),
            post_count: 0,
            comment_count: 0,
            forum_count: 0,
            total_tips_received_wei: "0",
            total_tips_given_wei: "0",
          });
          setBadges([]);
          setForums([]);
        } else {
          setError(err instanceof Error ? err.message : "Failed to load profile");
        }
      })
      .finally(() => setLoading(false));

    // These can legitimately 404/empty independent of the user row existing
    // - keep them best-effort, not blocking.
    api.getUserPosts(wallet).then((d) => setPosts(d.posts)).catch(() => setPosts([]));
    api.getUserComments(wallet).then((d) => setComments(d.comments)).catch(() => setComments([]));
    api.getUserContributions(wallet).then((d) => setContributions(d.contributions)).catch(() => setContributions([]));

    // Viewer-specific: how much the connected wallet has tipped *this*
    // profile. Only meaningful when a different wallet is connected and
    // viewing someone else's profile.
    if (address && address.toLowerCase() !== wallet.toLowerCase()) {
      api.getTipsReceived(wallet, address).then((d) => setTipsReceivedWei(d.totalWei)).catch(() => setTipsReceivedWei(null));
    } else {
      setTipsReceivedWei(null);
    }
  }, [wallet, address]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { load(); }, [load]);

  // Any confirmed transaction (including this page's own username
  // registration) refetches the profile after the indexer-catchup window
  // TransactionContext already waits out - mirrors WalletTxBridge.tsx's
  // navbar-refresh wiring, so this page's own display no longer races the
  // indexer the way an immediate post-confirm load() call used to.
  useEffect(() => onAnyConfirmed(load), [onAnyConfirmed, load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const submitUsername = async () => {
    const trimmed = usernameDraft.trim();
    if (!trimmed) {
      notifyError("Username cannot be empty.");
      return;
    }
    if (!requireWallet("register this username") || !signer) return;

    let usernameBytes32: string;
    try {
      usernameBytes32 = encodeUsernameBytes32(trimmed);
    } catch {
      notifyError("Username is too long (max 31 characters).");
      return;
    }

    const contract = getCoreContract(signer);
    setRegBusy(true);
    try {
      const exists = (await coreContractReadOnly.usernameExists(usernameBytes32)) as boolean;
      if (exists) {
        notifyError("That username is already taken.");
        return;
      }
      const profileCIDBytes32 = avatarDraft
        ? ipfsCidToBytes32(await uploadFileToIPFS(avatarDraft))
        : ZERO_BYTES32;
      await trackTransaction({
        description: `Register username "${trimmed}"`,
        contract,
        send: () => contract.registerIdentity(usernameBytes32, profileCIDBytes32),
      });
      setRegistering(false);
      // No immediate load() here - the onAnyConfirmed subscription above
      // refetches once the indexer has actually caught up.
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setRegBusy(false);
    }
  };

  const submitAvatarChange = async () => {
    if (!avatarFile) {
      notifyError("Choose an image first.");
      return;
    }
    if (!requireWallet("change your avatar") || !signer) return;

    const contract = getCoreContract(signer);
    setAvatarBusy(true);
    try {
      const cid = await uploadFileToIPFS(avatarFile);
      const profileCIDBytes32 = ipfsCidToBytes32(cid);
      await trackTransaction({
        description: "Update profile avatar",
        contract,
        send: () => contract.updateProfileCID(profileCIDBytes32),
      });
      setChangingAvatar(false);
      setAvatarFile(null);
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Avatar update failed.");
    } finally {
      setAvatarBusy(false);
    }
  };

  if (loading) return <Group justify="center" py="xl"><Loader size="sm" /></Group>;
  if (error && !profile) {
    return (
      <Alert color="red" icon={<IconAlertTriangle size={18} stroke={1.75} aria-hidden="true" />}>
        <Stack gap="sm">
          <Text>{error}</Text>
          <Button component={Link} to="/forums" variant="light" size="xs" style={{ alignSelf: "flex-start" }}>
            Browse Forums
          </Button>
        </Stack>
      </Alert>
    );
  }
  if (!profile) return null;

  return (
    <Stack gap="lg" py="md">
      <Paper withBorder p="lg">
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <UserAvatar wallet={profile.wallet_address} profileCid={profile.profile_cid} size={56} />
            <Stack gap={2}>
              <Title order={2} style={{ overflowWrap: "anywhere" }}>{profile.username ? `u/${profile.username}` : truncateAddress(profile.wallet_address)}</Title>
              <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{profile.wallet_address}</Text>
              <Group gap={4} wrap="nowrap">
                <IconTrendingUp size={14} stroke={1.75} aria-hidden="true" />
                <Text size="sm" className="tabular-nums">{profile.karma} karma</Text>
                <Tooltip
                  label="Karma is earned when others upvote your content. Higher karma gives your flags more weight in community moderation."
                  multiline
                  w={260}
                  withArrow
                >
                  <IconInfoCircle size={14} stroke={1.75} style={{ color: "var(--mantine-color-dimmed)", cursor: "help" }} aria-hidden="true" />
                </Tooltip>
              </Group>
              <Text size="xs" c="dimmed">Joined {formatDate(profile.joined_at)}</Text>
            </Stack>
          </Group>
          {!isOwnProfile && (
            <Stack gap={4} align="flex-end">
              <TipButton
                target={{ type: "direct", wallet: profile.wallet_address }}
                label="Tip this user"
                recipientWallet={profile.wallet_address}
                recipientUsername={profile.username}
                recipientProfileCid={profile.profile_cid}
              />
              {tipsReceivedWei !== null && Number(tipsReceivedWei) > 0 && (
                <Text size="xs" c="dimmed">You've tipped {weiToEth(tipsReceivedWei)} ETH to this user</Text>
              )}
            </Stack>
          )}
        </Group>

        <Group gap="lg" mt="md">
          <Group gap={4} wrap="nowrap">
            <IconBuildingCommunity size={14} stroke={1.75} aria-hidden="true" />
            <Text size="sm" c="dimmed" className="tabular-nums">{profile.forum_count} forums founded</Text>
          </Group>
          <Group gap={4} wrap="nowrap">
            <IconFileText size={14} stroke={1.75} aria-hidden="true" />
            <Text size="sm" c="dimmed" className="tabular-nums">{profile.post_count} posts</Text>
          </Group>
          <Group gap={4} wrap="nowrap">
            <IconMessageCircle size={14} stroke={1.75} aria-hidden="true" />
            <Text size="sm" c="dimmed" className="tabular-nums">{profile.comment_count} comments</Text>
          </Group>
          {isOwnProfile && (
            <>
              <Group gap={4} wrap="nowrap">
                <IconBolt size={14} stroke={1.75} aria-hidden="true" />
                <Text size="sm" c="dimmed" className="tabular-nums">{weiToEth(profile.total_tips_received_wei)} ETH received</Text>
              </Group>
              <Group gap={4} wrap="nowrap">
                <IconBolt size={14} stroke={1.75} aria-hidden="true" />
                <Text size="sm" c="dimmed" className="tabular-nums">{weiToEth(profile.total_tips_given_wei)} ETH given</Text>
              </Group>
            </>
          )}
        </Group>

        {isOwnProfile && !profile.username && (
          <Stack gap="xs" mt="md">
            {!registering ? (
              <Button size="xs" variant="light" onClick={() => setRegistering(true)}>Set Username & Avatar</Button>
            ) : (
              <Stack gap="xs" maw={360}>
                <Group align="flex-end" gap="xs">
                  <TextInput
                    label="Username"
                    placeholder="up to 31 characters"
                    value={usernameDraft}
                    maxLength={31}
                    onChange={(e) => setUsernameDraft(e.currentTarget.value)}
                  />
                </Group>
                <FileInput
                  label="Avatar"
                  description="Optional - falls back to a generated icon."
                  placeholder="Choose an image"
                  accept="image/*"
                  value={avatarDraft}
                  onChange={setAvatarDraft}
                  leftSection={<IconPhoto size={16} stroke={1.75} aria-hidden="true" />}
                  clearable
                />
                <Group gap="xs">
                  <Button size="xs" onClick={submitUsername} loading={regBusy}>Register</Button>
                  <Button size="xs" variant="subtle" onClick={() => setRegistering(false)}>Cancel</Button>
                </Group>
              </Stack>
            )}
          </Stack>
        )}

        {isOwnProfile && profile.username && (
          <Stack gap="xs" mt="md">
            {!changingAvatar ? (
              <Button size="xs" variant="light" onClick={() => setChangingAvatar(true)}>Change avatar</Button>
            ) : (
              <Group align="flex-end" gap="xs">
                <FileInput
                  label="New avatar"
                  placeholder="Choose an image"
                  accept="image/*"
                  value={avatarFile}
                  onChange={setAvatarFile}
                  leftSection={<IconPhoto size={16} stroke={1.75} aria-hidden="true" />}
                  clearable
                />
                <Button size="xs" onClick={submitAvatarChange} loading={avatarBusy}>Save</Button>
                <Button size="xs" variant="subtle" onClick={() => { setChangingAvatar(false); setAvatarFile(null); }}>Cancel</Button>
              </Group>
            )}
          </Stack>
        )}
      </Paper>

      {isOwnProfile && (
        <Paper withBorder p="lg">
          <Stack gap="xs">
            <Text fw={500} size="sm">Preferences</Text>
            <Text size="xs" c="dimmed">
              Hide posts/comments flagged above this tolerance. Stored only on this device.
            </Text>
            <Group gap="md" align="center">
              <Slider style={{ flex: 1 }} min={0} max={200} value={userTally} onChange={setUserTally} label={(v) => `${v} flags`} />
              <Text size="sm" w={70}>{userTally} flags</Text>
            </Group>
          </Stack>
        </Paper>
      )}

      {badges.length > 0 && (
        <Paper withBorder p="lg">
          <Group gap={6} mb="sm">
            <IconMedal size={16} stroke={1.75} aria-hidden="true" />
            <Text fw={500}>Badges</Text>
          </Group>
          <Group gap="xs">
            {badges.map((b) => (
              <Tooltip key={b.badge_key} label={b.description} multiline w={260} withArrow>
                <Badge variant="light" size="lg">{b.name}</Badge>
              </Tooltip>
            ))}
          </Group>
        </Paper>
      )}

      {forums.length > 0 && (
        <Paper withBorder p="lg">
          <Text fw={500} mb="sm">Joined Forums</Text>
          <Group gap="xs">
            {forums.map((f) => (
              <Link key={f.forum_key} to={`/f/${f.forum_key}`} style={{ textDecoration: "none" }}>
                <Badge variant="outline">r/{f.name}</Badge>
              </Link>
            ))}
          </Group>
        </Paper>
      )}

      <Tabs defaultValue="posts">
        <Tabs.List>
          <Tabs.Tab value="posts" leftSection={<IconFileText size={16} stroke={1.75} aria-hidden="true" />}>Posts ({posts.length})</Tabs.Tab>
          <Tabs.Tab value="comments" leftSection={<IconMessageCircle size={16} stroke={1.75} aria-hidden="true" />}>Comments ({comments.length})</Tabs.Tab>
          <Tabs.Tab value="contributions" leftSection={<IconMoneybag size={16} stroke={1.75} aria-hidden="true" />}>Contributions ({contributions.length})</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="posts" pt="md">
          <Stack gap="xs">
            {posts.length === 0 && <Text c="dimmed" size="sm">No posts yet.</Text>}
            {posts.map((p) => (
              <Link
                key={p.post_id}
                to={`/f/${p.forum_key}/p/${p.post_id}`}
                style={{ textDecoration: "none", color: "inherit", display: "block" }}
              >
                <Paper withBorder p="sm">
                  <Text size="sm" fw={500} lineClamp={2} style={{ overflowWrap: "anywhere" }}>{p.title ?? "(hidden until reveal)"}</Text>
                  <Group gap={4} wrap="nowrap">
                    <Text size="xs" c="dimmed">r/{p.forum_name} • {p.post_type} •</Text>
                    <IconTrendingUp size={12} stroke={1.75} color="var(--mantine-color-dimmed)" aria-hidden="true" />
                    <Text size="xs" c="dimmed" className="tabular-nums">{p.upvotes - p.downvotes} pts • {formatDate(p.created_at)}</Text>
                  </Group>
                </Paper>
              </Link>
            ))}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="comments" pt="md">
          <Stack gap="xs">
            {comments.length === 0 && <Text c="dimmed" size="sm">No comments yet.</Text>}
            {comments.map((c) => (
              <Link
                key={c.comment_id}
                to={`/f/${c.forum_key}/p/${c.post_id}`}
                style={{ textDecoration: "none", color: "inherit", display: "block" }}
              >
                <Paper withBorder p="sm">
                  <Text size="sm" lineClamp={2} style={{ overflowWrap: "anywhere" }}>{c.body}</Text>
                  <Text size="xs" c="dimmed">on "{c.post_title ?? "(hidden until reveal)"}" • {formatDate(c.created_at)}</Text>
                </Paper>
              </Link>
            ))}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="contributions" pt="md">
          <Stack gap="xs">
            {contributions.length === 0 && <Text c="dimmed" size="sm">No contributions yet.</Text>}
            {contributions.map((c) => (
              <Link
                key={c.post_id}
                to={`/f/${c.forum_key}/p/${c.post_id}`}
                style={{ textDecoration: "none", color: "inherit", display: "block" }}
              >
                <Paper withBorder p="sm">
                  <Text size="sm" fw={500} lineClamp={2} style={{ overflowWrap: "anywhere" }}>{c.post_title ?? "(untitled)"}</Text>
                  <Text size="xs" c="dimmed">
                    Backed {weiToEth(c.amount_wei)} ETH • Campaign raised {weiToEth(c.cf_funds_raised ?? "0")} / {weiToEth(c.cf_target_goal ?? "0")} ETH
                  </Text>
                </Paper>
              </Link>
            ))}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}