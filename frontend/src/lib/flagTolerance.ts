// src/lib/flagTolerance.ts - Per-user, per-device "flag tolerance" (userTally)
// slider. Purely aesthetic/client-side per project decision: never sent to
// the backend, never persisted beyond this browser. A post/comment is
// collapsed behind a click-to-reveal wrapper when its on-chain flag_tally
// exceeds this value.
//
// Keyed by wallet address (not just device) - two different wallets used in
// the same browser (e.g. two Hardhat accounts via the same MetaMask) must
// not share one slider value.

import { useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";

const STORAGE_PREFIX = "dereddit:flagTolerance:";
const DEFAULT_TOLERANCE = 50;

function readStored(address: string | null): number {
  if (typeof window === "undefined") return DEFAULT_TOLERANCE;
  const stored = localStorage.getItem(STORAGE_PREFIX + (address ?? "anon"));
  const parsed = stored ? Number(stored) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_TOLERANCE;
}

/**
 * Reads/writes the current wallet's flag-tolerance slider value, persisted in localStorage only.
 * @returns a `[tolerance, setTolerance]` tuple, mirroring `useState`.
 */
export function useFlagTolerance(): [number, (value: number) => void] {
  const { address } = useWallet();
  const [tolerance, setToleranceState] = useState<number>(() => readStored(address));

  // Re-read whenever the connected wallet changes, so switching accounts in
  // the same browser tab shows that wallet's own stored value instead of
  // carrying over the previous wallet's.
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setToleranceState(readStored(address));
  }, [address]);

  const setTolerance = (value: number) => {
    setToleranceState(value);
    localStorage.setItem(STORAGE_PREFIX + (address ?? "anon"), String(value));
  };

  return [tolerance, setTolerance];
}