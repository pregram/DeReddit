// Deterministic MetaMask-style wallet avatar (@metamask/jazzicon) - pure
// client-side, so the same address always renders the same icon with no
// network calls.

import { useEffect, useRef } from "react";
import jazzicon from "@metamask/jazzicon";

interface IdenticonProps {
  address: string;
  size?: number;
}

export function Identicon({ address, size = 24 }: IdenticonProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !address) return;
    const seed = parseInt(address.slice(2, 10), 16);
    const icon = jazzicon(size, seed);
    ref.current.innerHTML = "";
    ref.current.appendChild(icon);
  }, [address, size]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden" }}
    />
  );
}