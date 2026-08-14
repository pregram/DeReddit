// src/pages/CreatePostPage.tsx - Screen 6, two-step flow for Poll/Crowdfund.
//
// Step 1 (this page): upload the IPFS payload (poll choices, if any, live in
// the same JSON as before) and call createPost only.
//
// Step 2 (Poll/Crowdfund only): as soon as Step 1 confirms, a focused modal
// opens right here (instead of redirecting to the post detail page first)
// so the author finishes configurePoll/launchCrowdfund immediately, without
// leaving this screen. The actual on-chain call logic lives in
// usePostSetup, shared with PostDetailPage's "finish setup" retry banner -
// dismissing the modal (or navigating away) still leaves that banner as a
// fallback, so nothing is lost by skipping this step.
//
// TimeCapsule remains single-step (duration is passed directly into
// createPost, matching the contract - no separate configuration call exists
// for it).

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Stack, Title, TextInput, Textarea, SegmentedControl, NumberInput, Button,
  Alert, Paper, Group, ActionIcon, Text, Modal, FileInput, Image, SimpleGrid,
} from "@mantine/core";
import {
  IconFileText, IconClock, IconChartBar, IconMoneybag, IconX, IconPlus,
  IconRocket, IconReceipt2, IconPhoto,
} from "@tabler/icons-react";
import { useWallet } from "../context/WalletContext";
import { uploadJsonToIPFS, uploadFileToIPFS } from "../lib/ipfs";
import { ipfsCidToBytes32 } from "../lib/hash";
import { getCoreContract } from "../lib/contracts";
import { POST_TYPE_ENUM, type PostTypeKey } from "../lib/postType";
import { api } from "../lib/api";
import { useTransactions } from "../context/TransactionContext";
import { usePostSetup } from "../lib/usePostSetup";
import { useFilesPreview } from "../lib/useObjectUrl";
import { PollSetupForm } from "../components/PollSetupForm";
import { CrowdfundSetupForm } from "../components/CrowdfundSetupForm";
import { pollUntilReady } from "../lib/pollUntilReady";
import { notifyError, isAlreadyNotified } from "../lib/notify";

const DAY_SECONDS = 24 * 60 * 60;
// Keep in sync with MAX_POST_MEDIA in backend/src/indexer.ts - frontend and
// backend are separate packages with no shared module, so this cap is
// hand-mirrored on both sides.
const MAX_POST_MEDIA = 6;

