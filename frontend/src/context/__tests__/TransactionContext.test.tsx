import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { Contract, ContractTransactionResponse } from "ethers";
import { TransactionProvider, useTransactions } from "../TransactionContext";

vi.mock("../../lib/errors", () => ({
  decodeContractError: (err: unknown) => (err instanceof Error ? err.message : "unknown error"),
}));

vi.mock("../../lib/notify", () => ({
  markAlreadyNotified: (err: Error) => err,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

const FAKE_CONTRACT = {} as Contract;

function TestConsumer({ onReady }: { onReady: (api: ReturnType<typeof useTransactions>) => void }) {
  const api = useTransactions();
  onReady(api);
  return (
    <ul>
      {api.transactions.map((t) => (
        <li key={t.id} data-testid="tx">
          {t.status}:{t.description}:{t.error ?? ""}
        </li>
      ))}
    </ul>
  );
}

function renderTransactions() {
  let api!: ReturnType<typeof useTransactions>;
  render(
    <TransactionProvider>
      <TestConsumer onReady={(a) => { api = a; }} />
    </TransactionProvider>
  );
  return () => api;
}

describe("TransactionProvider.trackTransaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes pending -> confirmed after the min-visible + indexer-catchup delays, then auto-dismisses", async () => {
    const getApi = renderTransactions();
    const receipt = { hash: "0xabc" };
    const send = vi.fn().mockResolvedValue({
      hash: "0xabc",
      wait: vi.fn().mockResolvedValue(receipt),
    } as unknown as ContractTransactionResponse);

    let resultPromise!: Promise<unknown>;
    act(() => {
      resultPromise = getApi().trackTransaction({ description: "Upvote post", contract: FAKE_CONTRACT, send });
    });

    expect(screen.getByTestId("tx").textContent).toBe("pending:Upvote post:");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 3200);
    });

    expect(screen.getByTestId("tx").textContent).toBe("confirmed:Upvote post:");
    await expect(resultPromise).resolves.toEqual(receipt);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.queryByTestId("tx")).toBeNull();
  });

  it("calls onAnyConfirmed listeners exactly when a transaction confirms", async () => {
    const getApi = renderTransactions();
    const listener = vi.fn();
    act(() => {
      getApi().onAnyConfirmed(listener);
    });

    const send = vi.fn().mockResolvedValue({
      hash: "0xdef",
      wait: vi.fn().mockResolvedValue({ hash: "0xdef" }),
    } as unknown as ContractTransactionResponse);

    act(() => {
      void getApi().trackTransaction({ description: "Tip", contract: FAKE_CONTRACT, send });
    });
    expect(listener).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 3200);
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("goes pending -> failed with a decoded error message, then auto-dismisses", async () => {
    const getApi = renderTransactions();
    const send = vi.fn().mockRejectedValue(new Error("execution reverted: Unauthorized"));

    let rejection: unknown;
    act(() => {
      getApi()
        .trackTransaction({ description: "Flag post", contract: FAKE_CONTRACT, send })
        .catch((err) => { rejection = err; });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("tx").textContent).toBe("failed:Flag post:execution reverted: Unauthorized");
    expect(rejection).toBeInstanceOf(Error);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.queryByTestId("tx")).toBeNull();
  });
});
