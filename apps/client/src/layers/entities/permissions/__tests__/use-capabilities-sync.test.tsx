// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const handlers = new Map<string, (data: unknown) => void>();

// Capture the handler so the test can fire the event without an SSE stream.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (event: string, handler: (data: unknown) => void) => {
      handlers.set(event, handler);
    },
  };
});

import { useCapabilitiesSync } from '../model/use-capabilities-sync';

afterEach(() => {
  handlers.clear();
  cleanup();
});

describe('useCapabilitiesSync (DOR-2685)', () => {
  it('re-reads every permission query when an extension adds or removes tools', () => {
    // The permissions pages list each area's actions from the live registry,
    // so an extension starting or stopping must refresh them in every window.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useCapabilitiesSync(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    expect([...handlers.keys()]).toEqual(['capabilities_changed']);
    handlers.get('capabilities_changed')!({ version: 3 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['permissions'] });
  });
});
