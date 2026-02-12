import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function TestProviders({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

/**
 * Creates a ReadableStream that emits SSE-formatted text chunks.
 * Used for testing use-chat-session's SSE parsing logic.
 */
export function createMockReadableStream(sseChunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < sseChunks.length) {
        controller.enqueue(encoder.encode(sseChunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Format a StreamEvent as SSE wire format text.
 */
export function formatSSE(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
