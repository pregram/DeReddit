// Chip-based tag entry with the character rules agreed for this project:
// letters, numbers, '_' and '-' only, no commas or spaces, capped at `max`
// tags (default 10).

import { useState } from "react";
import { TextInput, Group, Badge, CloseButton, Stack } from "@mantine/core";

const TAG_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TAG_LENGTH = 30;

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  max?: number;
}

export function TagInput({ value, onChange, max = 10 }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addTag = () => {
    const tag = draft.trim();
    if (!tag) return;
    if (!TAG_PATTERN.test(tag)) {
      setError("Tags may only contain letters, numbers, '_' and '-' - no commas or spaces.");
      return;
    }
    if (tag.length > MAX_TAG_LENGTH) {
      setError(`Tags must be ${MAX_TAG_LENGTH} characters or fewer.`);
      return;
    }
    if (value.includes(tag)) {
      setError("Tag already added.");
      return;
    }
    if (value.length >= max) {
      setError(`Maximum of ${max} tags allowed.`);
      return;
    }
    onChange([...value, tag]);
    setDraft("");
    setError(null);
  };

  return (
    <Stack gap="xs">
      {value.length > 0 && (
        <Group gap="xs">
          {value.map((tag) => (
            <Badge
              key={tag}
              size="xs"
              variant="outline"
              maw={140}
              style={{ overflow: "hidden", textOverflow: "ellipsis", textTransform: "none" }}
              rightSection={
                <CloseButton
                  size="xs"
                  aria-label={`Remove tag: ${tag}`}
                  onClick={() => onChange(value.filter((t) => t !== tag))}
                />
              }
            >
              {tag}
            </Badge>
          ))}
        </Group>
      )}
      <TextInput
        aria-label="Add a tag"
        placeholder={`Add a tag and press Enter (${value.length}/${max})`}
        value={draft}
        maxLength={MAX_TAG_LENGTH}
        disabled={value.length >= max}
        onChange={(e) => { setDraft(e.currentTarget.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
        error={error}
      />
    </Stack>
  );
}