export function CreatePostPage() {
  const { forumKey = "" } = useParams();
  const { address, signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();
  const navigate = useNavigate();

  const [forumName, setForumName] = useState<string>(forumKey);
  const [postType, setPostType] = useState<PostTypeKey>("Standard");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [timeCapsuleDays, setTimeCapsuleDays] = useState<number>(7);
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [pollOptionErrors, setPollOptionErrors] = useState<boolean[]>([]);
  const { files: mediaFiles, previews: mediaPreviews, setFiles: setMediaFiles } = useFilesPreview();

  const [submitting, setSubmitting] = useState(false);
  const [navigating, setNavigating] = useState(false);

  // Set once Step 1 confirms for a Poll/Crowdfund post - opens the Step 2
  // modal. createdPostIpfsCid is only needed for Poll (configurePoll reads
  // the option count back out of the same IPFS payload Step 1 uploaded).
  const [createdPostId, setCreatedPostId] = useState<string | null>(null);
  const [createdPostIpfsCid, setCreatedPostIpfsCid] = useState<string | null>(null);

  const { completePollSetup, completeCrowdfundSetup, busy: setupBusy } = usePostSetup(createdPostId ?? "");

  const needsTwoSteps = postType === "Poll" || postType === "Crowdfund";

  useEffect(() => {
    api.getForum(forumKey)
      .then((forum) => setForumName(forum.name))
      .catch(() => setForumName(forumKey));
  }, [forumKey]);

  // Warns on tab close/refresh/external navigation while the form has
  // unsaved input. Stops once `submitting` starts (matches the "you're free
  // to navigate away" copy below) or once step 1 has already confirmed
  // (createdPostId set - the post itself is safely created either way,
  // skipStep2's own copy says setup can be finished later).
  const isDirty =
    title.trim() !== "" || body.trim() !== "" || postType !== "Standard" ||
    pollOptions.some((o) => o.trim() !== "") || timeCapsuleDays !== 7 || mediaFiles.length > 0;
  useEffect(() => {
    if (!isDirty || submitting || createdPostId !== null) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty, submitting, createdPostId]);

  const updatePollOption = (index: number, value: string) => {
    setPollOptions((prev) => prev.map((opt, i) => (i === index ? value : opt)));
    setPollOptionErrors((prev) => prev.map((e, i) => (i === index ? false : e)));
  };
  const addPollOption = () => setPollOptions((prev) => (prev.length >= 100 ? prev : [...prev, ""]));
  const removePollOption = (index: number) => {
    setPollOptions((prev) => prev.filter((_, i) => i !== index));
    setPollOptionErrors((prev) => prev.filter((_, i) => i !== index));
  };

  const goToCreatedPost = async (postIdStr: string) => {
    setNavigating(true);
    // Note: the general feed filters unconfigured Poll/Crowdfund posts, but
    // direct-by-ID lookup (used here) always works, so this readiness poll
    // still succeeds as soon as the indexer has written the post row.
    await pollUntilReady(() => api.getPost(postIdStr));
    navigate(`/f/${forumKey}/p/${postIdStr}`);
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      notifyError("A title is required.");
      return;
    }
    if (postType === "Poll") {
      const trimmed = pollOptions.map((o) => o.trim());
      const blanks = trimmed.map((o) => o.length === 0);
      if (blanks.some(Boolean)) {
        setPollOptionErrors(blanks);
        notifyError("Fill in every poll option, or remove the empty ones.");
        return;
      }
      if (trimmed.length < 2) {
        notifyError("A poll needs at least 2 options.");
        return;
      }
      setPollOptionErrors([]);
    }
    if (!requireWallet("create this post") || !signer || !address) return;

    const coreContract = getCoreContract(signer);
    setSubmitting(true);
    try {
      const forumData = await api.getForum(forumKey, address);
      if (!forumData.is_member) {
        throw new Error("You must join this community before you can post.");
      }

      const imageCids = mediaFiles.length > 0
        ? await Promise.all(mediaFiles.map((f) => uploadFileToIPFS(f)))
        : undefined;

      const payload: Record<string, unknown> = { title: title.trim(), body: body.trim() || undefined, images: imageCids };
      if (postType === "Poll") {
        payload.pollChoices = pollOptions.map((o) => o.trim());
      }
      const cid = await uploadJsonToIPFS(payload);
      const ipfsCidBytes32 = ipfsCidToBytes32(cid);
      const durationSeconds = postType === "TimeCapsule" ? timeCapsuleDays * DAY_SECONDS : 0;

      const receipt = await trackTransaction({
        description: needsTwoSteps ? `Create ${postType.toLowerCase()} post (step 1 of 2)` : `Create ${postType.toLowerCase()} post`,
        contract: coreContract,
        send: () => coreContract.createPost(forumKey, ipfsCidBytes32, POST_TYPE_ENUM[postType], durationSeconds),
      });

      let postId: bigint | null = null;
      for (const log of receipt.logs) {
        try {
          const parsed = coreContract.interface.parseLog(log);
          if (parsed?.name === "PostCreated") {
            postId = parsed.args.postId as bigint;
            break;
          }
        } catch {
          // not one of this contract's events - ignore
        }
      }
      if (postId === null) {
        throw new Error("Post created, but could not read the new post ID from the transaction receipt.");
      }

      const postIdStr = String(postId);
      if (needsTwoSteps) {
        setCreatedPostId(postIdStr);
        setCreatedPostIpfsCid(ipfsCidBytes32);
      } else {
        await goToCreatedPost(postIdStr);
      }
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Failed to create post.");
    } finally {
      setSubmitting(false);
      setNavigating(false);
    }
  };

  const handleStep2PollSubmit = async (days: number) => {
    if (!createdPostId || !createdPostIpfsCid) return;
    const ok = await completePollSetup(days, createdPostIpfsCid);
    if (ok) await goToCreatedPost(createdPostId);
  };

  const handleStep2CrowdfundSubmit = async (goalEth: number, days: number) => {
    if (!createdPostId) return;
    const ok = await completeCrowdfundSetup(goalEth, days);
    if (ok) await goToCreatedPost(createdPostId);
  };

  const skipStep2 = () => {
    if (!createdPostId) return;
    navigate(`/f/${forumKey}/p/${createdPostId}`);
  };

  return (
    <Stack gap="lg" py="md" maw={720}>
      <Group gap={8}>
        <IconFileText size={26} stroke={1.75} aria-hidden="true" />
        <Title order={1}>Create Post in r/{forumName}</Title>
      </Group>

      <Paper withBorder p="lg">
        <Stack gap="md">
          <SegmentedControl
            fullWidth
            value={postType}
            onChange={(value) => setPostType(value as PostTypeKey)}
            data={[
              { label: "Standard", value: "Standard" },
              { label: "Poll", value: "Poll" },
              { label: "Crowdfund", value: "Crowdfund" },
              { label: "Time Capsule", value: "TimeCapsule" },
            ]}
          />

          <TextInput label="Title" placeholder="A precise, descriptive headline" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={300} required />
          <Textarea label="Body" placeholder="Optional text content…" value={body} onChange={(e) => setBody(e.currentTarget.value)} minRows={4} />

          <Stack gap={4}>
            <FileInput
              label="Images"
              description={`Optional - up to ${MAX_POST_MEDIA} images.`}
              placeholder="Choose images"
              accept="image/*"
              multiple
              value={mediaFiles}
              onChange={(files) => setMediaFiles(files.slice(0, MAX_POST_MEDIA))}
              leftSection={<IconPhoto size={16} stroke={1.75} aria-hidden="true" />}
              clearable
            />
            {mediaPreviews.length > 0 && (
              <SimpleGrid cols={{ base: 3, xs: 6 }} spacing="xs">
                {mediaPreviews.map((src, i) => (
                  <Image key={i} src={src} alt="" h={64} radius="sm" style={{ objectFit: "cover" }} />
                ))}
              </SimpleGrid>
            )}
          </Stack>

          {postType === "TimeCapsule" && (
            <Paper withBorder p="md">
              <Stack gap="xs">
                <Group gap={6}>
                  <IconClock size={16} stroke={1.75} aria-hidden="true" />
                  <Text fw={500} size="sm">Time Capsule Settings</Text>
                </Group>
                <NumberInput
                  label="Reveal after (days)"
                  value={timeCapsuleDays}
                  onChange={(v) => setTimeCapsuleDays(typeof v === "number" ? v : 1)}
                  min={1}
                />
                <Text size="xs" c="dimmed">
                  Content stays unencrypted on-chain, but this app hides it - both visually and in its own
                  API responses - until the reveal date passes.
                </Text>
              </Stack>
            </Paper>
          )}

          {postType === "Poll" && (
            <Paper withBorder p="md">
              <Stack gap="xs">
                <Group gap={6}>
                  <IconChartBar size={16} stroke={1.75} aria-hidden="true" />
                  <Text fw={500} size="sm">Poll Options</Text>
                </Group>
                <Stack gap="xs">
                  {pollOptions.map((option, index) => (
                    <Group key={index} gap="xs" align="flex-start">
                      <TextInput
                        style={{ flex: 1 }}
                        placeholder={`Option ${index + 1}`}
                        value={option}
                        onChange={(e) => updatePollOption(index, e.currentTarget.value)}
                        error={pollOptionErrors[index] ? "This option can't be empty" : undefined}
                        maxLength={280}
                      />
                      {pollOptions.length > 2 && (
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          onClick={() => removePollOption(index)}
                          mt={4}
                          aria-label={`Remove option ${index + 1}`}
                        >
                          <IconX size={16} stroke={1.75} aria-hidden="true" />
                        </ActionIcon>
                      )}
                    </Group>
                  ))}
                </Stack>
                <Button
                  variant="light"
                  size="xs"
                  onClick={addPollOption}
                  disabled={pollOptions.length >= 100}
                  leftSection={<IconPlus size={14} stroke={1.75} aria-hidden="true" />}
                >
                  Add Option
                </Button>
                <Text size="xs" c="dimmed">
                  Voting duration is set in step 2, right after this post is created - a focused setup
                  step opens automatically once step 1 confirms.
                </Text>
              </Stack>
            </Paper>
          )}

          {postType === "Crowdfund" && (
            <Paper withBorder p="md">
              <Group gap={6} wrap="nowrap" align="flex-start">
                <IconMoneybag size={16} stroke={1.75} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
                <Text size="sm" c="dimmed">
                  The funding goal and campaign duration are set in step 2, right after this post is
                  created - a focused setup step opens automatically once step 1 confirms.
                </Text>
              </Group>
            </Paper>
          )}

          {navigating && <Alert color="blue">Confirmed! Opening your new post...</Alert>}

          <Button onClick={handleSubmit} loading={submitting} size="md" leftSection={<IconRocket size={16} stroke={1.75} aria-hidden="true" />}>
            {needsTwoSteps ? "Create Post (Step 1 of 2)" : "Broadcast Transaction"}
          </Button>
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed">Once signed, check the</Text>
            <IconReceipt2 size={14} stroke={1.75} color="var(--mantine-color-dimmed)" aria-hidden="true" />
            <Text size="xs" c="dimmed">tray in the header for progress - you're free to navigate away.</Text>
          </Group>
        </Stack>
      </Paper>

      <Modal
        opened={createdPostId !== null}
        onClose={skipStep2}
        closeOnClickOutside={false}
        title={
          <Group gap={6}>
            {postType === "Poll" ? (
              <IconChartBar size={18} stroke={1.75} aria-hidden="true" />
            ) : (
              <IconMoneybag size={18} stroke={1.75} aria-hidden="true" />
            )}
            <Text fw={600}>{postType === "Poll" ? "Finish Setting Up Your Poll" : "Launch Your Crowdfund"}</Text>
          </Group>
        }
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Step 1 is confirmed! Finish setup now, or skip and finish later from the post's page.
          </Text>
          {postType === "Poll" ? (
            <PollSetupForm onSubmit={handleStep2PollSubmit} busy={setupBusy} submitLabel="Complete Setup & View Post" />
          ) : (
            <CrowdfundSetupForm onSubmit={handleStep2CrowdfundSubmit} busy={setupBusy} submitLabel="Launch & View Post" />
          )}
          {navigating && <Alert color="blue">Confirmed! Opening your new post...</Alert>}
          <Button variant="subtle" size="xs" onClick={skipStep2}>Skip for now</Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
