import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { WalletProvider, useWallet } from "../WalletContext";

vi.mock("../../lib/api", () => ({
  api: {
    getUser: vi.fn().mockRejectedValue(new Error("not indexed")),
  },
}));

vi.mock("../../lib/useNotificationStream", () => ({
  useNotificationStream: () => ({
    notifications: [],
    unreadCount: 0,
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

function makeFakeEthereum(initialAccounts: string[]) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    accounts: initialAccounts,
    async request({ method }: { method: string }) {
      switch (method) {
        case "eth_accounts":
          return this.accounts;
        case "eth_requestAccounts":
          return this.accounts;
        case "eth_chainId":
          return "0x7a69";
        default:
          return null;
      }
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    },
    removeListener(event: string, cb: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(cb);
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((cb) => cb(...args));
    },
  };
}

function TestConsumer() {
  const { address, initializing, showInterceptor, requireWallet } = useWallet();
  return (
    <div>
      <div data-testid="address">{address ?? "none"}</div>
      <div data-testid="initializing">{String(initializing)}</div>
      <div data-testid="interceptor">{String(showInterceptor)}</div>
      <button onClick={() => requireWallet("upvote this post")}>gate</button>
    </div>
  );
}

describe("WalletProvider", () => {
  afterEach(() => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  it("silently restores an already-authorized session via eth_accounts on mount (no prompt)", async () => {
    const fakeEthereum = makeFakeEthereum([WALLET_A]);
    window.ethereum = fakeEthereum as unknown as Window["ethereum"];

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    await waitFor(() => expect(screen.getByTestId("initializing").textContent).toBe("false"));
    expect(screen.getByTestId("address").textContent).toBe(WALLET_A);
  });

  it("stays disconnected when eth_accounts returns no authorized accounts", async () => {
    const fakeEthereum = makeFakeEthereum([]);
    window.ethereum = fakeEthereum as unknown as Window["ethereum"];

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    await waitFor(() => expect(screen.getByTestId("initializing").textContent).toBe("false"));
    expect(screen.getByTestId("address").textContent).toBe("none");
  });

  it("updates the connected address when the wallet emits accountsChanged", async () => {
    const fakeEthereum = makeFakeEthereum([WALLET_A]);
    window.ethereum = fakeEthereum as unknown as Window["ethereum"];

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );
    await waitFor(() => expect(screen.getByTestId("address").textContent).toBe(WALLET_A));

    fakeEthereum.accounts = [WALLET_B];
    await act(async () => {
      fakeEthereum.emit("accountsChanged", [WALLET_B]);
    });

    await waitFor(() => expect(screen.getByTestId("address").textContent).toBe(WALLET_B));
  });

  it("disconnects when accountsChanged reports an empty account list", async () => {
    const fakeEthereum = makeFakeEthereum([WALLET_A]);
    window.ethereum = fakeEthereum as unknown as Window["ethereum"];

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );
    await waitFor(() => expect(screen.getByTestId("address").textContent).toBe(WALLET_A));

    await act(async () => {
      fakeEthereum.emit("accountsChanged", []);
    });

    await waitFor(() => expect(screen.getByTestId("address").textContent).toBe("none"));
  });

  it("requireWallet opens the interceptor modal when no wallet is connected", async () => {
    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );
    await waitFor(() => expect(screen.getByTestId("initializing").textContent).toBe("false"));

    expect(screen.getByTestId("interceptor").textContent).toBe("false");
    await act(async () => {
      screen.getByText("gate").click();
    });
    expect(screen.getByTestId("interceptor").textContent).toBe("true");
  });
});
