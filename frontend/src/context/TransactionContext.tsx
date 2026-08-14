// ADR-001 Option C: a global, non-blocking transaction tracker.
//
// FIX (Issue #3 - tray spinner lifetime): the tray used to flip
// pending->confirmed the instant tx.wait() resolved, well before the
// indexer's ~3s poll cycle had written the change to Postgres - so "done"
// showed before profile refresh/page refetches had anything new. The two
// separate timers that used to exist here (one gating onAnyConfirmed
// listeners, one - none - gating the tray itself) are now a single wait:
// the tray stays "pending" through the indexer-catchup window too, and
// onAnyConfirmed fires at the same moment it flips to "confirmed", so the
// spinner's lifetime matches what the user actually needs to wait for.
//
// FIX (Issue #4): on local Hardhat, blocks auto-mine in under ~100ms, so
// pending->confirmed flipped almost instantly after clicking "confirm" in
// MetaMask - correct, but reads as "broken" to a human eye. A minimum
// visible-pending duration is enforced purely for legibility; it does NOT
// change what "confirmed" means (still only set after real tx.wait(), plus
// the indexer-catchup wait above).

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Contract, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { notifications } from "@mantine/notifications";
import { IconCircleX } from "@tabler/icons-react";
import { decodeContractError } from "../lib/errors";
import { markAlreadyNotified } from "../lib/notify";

export type TxStatus = "pending" | "confirmed" | "failed";

export interface TrackedTx {
  id: string;
  description: string;
  status: TxStatus;
  hash?: string;
  error?: string;
}

interface TrackTransactionParams {
  description: string;
  contract: Contract;
  send: () => Promise<ContractTransactionResponse>;
}

interface TransactionContextValue {
  transactions: TrackedTx[];
  trackTransaction: (params: TrackTransactionParams) => Promise<ContractTransactionReceipt>;
  dismiss: (id: string) => void;
  onAnyConfirmed: (cb: () => void) => () => void;
}

const TransactionContext = createContext<TransactionContextValue | null>(null);

const CONFIRMED_LIFETIME_MS = 6000;
const FAILED_LIFETIME_MS = 15000;
// Purely cosmetic - ensures the pending state is visible for at least this
// long even when tx.wait() resolves near-instantly (local Hardhat).
const MIN_PENDING_VISIBLE_MS = 500;
// How long to wait after real on-chain confirmation before treating the
// indexer as caught up - mirrors the indexer's own ~3s poll interval.
const INDEXER_CATCHUP_MS = 3200;

export function TransactionProvider({ children }: { children: ReactNode }) {
  const [transactions, setTransactions] = useState<TrackedTx[]>([]);
  const confirmedListeners = useRef<Set<() => void>>(new Set());

  const dismiss = useCallback((id: string) => {
    setTransactions((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const scheduleRemoval = useCallback(
    (id: string, delayMs: number) => {
      setTimeout(() => dismiss(id), delayMs);
    },
    [dismiss]
  );

  const onAnyConfirmed = useCallback((cb: () => void) => {
    confirmedListeners.current.add(cb);
    return () => confirmedListeners.current.delete(cb);
  }, []);

  const trackTransaction = useCallback(
    async ({ description, contract, send }: TrackTransactionParams): Promise<ContractTransactionReceipt> => {
      const id = crypto.randomUUID();
      const startedAt = Date.now();
      setTransactions((prev) => [...prev, { id, description, status: "pending" }]);

      try {
        const tx = await send();
        setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, hash: tx.hash } : t)));

        const receipt = await tx.wait();
        if (!receipt) throw new Error("Transaction did not return a receipt.");

        // Cosmetic only: don't flip pending->confirmed faster than a human
        // can register it, even though the real confirmation already happened.
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_PENDING_VISIBLE_MS) {
          await new Promise((r) => setTimeout(r, MIN_PENDING_VISIBLE_MS - elapsed));
        }

        // Keep the tray showing "pending" through the indexer's own
        // catch-up window - it needs this long to actually write the
        // change to Postgres, and flipping to "confirmed" any earlier
        // hides the spinner before the rest of the app has anything new
        // to show.
        await new Promise((r) => setTimeout(r, INDEXER_CATCHUP_MS));

        setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, status: "confirmed" } : t)));
        scheduleRemoval(id, CONFIRMED_LIFETIME_MS);
        confirmedListeners.current.forEach((cb) => cb());

        return receipt;
      } catch (err) {
        const message = decodeContractError(err, contract);
        setTransactions((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "failed", error: message } : t))
        );
        scheduleRemoval(id, FAILED_LIFETIME_MS);
        // Mantine's notifications region is announced to assistive tech on
        // its own - this is the one place every write action passes
        // through, so it's the single spot that can guarantee a failure is
        // announced, not just shown as color-only text in a closed tray.
        notifications.show({
          title: `${description} failed`,
          message,
          color: "red",
          icon: <IconCircleX size={18} stroke={1.75} />,
        });
        throw markAlreadyNotified(new Error(message, { cause: err }));
      }
    },
    [scheduleRemoval]
  );

  const value = useMemo(
    () => ({ transactions, trackTransaction, dismiss, onAnyConfirmed }),
    [transactions, trackTransaction, dismiss, onAnyConfirmed]
  );

  return <TransactionContext.Provider value={value}>{children}</TransactionContext.Provider>;
}

/**
 * Access the global transaction tray: submit and track a write transaction,
 * dismiss a tracked entry, or subscribe to "any transaction confirmed" events.
 * @throws if called outside a TransactionProvider.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useTransactions(): TransactionContextValue {
  const ctx = useContext(TransactionContext);
  if (!ctx) throw new Error("useTransactions must be used within a TransactionProvider");
  return ctx;
}