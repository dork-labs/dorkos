/**
 * @vitest-environment jsdom
 *
 * The header never shows a runtime and model that cannot go together, and a
 * settings change never moves the model (DOR-2712).
 *
 * Seen live: a session opened under an id the list did not carry showed the
 * server's default runtime (Codex). Changing its permission mode then cached
 * the settings response, which the server read off Claude Code, and the header
 * said "Codex · Opus" though nobody had changed runtime or model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../use-session-status';
import { sessionKeys } from '../../../api/query-keys';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd', pendingAccount: null };
      return selector ? selector(state) : state;
    },
  };
});

const SESSION_ID = '22222222-2222-4222-8222-222222222712';

const CODEX_MODELS = [
  { value: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Default', isDefault: true },
];

function createWrapper(
  transport: ReturnType<typeof createMockTransport>,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useSessionStatus — runtime and model go together (DOR-2712)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never shows another runtime's model under the runtime it shows", async () => {
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue(
          createMockSession({ id: SESSION_ID, runtime: 'claude-code', model: 'claude-opus-4-8' })
        ),
      getModels: vi.fn().mockResolvedValue(CODEX_MODELS),
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'codex'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(transport.getSession).toHaveBeenCalled());
    await waitFor(() => expect(result.current.model).toBe('gpt-6-astra'));
  });

  it('keeps the model when only the permission mode changes', async () => {
    // The detail read found nothing, so there is no model on record yet.
    const transport = createMockTransport({
      getSession: vi.fn().mockRejectedValue(new Error('Session not found')),
      getModels: vi.fn().mockResolvedValue(CODEX_MODELS),
      // The server answers the write with whatever its runtime read back.
      updateSession: vi
        .fn()
        .mockResolvedValue(
          createMockSession({ id: SESSION_ID, runtime: 'codex', model: 'claude-opus-4-8' })
        ),
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'codex'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.model).toBe('gpt-6-astra'));

    await result.current.updateSession({ permissionMode: 'acceptEdits' });

    await waitFor(() => expect(transport.updateSession).toHaveBeenCalled());
    expect(result.current.model).toBe('gpt-6-astra');
  });

  it("never caches the server's runtime guess for a session no runtime owns yet", async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockRejectedValue(new Error('Session not found')),
      getModels: vi.fn().mockResolvedValue(CODEX_MODELS),
      updateSession: vi.fn().mockResolvedValue({
        ...createMockSession({ id: SESSION_ID, runtime: 'claude-code', permissionMode: 'plan' }),
        runtimeUnbound: true,
      }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'codex'), {
      wrapper: createWrapper(transport, queryClient),
    });
    await result.current.updateSession({ permissionMode: 'plan' });

    const cached = queryClient.getQueryData<{ runtime?: string; permissionMode?: string }>(
      sessionKeys.detail(SESSION_ID, null)
    );
    expect(cached?.permissionMode).toBe('plan');
    expect(cached?.runtime).toBeUndefined();
  });
});
