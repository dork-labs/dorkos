/**
 * @vitest-environment jsdom
 *
 * The row the rail shows the instant you press Enter says the right power level
 * (DOR-2103).
 *
 * `POST /sessions/:id/messages` is trigger-only, so the sidebar's new row is
 * optimistic: the client writes it into the list cache and the server's
 * `session_upserted` replaces it a moment later. That row used to be born
 * `permissionMode: 'default'` — a literal — so for the whole round trip the
 * rail claimed a safety posture nobody had chosen, and then the row flipped.
 * It now carries what the first turn will actually run at, resolved the same
 * way the dial above it resolves it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExecutionDefaults } from '@dorkos/shared/schemas';
import type { Session } from '@dorkos/shared/types';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { sessionKeys } from '@/layers/entities/session';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import { useSessionSubmit } from '../use-session-submit';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CWD = '/test/project';
/** The id the mock capability profile gives its Full-autonomy stop. */
const CLAUDE_AUTONOMY_MODE = 'bypassPermissions';

/** `config.executionDefaults` as the server reports it. */
function executionDefaults(trustStop: ExecutionDefaults['trustStop']): ExecutionDefaults {
  return { runtime: 'claude-code', trustStop, perRuntime: [] };
}

/** A transport reporting one configured stop and an empty session list. */
function transportWith(trustStop: ExecutionDefaults['trustStop']) {
  const base = createMockTransport();
  return createMockTransport({
    getConfig: vi.fn().mockImplementation(async () => ({
      ...(await base.getConfig()),
      executionDefaults: executionDefaults(trustStop),
    })),
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    postMessage: vi.fn().mockResolvedValue({ sessionId: SESSION_ID }),
  });
}

describe('the optimistic session row states the power the first turn will run at', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    useAppStore.setState({ selectedCwd: CWD });
  });

  afterEach(() => {
    useAppStore.setState({ selectedCwd: null });
  });

  function renderSubmit(transport: ReturnType<typeof createMockTransport>) {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    return renderHook(
      () =>
        useSessionSubmit({
          sessionId: SESSION_ID,
          input: '',
          status: 'idle',
          transport,
          queryClient,
          selectedCwd: CWD,
          onSessionIdChangeReplace: undefined,
          transformContent: undefined,
          launchRuntime: undefined,
          takeSeedContext: undefined,
          setInput: vi.fn(),
          setError: vi.fn(),
          tryNativeCommand: vi.fn(() => ({ handled: false, ran: false, confirmed: undefined })),
        }),
      { wrapper }
    );
  }

  /** The optimistic row this send wrote into the list cache. */
  function insertedRow(): Session | undefined {
    return queryClient
      .getQueryData<Session[]>(sessionKeys.list(CWD))
      ?.find((session) => session.id === SESSION_ID);
  }

  it('carries the operator configured stop, not the literal Default', async () => {
    const transport = transportWith('autonomy');
    const { result } = renderSubmit(transport);
    // The resolution rides two cached queries; the send must happen after they
    // land, which is also the only ordering a person can produce (the composer
    // is on screen for at least a frame before anyone types into it).
    await waitFor(() => expect(transport.getCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    await waitFor(() => expect(transport.listSessions).toHaveBeenCalled());

    await act(async () => {
      await result.current.submitContent('hello');
    });

    expect(insertedRow()?.permissionMode).toBe(CLAUDE_AUTONOMY_MODE);
  });

  it('lets a choice made before the first message win over the configured stop', async () => {
    // A settings change before sending writes the detail cache (and, server
    // side, an unbound `session_metadata` row — DOR-812). The binding write
    // fills only columns still holding NULL, so that choice survives the seed;
    // the row the rail draws has to agree, or the rail and the status line
    // contradict each other for one round trip on the one path where the
    // person actually said what they wanted.
    const transport = transportWith('autonomy');
    const { result } = renderSubmit(transport);
    await waitFor(() => expect(transport.getCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    await waitFor(() => expect(transport.listSessions).toHaveBeenCalled());

    queryClient.setQueryData<Session>(
      sessionKeys.detail(SESSION_ID, CWD),
      createMockSession({ id: SESSION_ID, permissionMode: 'plan' })
    );

    await act(async () => {
      await result.current.submitContent('hello');
    });

    expect(insertedRow()?.permissionMode).toBe('plan');
  });
});
