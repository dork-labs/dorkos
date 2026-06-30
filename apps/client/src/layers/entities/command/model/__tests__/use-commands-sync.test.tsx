// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock useEventSubscription from the shared model barrel so we can capture and
// drive the handler without an SSE connection.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
  };
});

import { useCommandsSync } from '../use-commands-sync';
import { useEventSubscription } from '@/layers/shared/model';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

describe('useCommandsSync', () => {
  it('subscribes to the commands_changed event on mount', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useCommandsSync(), { wrapper });

    expect(useEventSubscription).toHaveBeenCalledWith('commands_changed', expect.any(Function));
  });

  it('invalidates the command registry query when commands_changed fires', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    let handler: (() => void) | undefined;
    vi.mocked(useEventSubscription).mockImplementation((_event, h) => {
      handler = h as () => void;
    });

    renderHook(() => useCommandsSync(), { wrapper });

    expect(handler).toBeDefined();
    handler!();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['commands'] });
  });
});
