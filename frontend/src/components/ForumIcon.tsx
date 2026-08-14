// Deterministic jazzicon fallback for a forum's icon, seeded from the
// forum's name (keccak256-hashed) rather than a wallet address. Kept
// separate from Identicon.tsx rather than generalizing to an arbitrary seed
// - Identicon's existing wallet seed (first 4 raw address bytes, unhashed)
// must stay exactly as-is or every existing user's avatar fallback would
// visually change.

import { useEffect, useRef } from "react";
import jazzicon from "@metamask/jazzicon";
import { keccak256Utf8 } from "../lib/hash";

interface ForumIconProps {
  name: string;
  size?: number;
}

export function ForumIcon({ name, size = 24 }: ForumIconProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !name) return;
    const seed = parseInt(keccak256Utf8(name).slice(2, 10), 16);
    const icon = jazzicon(size, seed);
    ref.current.innerHTML = "";
    ref.current.appendChild(icon);
  }, [name, size]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden" }}
    />
  );
}
