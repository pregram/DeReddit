// Shows the CONNECTED wallet's own personal tip on this post/comment
// (user_tipped_wei), not the global sum across all tippers - the global
// total isn't meaningful to a given viewer and was showing everyone else's
// tips mixed into one number.

import { Group, Text } from "@mantine/core";
import { IconBolt } from "@tabler/icons-react";
import { weiToEth } from "../lib/format";

export function TipTotal({ userTippedWei }: { userTippedWei: string }) {
  if (Number(userTippedWei) <= 0) return null;
  return (
    <Group gap={4} wrap="nowrap">
      <IconBolt size={14} stroke={1.75} aria-hidden="true" />
      <Text size="sm" className="tabular-nums">You tipped {weiToEth(userTippedWei)} ETH</Text>
    </Group>
  );
}
