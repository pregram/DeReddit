// Small bridging component (no visual output) that wires TransactionContext's
// onAnyConfirmed hook to WalletContext's refreshProfile. This is what makes
// the navbar karma counter update after ANY confirmed transaction anywhere in
// the app, without every page having to remember to call refreshProfile
// itself. Rendered once, inside both providers, in main.tsx.

import { useEffect } from "react";
import { useTransactions } from "../context/TransactionContext";
import { useWallet } from "../context/WalletContext";

export function WalletTxBridge() {
  const { onAnyConfirmed } = useTransactions();
  const { refreshProfile } = useWallet();

  useEffect(() => {
    return onAnyConfirmed(() => {
      void refreshProfile();
    });
  }, [onAnyConfirmed, refreshProfile]);

  return null;
}