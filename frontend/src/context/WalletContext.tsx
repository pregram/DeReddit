// src/context/WalletContext.tsx - Connects to MetaMask (or any EIP-1193
// wallet), tracks the active address/signer, and pulls the matching backend
// profile (username/karma) once the indexer has seen that wallet. Also owns
// the "wallet interceptor" modal state used to gate write actions.
//
// Notable fixes:
//  1. Silent session restore: on mount, calls `eth_accounts` (not
//     `eth_requestAccounts`) which returns already-authorized accounts
//     without popping a MetaMask prompt - so a page refresh no longer
//     forces the user to reconnect.
//  2. accountsChanged now explicitly resets `profile` to null before the
//     address-triggered refetch runs, so a brief flash of the PREVIOUS
//     wallet's karma/username never appears under the new address.
//  3. Exposes refreshProfile for WalletTxBridge (see main.tsx) to call
//     after any confirmed transaction app-wide, so karma/profile data
//     stays in sync without every write path remembering to call it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BrowserProvider, type JsonRpcSigner } from "ethers";
import { api, type UserProfile, type BadgeSummary, type AppNotification } from "../lib/api";
import { useNotificationStream } from "../lib/useNotificationStream";

interface WalletContextValue {
  address: string | null;
  signer: JsonRpcSigner | null;
  profile: UserProfile | null;
  badges: BadgeSummary[];
  connecting: boolean;
  /** True until the initial silent session-restore (eth_accounts on mount) has resolved - lets callers avoid flashing a "disconnected" UI before we've actually checked. */
  initializing: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshProfile: () => Promise<void>;
  showInterceptor: boolean;
  /** What the interceptor modal was opened to let the user do, e.g. "upvote this post" - null when no reason was given. */
  interceptorReason: string | null;
  /** Returns true if a wallet is connected; otherwise opens the interceptor modal (with an optional reason shown in its copy) and returns false. */
  requireWallet: (reason?: string) => boolean;
  dismissInterceptor: () => void;
  notifications: AppNotification[];
  unreadNotificationCount: number;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  clearAllNotifications: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

declare global {
  interface Window {
    ethereum?: import("ethers").Eip1193Provider & {
      on?: (event: string, cb: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [badges, setBadges] = useState<BadgeSummary[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInterceptor, setShowInterceptor] = useState(false);
  const [interceptorReason, setInterceptorReason] = useState<string | null>(null);

  // Generation counters so an async call that's been superseded by a newer
  // one (e.g. a slow refreshProfile/connectWithSigner from before a wallet
  // switch) can detect it's stale and drop its result instead of clobbering
  // fresher state - see ForumDiscoveryPage.tsx's requestIdRef for the same
  // pattern. addressRef mirrors `address` synchronously (including inside
  // the accountsChanged handler, ahead of React state).
  const profileRequestIdRef = useRef(0);
  const connectRequestIdRef = useRef(0);
  const addressRef = useRef<string | null>(null);

  const disconnect = useCallback(() => {
    profileRequestIdRef.current++;
    connectRequestIdRef.current++;
    addressRef.current = null;
    setAddress(null);
    setSigner(null);
    setProfile(null);
    setBadges([]);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!address) {
      setProfile(null);
      setBadges([]);
      return;
    }
    // Claims this call's slot before the first await - any call this one
    // supersedes (or that supersedes this one) will lose the comparison
    // below and bail without touching state.
    const myRequestId = ++profileRequestIdRef.current;
    try {
      const { user, badges: newBadges } = await api.getUser(address);
      if (profileRequestIdRef.current !== myRequestId) return;
      setProfile(user);
      setBadges(newBadges);
    } catch {
      if (profileRequestIdRef.current !== myRequestId) return;
      // Not indexed yet (no on-chain activity the indexer has seen) - not an error state.
      setProfile(null);
      setBadges([]);
    }
  }, [address]);

  const connectWithSigner = useCallback(async (silent: boolean) => {
    if (!window.ethereum) {
      if (!silent) setError("No wallet extension detected. Install MetaMask to continue.");
      return;
    }
    // Same superseding-call guard as refreshProfile above - a slow silent
    // reconnect (e.g. from a rapid A->B->A account switch) must not resolve
    // after a newer call and revert the UI/signer to a stale account.
    const myConnId = ++connectRequestIdRef.current;
    if (!silent) setConnecting(true);
    if (!silent) setError(null);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const method = silent ? "eth_accounts" : "eth_requestAccounts";
      const accounts = (await provider.send(method, [])) as string[];
      if (accounts.length === 0) return;
      const nextSigner = await provider.getSigner();
      if (connectRequestIdRef.current !== myConnId) return;
      const nextAddress = accounts[0].toLowerCase();
      addressRef.current = nextAddress;
      setAddress(nextAddress);
      setSigner(nextSigner);
      setShowInterceptor(false);
    } catch (err) {
      if (connectRequestIdRef.current !== myConnId) return;
      if (!silent) setError(err instanceof Error ? err.message : "Failed to connect wallet.");
    } finally {
      if (connectRequestIdRef.current === myConnId && !silent) setConnecting(false);
    }
  }, []);

  const connect = useCallback(() => connectWithSigner(false), [connectWithSigner]);

  // Silent session restore on mount - eth_accounts never prompts, so a page
  // refresh with an already-authorized MetaMask session reconnects quietly.
  // `initializing` stays true until this resolves so callers (e.g. the
  // read-only banner) can avoid flashing a "disconnected" state before we've
  // actually had a chance to check for an already-authorized session.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false;
    void connectWithSigner(true).finally(() => {
      if (!cancelled) setInitializing(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (accounts.length === 0) {
        disconnect();
        return;
      }
      addressRef.current = accounts[0].toLowerCase();
      // Reset immediately so the new address's data never briefly shows the
      // previous wallet's stale profile while the refetch is in flight.
      setProfile(null);
      setBadges([]);
      // Fully rebuild the provider/signer (not just the displayed address) -
      // ethers v6's JsonRpcSigner is immutable once constructed, so leaving
      // the old signer in place would keep sending transactions from the
      // previously-connected account even though the UI shows the new one.
      void connectWithSigner(true);
    };
    eth.on("accountsChanged", handleAccountsChanged);
    return () => eth.removeListener?.("accountsChanged", handleAccountsChanged);
  }, [disconnect, connectWithSigner]);

  // This app targets a single fixed chain (readProvider/contract addresses
  // are constructed once from env.* - see lib/readProvider.ts), not a
  // multi-chain switcher, so a full reload is the correct response to a
  // network switch: it's the standard EIP-1193 integration pattern and
  // cleanly re-derives all state instead of patching signer/contract
  // instances in place while they may point at the wrong chain.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const handleChainChanged = () => {
      window.location.reload();
    };
    eth.on("chainChanged", handleChainChanged);
    return () => eth.removeListener?.("chainChanged", handleChainChanged);
  }, []);

  // Badge-earned and tip-received notifications now come from the backend
  // (persisted, deduped in Postgres) instead of localStorage diffing/polling
  // or a direct on-chain event listener - see useNotificationStream.
  const {
    notifications: notificationList,
    unreadCount: unreadNotificationCount,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    clearAll: clearAllNotifications,
  } = useNotificationStream(address, signer);

  const requireWallet = useCallback((reason?: string): boolean => {
    if (address && signer) return true;
    setInterceptorReason(reason ?? null);
    setShowInterceptor(true);
    return false;
  }, [address, signer]);

  const dismissInterceptor = useCallback(() => {
    setShowInterceptor(false);
    setInterceptorReason(null);
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      address, signer, profile, badges, connecting, initializing, error, connect, disconnect, refreshProfile,
      showInterceptor, interceptorReason, requireWallet, dismissInterceptor,
      notifications: notificationList, unreadNotificationCount, markNotificationRead, markAllNotificationsRead,
      clearAllNotifications,
    }),
    [
      address, signer, profile, badges, connecting, initializing, error, connect, disconnect, refreshProfile,
      showInterceptor, interceptorReason, requireWallet, dismissInterceptor,
      notificationList, unreadNotificationCount, markNotificationRead, markAllNotificationsRead,
      clearAllNotifications,
    ]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/**
 * Access wallet connection state, profile/badges, the tx interceptor, and
 * notification actions.
 * @throws if called outside a WalletProvider.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}