// Step 2 UI for Poll posts (voting duration only; option text/count was
// already fixed in Step 1's IPFS payload). Shared between CreatePostPage's
// post-Step-1 setup modal and PostDetailPage's "finish setup" retry banner.

import { useState } from "react";
import { Stack, NumberInput, Button, Text } from "@mantine/core";

interface PollSetupFormProps {
  onSubmit: (days: number) => Promise<boolean | void>;
  busy: boolean;
  submitLabel?: string;
  helperText?: string;
}

export function PollSetupForm({ onSubmit, busy, submitLabel = "Complete Poll Setup", helperText }: PollSetupFormProps) {
  const [days, setDays] = useState(7);

  return (
    <Stack gap="xs">
      {helperText && <Text size="sm">{helperText}</Text>}
      <NumberInput
        label="Voting duration (days)"
        value={days}
        onChange={(v) => setDays(typeof v === "number" ? v : 1)}
        min={1}
        maw={200}
      />
      <Button size="xs" onClick={() => onSubmit(days)} loading={busy} style={{ alignSelf: "flex-start" }}>
        {submitLabel}
      </Button>
    </Stack>
  );
}
