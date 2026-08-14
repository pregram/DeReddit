// Reveal state is intentionally not persisted (plain component state, resets
// on remount) - avoids storage complexity for a low-value convenience.

import { useState } from "react";
import { Card, Text, Button, Stack, Group } from "@mantine/core";
import { IconFlag } from "@tabler/icons-react";
import type { ReactNode } from "react";

interface CollapsedFlaggedProps {
  flagTally: number;
  userTally: number;
  children: ReactNode;
}

export function CollapsedFlagged({ flagTally, userTally, children }: CollapsedFlaggedProps) {
  const [revealed, setRevealed] = useState(false);
  const shouldCollapse = flagTally > userTally;

  if (!shouldCollapse || revealed) {
    return <>{children}</>;
  }

  return (
    <Card withBorder padding="lg" style={{ opacity: 0.75 }}>
      <Stack gap={4} align="center">
        <Group gap={4} wrap="nowrap">
          <IconFlag size={14} stroke={1.75} color="var(--mantine-color-orange-6)" aria-hidden="true" />
          <Text size="sm" c="orange">Hidden - flagged {flagTally} times (your threshold: {userTally})</Text>
        </Group>
        <Button size="xs" variant="subtle" onClick={() => setRevealed(true)}>Click to reveal</Button>
      </Stack>
    </Card>
  );
}