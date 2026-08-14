// Wraps Identicon: renders the user's uploaded avatar image (resolved from
// the on-chain profileCID bytes32) when one is set, falling back to the
// deterministic wallet-seeded Identicon otherwise. profileCid is the raw
// bytes32 hex the API returns (users.profile_cid) - never a bare CIDv0
// string, unlike ForumIcon's iconCid.

import { useState } from "react";
import { Image } from "@mantine/core";
import { Identicon } from "./Identicon";
import { bytes32ToIpfsCid, ZERO_BYTES32 } from "../lib/hash";
import { ipfsGatewayUrl } from "../lib/ipfs";

interface UserAvatarProps {
  wallet: string;
  profileCid?: string | null;
  size?: number;
}

export function UserAvatar({ wallet, profileCid, size = 24 }: UserAvatarProps) {
  const hasAvatar = !!profileCid && profileCid !== ZERO_BYTES32;
  // Tracks which profileCid last failed to load, rather than a plain
  // boolean, so switching to a different (valid) profileCid gets a fresh
  // chance to load without needing an effect to reset the flag.
  const [failedCid, setFailedCid] = useState<string | null>(null);
  const loadFailed = failedCid !== null && failedCid === profileCid;

  if (!hasAvatar || loadFailed) {
    return <Identicon address={wallet} size={size} />;
  }

  return (
    <Image
      src={ipfsGatewayUrl(bytes32ToIpfsCid(profileCid))}
      alt=""
      w={size}
      h={size}
      radius="50%"
      style={{ objectFit: "cover" }}
      onError={() => setFailedCid(profileCid)}
    />
  );
}
