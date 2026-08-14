import { useEffect, useRef } from "react";

/**
 * Shared IntersectionObserver-based auto-fetch for feed/list pages.
 * @param onIntersect - called once when the sentinel scrolls into view
 * @param enabled - pass `hasMore && !loading` so it doesn't refire while a fetch is already in flight or after the list is exhausted
 * @returns ref to attach to a sentinel element placed after the last rendered item
 */
export function useInfiniteScroll(onIntersect: () => void, enabled = true) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(onIntersect);

  // Keep the ref current without mutating it during render itself - this
  // effect runs after every render (no dependency array) purely to sync
  // the ref, so the IntersectionObserver effect below can depend on
  // `enabled` alone and always call the latest callback.
  useEffect(() => {
    callbackRef.current = onIntersect;
  });

  useEffect(() => {
    if (!enabled) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) callbackRef.current();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return sentinelRef;
}
