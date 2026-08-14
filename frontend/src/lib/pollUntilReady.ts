// src/lib/pollUntilReady.ts - Polls a fetcher until it resolves without
// throwing, or gives up after a fixed number of attempts. Bridges the gap
// between "transaction confirmed on-chain" and "the indexer has caught up
// and the backend API can see it" - replaces a magic setTimeout(3000) with
// an actual readiness check (per earlier ADR-001 action item).

/**
 * Retries `fetcher` until it resolves without throwing, or gives up after the configured attempts.
 * @param fetcher - operation to retry, e.g. an API read expected to start succeeding once the indexer catches up.
 * @param options.attempts - max attempts (default 6).
 * @param options.intervalMs - delay between attempts in ms (default 1500).
 * @returns the resolved value, or null if every attempt failed.
 */
export async function pollUntilReady<T>(
  fetcher: () => Promise<T>,
  options: { attempts?: number; intervalMs?: number } = {}
): Promise<T | null> {
  const { attempts = 6, intervalMs = 1500 } = options;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetcher();
    } catch {
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }
  return null;
}