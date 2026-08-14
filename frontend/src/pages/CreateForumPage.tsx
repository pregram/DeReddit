// src/pages/CreateForumPage.tsx - Screen 4: upload forum metadata to IPFS,
// then call createForum(keccak256(name), minKarmaToFlag, ipfsCidBytes32).
// The transaction is also tracked via the global transaction tray, but the
// local "uploading" button spinner stays on for the whole IPFS upload +
// sign + confirm sequence too (mirrors CreatePostPage.tsx's `submitting`),
// so the button the user just clicked keeps giving feedback the entire time
// instead of going dark right after the IPFS upload finishes.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stack, Title, TextInput, Textarea, Select, NumberInput, Button, Alert, Paper, Text, Group, FileInput, Image } from "@mantine/core";
import { IconRocket, IconReceipt2, IconPhoto } from "@tabler/icons-react";
import { TagInput } from "../components/TagInput";
import { useWallet } from "../context/WalletContext";
import { uploadJsonToIPFS, uploadFileToIPFS } from "../lib/ipfs";
import { getCoreContract } from "../lib/contracts";
import { keccak256Utf8, ipfsCidToBytes32 } from "../lib/hash";
import { useFilePreview } from "../lib/useObjectUrl";
import { useTransactions } from "../context/TransactionContext";
import { api } from "../lib/api";
import { pollUntilReady } from "../lib/pollUntilReady";
import { notifyError, isAlreadyNotified } from "../lib/notify";

const CATEGORIES = ["Technology", "Gaming", "Science", "Art", "Music", "Sports", "Finance", "General"];

export function CreateForumPage() {
  const { signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("General");
  const [tags, setTags] = useState<string[]>([]);
  const [rules, setRules] = useState("");
  const [minKarma, setMinKarma] = useState<number>(0);
  const { file: iconFile, preview: iconPreview, setFile: setIconFile } = useFilePreview();
  const { file: bannerFile, preview: bannerPreview, setFile: setBannerFile } = useFilePreview();

  const [uploading, setUploading] = useState(false);
  const [navigating, setNavigating] = useState(false);


  // Warns on tab close/refresh/external navigation while the form has
  // unsaved input. Stops warning once `uploading` starts (covers the whole
  // IPFS-upload + sign + confirm flow) - at that point the submission is
  // already committed and the transaction tray copy below explicitly tells
  // the user it's safe to navigate away.
  const isDirty =
    name.trim() !== "" || description.trim() !== "" || tags.length > 0 || rules.trim() !== "" || minKarma !== 0;
  useEffect(() => {
    if (!isDirty || uploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty, uploading]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      notifyError("A forum name is required.");
      return;
    }
    if (!requireWallet("create this forum") || !signer) return;

    const contract = getCoreContract(signer);
    setUploading(true);
    try {
      const [iconCid, bannerCid] = await Promise.all([
        iconFile ? uploadFileToIPFS(iconFile) : Promise.resolve(undefined),
        bannerFile ? uploadFileToIPFS(bannerFile) : Promise.resolve(undefined),
      ]);
      const cid = await uploadJsonToIPFS({
        name: name.trim(),
        description: description.trim() || undefined,
        category,
        rules: rules.trim() || undefined,
        tags,
        iconCid,
        bannerCid,
      });
      const forumKey = keccak256Utf8(name.trim());
      const ipfsCidBytes32 = ipfsCidToBytes32(cid);

      await trackTransaction({
        description: `Create forum "${name.trim()}"`,
        contract,
        send: () => contract.createForum(forumKey, BigInt(minKarma), ipfsCidBytes32),
      });

      // Bridge the "confirmed on-chain" -> "indexer has written it" gap with
      // a real readiness poll instead of a fixed delay.
      setNavigating(true);
      await pollUntilReady(() => api.getForum(forumKey));
      navigate(`/f/${forumKey}`);
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Failed to create forum.");
    } finally {
      setUploading(false);
      setNavigating(false);
    }
  };

  return (
    <Stack gap="lg" py="md" maw={720}>
      <Group gap={8}>
        <IconRocket size={26} stroke={1.75} aria-hidden="true" />
        <Title order={1}>Deploy a New Community</Title>
      </Group>

      <Paper withBorder p="lg">
        <Stack gap="md">
          <TextInput
            label="Community Handle"
            description="Immutable on-chain identifier - cannot be changed later."
            placeholder="SolidityDevs…"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={100}
            required
          />
          <Textarea
            label="Description"
            placeholder="What is this community about?"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            minRows={3}
          />
          <Select
            label="Category"
            data={CATEGORIES}
            value={category}
            onChange={(value) => setCategory(value ?? "General")}
            allowDeselect={false}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>Tags</Text>
            <Text size="xs" c="dimmed">Up to 10 tags. Letters, numbers, '_' and '-' only - no commas.</Text>
            <TagInput value={tags} onChange={setTags} max={10} />
          </Stack>
          <Textarea
            label="Community Rules"
            placeholder="1. Be respectful…"
            value={rules}
            onChange={(e) => setRules(e.currentTarget.value)}
            minRows={3}
          />
          <Group grow align="flex-start">
            <Stack gap={4}>
              <FileInput
                label="Forum Icon"
                description="Optional - falls back to a generated icon."
                placeholder="Choose an image"
                accept="image/*"
                value={iconFile}
                onChange={setIconFile}
                leftSection={<IconPhoto size={16} stroke={1.75} aria-hidden="true" />}
                clearable
              />
              {iconPreview && <Image src={iconPreview} alt="" w={64} h={64} radius="50%" style={{ objectFit: "cover" }} />}
            </Stack>
            <Stack gap={4}>
              <FileInput
                label="Forum Banner"
                description="Optional - falls back to a generated gradient."
                placeholder="Choose an image"
                accept="image/*"
                value={bannerFile}
                onChange={setBannerFile}
                leftSection={<IconPhoto size={16} stroke={1.75} aria-hidden="true" />}
                clearable
              />
              {bannerPreview && <Image src={bannerPreview} alt="" h={64} radius="sm" style={{ objectFit: "cover" }} />}
            </Stack>
          </Group>
          <NumberInput
            label="Minimum Karma to Flag Content"
            description="Members below this karma cannot flag posts/comments in this forum."
            value={minKarma}
            onChange={(value) => setMinKarma(typeof value === "number" ? value : 0)}
            min={0}
          />

          {navigating && <Alert color="blue">Confirmed! Opening your new forum...</Alert>}

          <Button onClick={handleSubmit} loading={uploading} size="md" leftSection={<IconRocket size={16} stroke={1.75} aria-hidden="true" />}>
            Broadcast Forum Setup
          </Button>
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed">Once signed, check the</Text>
            <IconReceipt2 size={14} stroke={1.75} color="var(--mantine-color-dimmed)" aria-hidden="true" />
            <Text size="xs" c="dimmed">tray in the header for progress - you're free to navigate away.</Text>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}