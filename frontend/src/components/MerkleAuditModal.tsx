// Every step of the audit is verified independently rather than trusted:
// the leaf hash/proof are recomputed and walked to a root client-side
// (merkleVerify.ts) instead of trusting the backend's claimed root; the
// anchored root is then read directly from the contract
// (verifiedDatabaseRoots) via a read-only provider - the backend's own
// /api/merkle/anchor mirror is never trusted for that comparison; only once
// that on-chain check passes does it fetch the real JSON straight from IPFS
// and diff it against the DB-cached text, since a correctly anchored CID
// doesn't guarantee the DB is actually serving that content. A mismatch
// there surfaces the verified values via onCorrected so the caller can
// display the trustworthy version. Works identically for posts, comments,
// and forums even though posts/comments use a multi-level proof under the
// hood - the flat proof-array walk in merkleVerify.ts doesn't need to know
// the difference.
//
// The recomputed leaf/root, on-chain root, and anchoring block are surfaced
// in a collapsible "technical details" section (copyable) rather than a
// single verdict sentence, so a skeptical user can inspect the trust chain
// instead of just being told to trust it.

import { useState } from "react";
import { Modal, Button, Stack, Text, Loader, Group, Code, Collapse, CopyButton, Tooltip, ActionIcon } from "@mantine/core";
import {
  IconShieldCheck, IconCircleCheck, IconAlertTriangle, IconCircleX,
  IconChevronDown, IconChevronUp, IconCopy, IconCheck,
} from "@tabler/icons-react";
import { api } from "../lib/api";
import { computeLeafHash, verifyMerkleProof } from "../lib/merkleVerify";
import { coreContractReadOnly } from "../lib/readProvider";
import { bytes32ToIpfsCid, ZERO_BYTES32 } from "../lib/hash";
import { fetchJsonFromIPFS } from "../lib/ipfs";
import { decodeContractError } from "../lib/errors";

interface MerkleAuditModalProps {
  entityType: "post" | "comment" | "forum";
  entityId: string;
  /**
   * The text fields currently displayed for this entity, as decoded from
   * the DB's cached copy of its IPFS JSON (e.g. { title, body } for a post,
   * { body } for a comment, { name, description, category, rules, tags }
   * for a forum) - keys must match the field names used in the original
   * IPFS upload payload. Omit to skip the live IPFS content comparison
   * (root/proof verification still runs) - e.g. an unrevealed TimeCapsule
   * post has no real title/body to compare yet.
   */
  cachedContent?: Record<string, unknown>;
  /** Called with the real IPFS content when it differs from cachedContent, so the caller can display the verified version. */
  onCorrected?: (content: Record<string, unknown>) => void;
  /**
   * Visual weight of the trigger. "compact" (default) is a subtle inline
   * button for dense surfaces (comment rows, post lists). "prominent" is a
   * full-width, accent-colored CTA for surfaces where verification is the
   * main event - e.g. the post detail sidebar's "Verify this post" card -
   * matching the product principle that this is a first-class feature, not
   * a debug tool.
   */
  trigger?: "compact" | "prominent";
}

type AuditStatus = "idle" | "checking" | "verified" | "corrected" | "mismatch" | "error";

interface AuditDetails {
  leafHash: string;
  claimedRoot: string;
  proof: string[];
  onChainRoot: string | null;
  anchoredBlock: string | null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Group gap={4} wrap="nowrap" align="center">
        <Code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value}
        </Code>
        <CopyButton value={value} timeout={1500}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? "Copied" : "Copy"} withArrow>
              <ActionIcon size="sm" variant="subtle" color={copied ? "teal" : "gray"} onClick={copy} aria-label={`Copy ${label}`}>
                {copied ? <IconCheck size={14} stroke={1.75} aria-hidden="true" /> : <IconCopy size={14} stroke={1.75} aria-hidden="true" />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
}

