import { Link } from "react-router-dom";
import { Stack, Title, Text, Button } from "@mantine/core";

export function NotFoundPage() {
  return (
    <Stack align="center" py="xl" gap="md">
      <Title order={1}>404</Title>
      <Text c="dimmed">This page doesn't exist yet.</Text>
      <Button component={Link} to="/">Back to Home</Button>
    </Stack>
  );
}