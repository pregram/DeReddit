// Shared "Read more / Show less" truncation, generalized out of a one-off
// Spoiler that used to live inline in PostDetailPage. Used for post bodies,
// comments/replies, forum descriptions, and forum rules.

import type { CSSProperties } from "react";
import { Spoiler, Text, type MantineSize } from "@mantine/core";

interface ReadMoreProps {
  text: string;
  threshold?: number;
  maxHeight?: number;
  size?: MantineSize;
  textStyle?: CSSProperties;
}

export function ReadMore({ text, threshold = 500, maxHeight = 120, size, textStyle }: ReadMoreProps) {
  const style = { overflowWrap: "anywhere" as const, ...textStyle };
  if (text.length <= threshold) {
    return <Text size={size} style={style}>{text}</Text>;
  }
  return (
    <Spoiler maxHeight={maxHeight} showLabel="Read more" hideLabel="Show less">
      <Text size={size} style={style}>{text}</Text>
    </Spoiler>
  );
}
