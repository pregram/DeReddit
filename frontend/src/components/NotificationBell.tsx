// Header dropdown for backend-persisted notifications (tips, badges).
// Mirrors TransactionTray's Menu+Indicator pattern. Intentionally minimal:
// newest-first capped list, click-to-read, mark-all - no dedicated
// notification-center page.

import { Menu, Indicator, ActionIcon, Text, Stack, Group, UnstyledButton, Modal, Button } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications as toasts } from "@mantine/notifications";
import { IconBell, IconGift, IconMedal } from "@tabler/icons-react";
import { useWallet } from "../context/WalletContext";
import { formatDate, weiToEth, truncateAddress } from "../lib/format";
import type { AppNotification } from "../lib/api";

const NOTIFICATION_LIMIT = 20;

function describe(n: AppNotification): string {
  if (n.type === "tip") {
    return `You received ${weiToEth(n.amount_wei ?? "0")} ETH from ${truncateAddress(n.sender_wallet ?? "")}`;
  }
  return `You earned the ${n.badge_name} badge!`;
}

function showActionError(title: string): void {
  toasts.show({ title, message: "Please try again.", color: "red" });
}

export function NotificationBell() {
  const { notifications, unreadNotificationCount, markNotificationRead, markAllNotificationsRead, clearAllNotifications } =
    useWallet();
  const visible = notifications.slice(0, NOTIFICATION_LIMIT);
  const [confirmOpen, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);

  const handleClearAll = () => {
    closeConfirm();
    clearAllNotifications().catch(() => showActionError("Couldn't clear notifications"));
  };

  return (
    <>
      <Modal opened={confirmOpen} onClose={closeConfirm} title="Clear all notifications?" size="sm" centered>
        <Text size="sm" c="dimmed" mb="lg">
          This permanently deletes all {notifications.length} notification{notifications.length === 1 ? "" : "s"}. This
          can&apos;t be undone.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={closeConfirm}>
            Cancel
          </Button>
          <Button color="red" onClick={handleClearAll}>
            Clear all
          </Button>
        </Group>
      </Modal>
      <Menu shadow="md" width={340} position="bottom-end">
        <Menu.Target>
          <Indicator
            label={unreadNotificationCount || undefined}
            disabled={unreadNotificationCount === 0}
            color="red"
            size={16}
          >
            <ActionIcon variant="light" size="lg" aria-label="Notifications">
              <IconBell size={20} stroke={1.75} aria-hidden="true" />
            </ActionIcon>
          </Indicator>
        </Menu.Target>
        <Menu.Dropdown>
          <Group justify="space-between" px="xs" pt="xs">
            <Text size="sm" fw={600}>Notifications</Text>
            <Group gap="sm">
              {unreadNotificationCount > 0 && (
                <UnstyledButton
                  onClick={() => markAllNotificationsRead().catch(() => showActionError("Couldn't mark all as read"))}
                >
                  <Text size="xs" c="blue">Mark all read</Text>
                </UnstyledButton>
              )}
              {notifications.length > 0 && (
                <UnstyledButton onClick={openConfirm}>
                  <Text size="xs" c="red">Clear all</Text>
                </UnstyledButton>
              )}
            </Group>
          </Group>
          <Stack gap={2} p="xs" miw={300} mah={360} style={{ overflowY: "auto" }}>
            {visible.length === 0 ? (
              <Text c="dimmed" py="md" size="sm" ta="center">No notifications</Text>
            ) : (
              visible.map((n) => (
                <UnstyledButton
                  key={n.notification_id}
                  onClick={() => {
                    if (!n.read_at) {
                      markNotificationRead(n.notification_id).catch(() => showActionError("Couldn't mark as read"));
                    }
                  }}
                  p="xs"
                  style={{
                    borderRadius: 6,
                    background: n.read_at ? "transparent" : "var(--mantine-color-blue-light)",
                  }}
                >
                  <Group gap={8} wrap="nowrap" align="flex-start">
                    {n.type === "tip" ? (
                      <IconGift size={16} stroke={1.75} color="var(--mantine-color-green-6)" aria-hidden="true" />
                    ) : (
                      <IconMedal size={16} stroke={1.75} color="var(--mantine-color-yellow-6)" aria-hidden="true" />
                    )}
                    <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                      <Text size="sm">{describe(n)}</Text>
                      <Text size="xs" c="dimmed">{formatDate(n.created_at)}</Text>
                    </Stack>
                  </Group>
                </UnstyledButton>
              ))
            )}
          </Stack>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
