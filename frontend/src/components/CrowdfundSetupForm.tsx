// Step 2 UI for Crowdfund posts (target goal + campaign duration). Shared
// between CreatePostPage's post-Step-1 setup modal and PostDetailPage's
// "finish setup" retry banner.

import { useState } from "react";
import { Stack, Group, NumberInput, Button, Text } from "@mantine/core";

interface CrowdfundSetupFormProps {
  onSubmit: (goalEth: number, days: number) => Promise<boolean | void>;
  busy: boolean;
  submitLabel?: string;
  helperText?: string;
}

export function CrowdfundSetupForm({ onSubmit, busy, submitLabel = "Launch Crowdfund", helperText }: CrowdfundSetupFormProps) {
  const [goalEth, setGoalEth] = useState(1);
  const [days, setDays] = useState(30);

  return (
    <Stack gap="xs">
      {helperText && <Text size="sm">{helperText}</Text>}
      <Group gap="xs">
        <NumberInput
          label="Target goal (ETH)"
          value={goalEth}
          onChange={(v) => setGoalEth(typeof v === "number" ? v : 0.1)}
          min={0.0001}
          decimalScale={4}
          w={160}
        />
        <NumberInput
          label="Duration (days)"
          value={days}
          onChange={(v) => setDays(typeof v === "number" ? v : 1)}
          min={1}
          w={140}
        />
      </Group>
      <Button size="xs" onClick={() => onSubmit(goalEth, days)} loading={busy} style={{ alignSelf: "flex-start" }}>
        {submitLabel}
      </Button>
    </Stack>
  );
}
