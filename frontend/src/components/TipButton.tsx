// Popover with an amount input; calls tipPostCreator / tipCommentCreator /
// tipDirect depending on target. Routed through the transaction tray instead
// of blocking the popover.

import { useState } from "react";
import { Popover, Button, NumberInput, Stack, Text, Group, Divider } from "@mantine/core";
import { IconBolt, IconCircleCheck } from "@tabler/icons-react";
import { useWallet } from "../context/WalletContext";
import { getCoreContract } from "../lib/contracts";
import { useTransactions } from "../context/TransactionContext";
import { notifyError, isAlreadyNotified } from "../lib/notify";
import { UserAvatar } from "./UserAvatar";
import { truncateAddress } from "../lib/format";

type TipTarget =
  | { type: "post"; postId: string }
  | { type: "comment"; commentId: string }
  | { type: "direct"; wallet: string };

interface TipButtonProps {
  target: TipTarget;
  label?: string;
  /** Who's receiving the tip - shown as a small identity row atop the popover, when known. */
  recipientWallet?: string;
  recipientUsername?: string | null;
  recipientProfileCid?: string | null;
}

export function TipButton({ target, label = "Tip", recipientWallet, recipientUsername, recipientProfileCid }: TipButtonProps) {
  const { signer, requireWallet } = useWallet();
  const { trackTransaction } = useTransactions();
  const [opened, setOpened] = useState(false);
  const [amountEth, setAmountEth] = useState<number>(0.01);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const sendTip = async () => {
    const reason =
      target.type === "post" ? "tip this post" :
      target.type === "comment" ? "tip this comment" :
      "tip this user";
    if (!requireWallet(reason) || !signer) return;
    if (amountEth <= 0) {
      notifyError("Amount must be greater than 0.");
      return;
    }
    const contract = getCoreContract(signer);
    setBusy(true);
    try {
      const valueWei = BigInt(Math.round(amountEth * 1e18));
      await trackTransaction({
        description: `Tip ${amountEth} ETH`,
        contract,
        send: () =>
          target.type === "post"
            ? contract.tipPostCreator(BigInt(target.postId), { value: valueWei })
            : target.type === "comment"
            ? contract.tipCommentCreator(BigInt(target.commentId), { value: valueWei })
            : contract.tipDirect(target.wallet, { value: valueWei }),
      });
      setSent(true);
      setTimeout(() => { setOpened(false); setSent(false); }, 1200);
    } catch (err) {
      if (!isAlreadyNotified(err)) notifyError(err instanceof Error ? err.message : "Tip failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover opened={opened} onChange={setOpened} withArrow>
      <Popover.Target>
        <Button size="sm" variant="light" leftSection={<IconBolt size={16} stroke={1.75} aria-hidden="true" />} onClick={() => setOpened((o) => !o)}>{label}</Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" w={200}>
          {recipientWallet && (
            <>
              <Group gap="xs" wrap="nowrap">
                <UserAvatar wallet={recipientWallet} profileCid={recipientProfileCid} size={20} />
                <Text size="xs" c="dimmed" truncate>
                  u/{recipientUsername ?? truncateAddress(recipientWallet)}
                </Text>
              </Group>
              <Divider />
            </>
          )}
          <NumberInput
            label="Amount (ETH)"
            value={amountEth}
            onChange={(v) => setAmountEth(typeof v === "number" ? v : 0)}
            min={0.0001}
            decimalScale={4}
          />
          {sent && (
            <Group gap={4} wrap="nowrap">
              <IconCircleCheck size={14} stroke={1.75} color="var(--mantine-color-green-6)" aria-hidden="true" />
              <Text size="xs" c="green">Tip sent! Check the transaction tray.</Text>
            </Group>
          )}
          <Button size="xs" onClick={sendTip} loading={busy}>Send Tip</Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}