// @vitest-environment jsdom
/** Failed lookups keep the same neutral surface as a lookup still out. */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { agentKeys } from '@/layers/entities/agent';
import { useSessionSurface } from '../model/use-session-surface';

vi.mock('@/layers/entities/config', () => ({
  useDmViewState: () => ({ enabled: true, settled: true }),
  useConfig: () => ({ data: {} }),
  useShowSessions: () => false,
}));
vi.mock('@/layers/entities/session', () => ({
  useSessionSearch: () => ({ view: undefined }),
}));

const PATH = '/agents/folder-is-not-a-name';
const TERN = { id: 'tern', name: 'tern', displayName: 'Tern' } as AgentManifest;

afterEach(() => {
  cleanup();
  useAppStore.setState({ selectedCwd: null });
});

describe.each([new Error('500'), new TypeError('Failed to fetch')])(
  'lookup failure: %s',
  (error) => {
    it.each([false, true])('keeps the neutral surface, kept name: %s', async (kept) => {
      useAppStore.setState({ selectedCwd: PATH });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      if (kept) client.setQueryData(agentKeys.resolved([PATH]), { [PATH]: TERN });
      const transport = createMockTransport({ findDirectChat: vi.fn().mockRejectedValue(error) });
      const { result, rerender } = renderHook(({ answer }) => useSessionSurface('s', answer), {
        initialProps: { answer: null as AgentManifest | null },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>
            <TransportProvider transport={transport}>{children}</TransportProvider>
          </QueryClientProvider>
        ),
      });
      await waitFor(() => expect(transport.findDirectChat).toHaveBeenCalled());
      await waitFor(() =>
        expect(result.current.transcriptNames).toMatchObject({ lookupFailed: true })
      );
      expect(result.current.directMessage).toMatchObject({ settled: false });
      expect(result.current.directMessage?.agent?.displayName ?? null).toBe(kept ? 'Tern' : null);
      expect(result.current.placeholder).toBe(kept ? 'Message Tern' : 'Send a message…');
      expect(result.current.quietTurnNumbers).toBe(true);

      expect(transport.resolveAgents).not.toHaveBeenCalled();

      // A newer answer beats the sidebar's kept identity without changing surfaces.
      if (kept) {
        await act(async () => {
          client.setQueryData(agentKeys.resolved([PATH]), {
            [PATH]: { ...TERN, displayName: 'New Tern' },
          });
        });
        expect(result.current.placeholder).toBe('Message New Tern');
        rerender({ answer: { ...TERN, displayName: 'Answered Tern' } });
        expect(result.current.placeholder).toBe('Message Answered Tern');
      }
    });
  }
);
