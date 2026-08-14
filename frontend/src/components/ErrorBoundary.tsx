// Class-based boundary (React error boundaries must be classes; there's no
// hook equivalent) wrapping the route tree. Without this, an unhandled RPC
// error thrown during render (e.g. a decode failure, a null-pointer on
// unexpected chain data) produces a blank white screen with no recovery path.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Stack, Title, Text, Button, Container } from "@mantine/core";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : "Something went wrong." };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, message: null });
    window.location.assign("/");
  };

  render() {
    if (this.state.hasError) {
      return (
        <Container size="sm" py="xl">
          <Stack align="center" gap="md">
            <Title order={2}>Something went wrong</Title>
            <Text c="dimmed" ta="center">{this.state.message}</Text>
            <Button onClick={this.handleReset}>Back to Home</Button>
          </Stack>
        </Container>
      );
    }
    return this.props.children;
  }
}