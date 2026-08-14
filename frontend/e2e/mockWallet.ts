import type { Page } from "@playwright/test";

// Installs a fake EIP-1193 provider on `window.ethereum` before any page
// script runs, standing in for MetaMask. Avoids driving a real wallet
// extension (Synpress) so these E2E runs stay deterministic in CI.
export async function installMockWallet(page: Page, address: string): Promise<void> {
  await page.addInitScript((addr: string) => {
    type Listener = (...args: unknown[]) => void;
    const listeners: Record<string, Set<Listener>> = {};

    (window as unknown as { ethereum: unknown }).ethereum = {
      isMetaMask: true,
      async request({ method }: { method: string }) {
        switch (method) {
          case "eth_accounts":
          case "eth_requestAccounts":
            return [addr];
          case "eth_chainId":
            return "0x7a69";
          default:
            return null;
        }
      },
      on(event: string, cb: Listener) {
        (listeners[event] ??= new Set()).add(cb);
      },
      removeListener(event: string, cb: Listener) {
        listeners[event]?.delete(cb);
      },
    };
  }, address);
}
