// Header dropdown showing every tracked transaction's live status. A pending
// count badge makes it obvious at a glance that something is still mining,
// without blocking navigation or interaction anywhere else in the app.

import { Menu, Indicator, ActionIcon, Text, Stack, Group, Loader, CloseButton } from "@mantine/core";
import { IconReceipt2, IconHourglass, IconCircleCheck, IconCircleX } from "@tabler/icons-react";
import type { Icon, IconProps } from "@tabler/icons-react";
import { useTransactions } from "../context/TransactionContext";

const STATUS_ICON: Record<string, Icon> = {
  pending: IconHourglass,
  confirmed: IconCircleCheck,
  failed: IconCircleX,
};

const STATUS_COLOR: Record<string, string> = {
  pending: "gray",
  confirmed: "green",
  failed: "red",
};

function StatusIcon({ status, ...props }: { status: string } & IconProps) {
  const Cmp = STATUS_ICON[status];
  return <Cmp color={`var(--mantine-color-${STATUS_COLOR[status]}-6)`} {...props} />;
}

export function TransactionTray() {
  const { transactions, dismiss } = useTransactions();
  const pendingCount = transactions.filter((t) => t.status === "pending").length;

  return (
    <Menu shadow="md" width={320} position="bottom-end">
      <Menu.Target>
        <Indicator label={pendingCount || undefined} disabled={pendingCount === 0} color="blue" size={16} processing={pendingCount > 0}>
          <ActionIcon variant="light" size="lg" aria-label="Transactions">
            {pendingCount > 0 ? <Loader size="xs" /> : <IconReceipt2 size={20} stroke={1.75} aria-hidden="true" />}
          </ActionIcon>
        </Indicator>
      </Menu.Target>
      <Menu.Dropdown>
        <Stack gap="xs" p="xs" miw={280}>
          {transactions.length === 0 ? (
            <Text size="sm" c="dimmed">No transactions yet.</Text>
          ) : (
            transactions.map((tx) => (
              <Group key={tx.id} justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <StatusIcon status={tx.status} size={14} stroke={1.75} aria-hidden="true" />
                    <Text size="sm">{tx.description}</Text>
                  </Group>
                  {tx.status === "failed" && tx.error && <Text size="xs" c="red">{tx.error}</Text>}
                  {tx.hash && <Text size="xs" c="dimmed" truncate>tx: {tx.hash.slice(0, 10)}...</Text>}
                </Stack>
                <CloseButton size="xs" aria-label={`Dismiss: ${tx.description}`} onClick={() => dismiss(tx.id)} />
              </Group>
            ))
          )}
        </Stack>
      </Menu.Dropdown>
    </Menu>
  );
}