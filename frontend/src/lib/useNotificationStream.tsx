import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonRpcSigner } from "ethers";
import { notifications } from "@mantine/notifications";
import { IconMedal, IconGift } from "@tabler/icons-react";
import { api, type AppNotification, type NotificationAuth } from "./api";
import { weiToEth, truncateAddress } from "./format";
import { buildNotificationAuthMessage } from "./notificationAuth";

interface UseNotificationStreamResult {
  notifications: AppNotification[];
  unreadCount: number;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clearAll: () => Promise<void>;
}

// How long a signed ownership proof stays valid for reuse across multiple
// notification actions before a fresh signature is required - matches
// NOTIFICATION_AUTH_WINDOW_MS in backend/src/server.ts.
const AUTH_TTL_MS = 10 * 60 * 1000;

// Was SSE (a held-open /stream connection). Switched to polling because the
// free Cloudflare quick tunnel this project runs behind falls back to a
// degraded HTTP/2 transport when outbound QUIC is blocked (true on this
// WSL2 setup). Under that fallback the edge resets any stream that sits
// idle for more than a few seconds, and that's exactly what SSE does
// between notifications. Polling never holds a connection open, so it
// isn't exposed to that reset.
const POLL_INTERVAL_MS = 5000;

function showToastFor(n: AppNotification): void {
  if (n.type === "tip") {
    notifications.show({
      title: "Tip received!",
      message: `You received ${weiToEth(n.amount_wei ?? "0")} ETH from ${truncateAddress(n.sender_wallet ?? "")}!`,
      color: "green",
      icon: <IconGift size={18} stroke={1.75} />,
    });
  } else {
    notifications.show({
      title: "Badge earned!",
      message: `Congratulations! You earned the ${n.badge_name} badge!`,
      color: "yellow",
      icon: <IconMedal size={18} stroke={1.75} />,
    });
  }
}

/**
 * Backend-driven replacement for the old localStorage dedup + on-chain-listener approach
 * in WalletContext. A polling loop (started and stopped per address, see the effect below)
 * is the sole source of "new notification" events, so an account switch simply stops the
 * old loop. The imperative mutators returned here (markRead/markAllRead/clearAll) are a
 * separate race window: they use addressRef the same way WalletContext does, so a call
 * that resolves after the active wallet has switched drops its state update instead of
 * clobbering the new wallet's items/unreadCount.
 * @param address - connected wallet address, or null when disconnected
 * @param signer - signer used to prove wallet ownership for mutation endpoints (see getAuthHeaders)
 */
export function useNotificationStream(
  address: string | null,
  signer: JsonRpcSigner | null
): UseNotificationStreamResult {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const itemsRef = useRef<AppNotification[]>([]);
  const addressRef = useRef<string | null>(null);
  const authRef = useRef<(NotificationAuth & { wallet: string }) | null>(null);
  const pendingAuthRef = useRef<Promise<NotificationAuth> | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /* eslint-disable react-hooks/set-state-in-effect -- resets local
     notification state synchronously on address change, mirroring
     WalletContext's own address-switch reset (see accountsChanged there):
     the reset must happen before the new address's fetch/stream can land. */
  useEffect(() => {
    addressRef.current = address;
    authRef.current = null;
    pendingAuthRef.current = null;
    setItems([]);
    setUnreadCount(0);
    if (!address) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    // Each tick re-fetches the current top of the list and diffs it against what's
    // already in state (via itemsRef) to find rows that are genuinely new. The
    // endpoint has no cursor param, so "new" has to be re-derived from identity
    // instead of asked for directly.
    const pollAndToast = () =>
      api
        .getNotifications(address)
        .then(({ notifications: latest, unreadCount: count }) => {
          if (cancelled) return;
          const newOnes = latest.filter(
            (n) => !itemsRef.current.some((x) => x.notification_id === n.notification_id)
          );
          setItems(latest);
          setUnreadCount(count);
          // Oldest-first so a run of several new notifications toasts in the
          // order they actually happened.
          newOnes
            .slice()
            .sort((a, b) => (BigInt(a.notification_id) < BigInt(b.notification_id) ? -1 : 1))
            .forEach(showToastFor);
        })
        .catch(() => {
          // Fetch failures here are transient. The next tick retries.
        });

    void api
      .getNotifications(address)
      .then(({ notifications: initial, unreadCount: count }) => {
        if (cancelled) return;
        setItems(initial);
        setUnreadCount(count);
      })
      .catch(() => {
        // Not indexed yet / no activity for this wallet - not an error state.
      })
      .finally(() => {
        if (!cancelled) intervalId = setInterval(pollAndToast, POLL_INTERVAL_MS);
      });

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [address]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Proves wallet ownership to the backend for mutation endpoints. Reuses a
  // cached signature for AUTH_TTL_MS so mark-read/mark-all/clear-all don't
  // each trigger their own wallet popup - only the first action per window
  // does, and a wallet switch (see effect above) always invalidates the cache.
  // Concurrent callers (e.g. two notification clicks before the first
  // signMessage() resolves) share the same in-flight promise via
  // pendingAuthRef instead of each popping their own MetaMask prompt.
  const getAuthHeaders = useCallback(async (): Promise<NotificationAuth> => {
    if (!address || !signer) throw new Error("Wallet not connected");
    const cached = authRef.current;
    if (cached && cached.wallet === address && Date.now() - cached.issuedAt < AUTH_TTL_MS) {
      return cached;
    }
    if (pendingAuthRef.current) return pendingAuthRef.current;
    const pending = (async () => {
      const issuedAt = Date.now();
      const signature = await signer.signMessage(buildNotificationAuthMessage(address, issuedAt));
      const auth = { wallet: address, issuedAt, signature };
      authRef.current = auth;
      return auth;
    })();
    pendingAuthRef.current = pending;
    try {
      return await pending;
    } finally {
      pendingAuthRef.current = null;
    }
  }, [address, signer]);

  const markRead = useCallback(
    async (id: string) => {
      if (!address || !signer) return;
      const myAddress = address;
      const target = itemsRef.current.find((n) => n.notification_id === id);
      const wasUnread = !!target && !target.read_at;
      const auth = await getAuthHeaders();
      await api.markNotificationRead(address, id, auth);
      if (addressRef.current !== myAddress) return;
      setItems((prev) =>
        prev.map((n) => (n.notification_id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n))
      );
      if (wasUnread) setUnreadCount((prev) => Math.max(0, prev - 1));
    },
    [address, signer, getAuthHeaders]
  );

  const markAllRead = useCallback(async () => {
    if (!address || !signer) return;
    const myAddress = address;
    const auth = await getAuthHeaders();
    await api.markAllNotificationsRead(address, auth);
    if (addressRef.current !== myAddress) return;
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    setUnreadCount(0);
  }, [address, signer, getAuthHeaders]);

  const clearAll = useCallback(async () => {
    if (!address || !signer) return;
    const myAddress = address;
    const auth = await getAuthHeaders();
    await api.clearAllNotifications(address, auth);
    if (addressRef.current !== myAddress) return;
    setItems([]);
    setUnreadCount(0);
  }, [address, signer, getAuthHeaders]);

  return { notifications: items, unreadCount, markRead, markAllRead, clearAll };
}