export function MerkleAuditModal({ entityType, entityId, cachedContent, onCorrected, trigger = "compact" }: MerkleAuditModalProps) {
  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<AuditStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [correctedFields, setCorrectedFields] = useState<string[]>([]);
  const [details, setDetails] = useState<AuditDetails | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const runAudit = async () => {
    setOpened(true);
    setStatus("checking");
    setMessage(null);
    setCorrectedFields([]);
    setDetails(null);
    setDetailsOpen(false);
    try {
      const [proofData, anchor] = await Promise.all([
        api.getAuditProof(entityType, entityId),
        api.getMerkleAnchor(),
      ]);

      const leafHash = computeLeafHash(proofData.leaf.entityType, proofData.leaf.id, proofData.leaf.contentHash);
      const reconstructs = verifyMerkleProof(leafHash, proofData.proof, proofData.root);
      // Recorded as soon as it's known, regardless of outcome below - even a
      // failed/mismatched audit should leave the evidence inspectable rather
      // than just a verdict sentence.
      setDetails({ leafHash, claimedRoot: proofData.root, proof: proofData.proof, onChainRoot: null, anchoredBlock: null });
      if (!reconstructs) {
        setStatus("mismatch");
        setMessage("The proof does not reconstruct to the claimed root - the database record may not match what was recorded on-chain.");
        return;
      }

      if (anchor.lastAnchoredBlock == null) {
        setStatus("mismatch");
        setMessage("No database root has been anchored on-chain yet - this content cannot be verified.");
        return;
      }

      // Read straight from the contract, not the backend's Postgres mirror
      // of DatabaseRootAnchored events - this is the actual on-chain check.
      let onChainRoot: string;
      try {
        onChainRoot = (await coreContractReadOnly.verifiedDatabaseRoots(anchor.lastAnchoredBlock)) as string;
      } catch (chainErr) {
        setStatus("error");
        setMessage(decodeContractError(chainErr, coreContractReadOnly));
        return;
      }
      setDetails((d) => (d ? { ...d, onChainRoot, anchoredBlock: anchor.lastAnchoredBlock } : d));
      const matchesAnchor = onChainRoot !== "0x" + "0".repeat(64) && onChainRoot.toLowerCase() === proofData.root.toLowerCase();
      if (!matchesAnchor) {
        setStatus("mismatch");
        setMessage("The claimed root doesn't match the root anchored on-chain - this can happen briefly right after new activity, before the indexer's next anchor, or may indicate tampering.");
        return;
      }

      // A zero contentHash means no CID was ever attached on-chain for this
      // entity (e.g. created via a direct contract call that bypassed the
      // normal upload-then-create flow) - there is no real IPFS content to
      // diff against, and attempting the fetch would just wait out the full
      // gateway timeout for a CID that can never resolve to anything.
      if (cachedContent && proofData.leaf.contentHash !== ZERO_BYTES32) {
        const cid = bytes32ToIpfsCid(proofData.leaf.contentHash);
        const real = await fetchJsonFromIPFS<Record<string, unknown>>(cid);
        const mismatched = Object.keys(cachedContent).filter((key) => !deepEqual(real[key], cachedContent[key]));
        if (mismatched.length > 0) {
          setStatus("corrected");
          setCorrectedFields(mismatched);
          setMessage(
            `The database's cached ${mismatched.join(", ")} did not match the real IPFS content. ` +
            "Showing the verified version below instead."
          );
          onCorrected?.(real);
          return;
        }
      }

      setStatus("verified");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Audit failed.");
    }
  };

  return (
    <>
      {trigger === "prominent" ? (
        <Button
          fullWidth
          size="sm"
          leftSection={<IconShieldCheck size={16} stroke={1.75} aria-hidden="true" />}
          onClick={runAudit}
        >
          Run Verification
        </Button>
      ) : (
        <Tooltip
          label="Verify Content Integrity - Prove this post hasn't been tampered with or deleted by checking its on-chain cryptographic signature."
          multiline
          w={260}
          withArrow
        >
          <Button size="xs" variant="subtle" leftSection={<IconShieldCheck size={14} stroke={1.75} aria-hidden="true" />} onClick={runAudit}>
            Verify
          </Button>
        </Tooltip>
      )}
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={
          <Group gap={6}>
            <IconShieldCheck size={18} stroke={1.75} aria-hidden="true" />
            <Text fw={600}>Content Audit</Text>
          </Group>
        }
        centered
      >
        <Stack gap="sm">
          <div aria-live="polite" aria-atomic="true">
            {status === "checking" && (
              <Group gap="xs">
                <Loader size="sm" />
                <Text size="sm">Checking proof, on-chain root, and IPFS content...</Text>
              </Group>
            )}
            {status === "verified" && (
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <IconCircleCheck size={20} stroke={1.75} color="var(--mantine-color-green-6)" style={{ flexShrink: 0 }} aria-hidden="true" />
                <Text c="green" size="sm">
                  Verified - this content's Merkle proof reconstructs correctly, the root is confirmed
                  directly on-chain, and the database's cached text matches the real IPFS content. It has
                  not been altered or censored.
                </Text>
              </Group>
            )}
            {status === "corrected" && (
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <IconAlertTriangle size={20} stroke={1.75} color="var(--mantine-color-yellow-7)" style={{ flexShrink: 0 }} aria-hidden="true" />
                <Text c="yellow.7" size="sm">
                  On-chain proof verified, but the database's cached text didn't match real IPFS
                  content for: <Code>{correctedFields.join(", ")}</Code>. {message}
                </Text>
              </Group>
            )}
            {status === "mismatch" && (
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <IconCircleX size={20} stroke={1.75} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} aria-hidden="true" />
                <Text c="red" size="sm">Cannot be trusted - {message}</Text>
              </Group>
            )}
            {status === "error" && (
              <Text c="red" size="sm">Could not complete the audit: {message}</Text>
            )}
          </div>

          {details && (
            <Stack gap={4}>
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                rightSection={detailsOpen ? <IconChevronUp size={14} stroke={1.75} aria-hidden="true" /> : <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />}
                onClick={() => setDetailsOpen((o) => !o)}
                style={{ alignSelf: "flex-start" }}
              >
                Technical details
              </Button>
              <Collapse expanded={detailsOpen}>
                <Stack gap={8} p="xs" style={{ border: "1px solid var(--app-border)", borderRadius: "var(--mantine-radius-sm)" }}>
                  <HashRow label="Leaf hash" value={details.leafHash} />
                  <HashRow label="Recomputed root" value={details.claimedRoot} />
                  <HashRow
                    label={`Proof (${details.proof.length} step${details.proof.length === 1 ? "" : "s"})`}
                    value={details.proof.length > 0 ? `[${details.proof.join(", ")}]` : "(empty - this leaf is the root)"}
                  />
                  {details.onChainRoot && <HashRow label="Anchored root (read directly from the contract)" value={details.onChainRoot} />}
                  {details.anchoredBlock && <HashRow label="Anchored at block" value={details.anchoredBlock} />}
                </Stack>
              </Collapse>
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  );
}
