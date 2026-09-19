/**
 * @vitest-environment jsdom
 *
 * A new conversation shows the power level it will actually run at (DOR-2103).
 *
 * The defect: a session nobody has written to yet has no `session_metadata`
 * row, `GET /api/sessions/:id` answers 404 for one with no transcript, and the
 * client filled that hole with the literal `'default'`. An operator whose
 * configured stop was Full autonomy opened a new chat, read "Default" on the
 * dial and in the rail, sent one message, and watched it become Full autonomy —
 * the turn was always going to run at their stop; only the screen was wrong,
 * and it was wrong at exactly the moment a person looks to check.
 *
 * This is the half of the claim only a render can make: the resolved mode
 * reaches the value the dial draws, so reintroducing a literal anywhere on that
 * path turns this file red. The half it cannot make — that the resolution
 * matches what the first turn will SEED, for every runtime and every stop — is
 * pinned server-side, where a runtime's real capability profile is importable:
 * `apps/server/src/services/session/origin/__tests__/configured-stop-on-screen.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExecutionDefaults } from '@dorkos/shared/schemas';
import { TransportProvider } from '@/layers/shared/model';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../use-session-status';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd' };
      return selector ? selector(state) : state;
    },
  };
});

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The runtime's own id for the Full-autonomy stop, in the capability profile
 * `createMockTransport` serves. Named rather than inlined because the whole
 * point is that the screen reads it off the runtime; a test that hardcoded it
 * twice would pass against a client that hardcoded it once.
 */
const CLAUDE_AUTONOMY_MODE = 'bypassPermissions';

/** `config.executionDefaults` as the server reports it, for one set of stops. */
function executionDefaults(
  trustStop: ExecutionDefaults['trustStop'],
  perRuntime: ExecutionDefaults['perRuntime'] = []
): ExecutionDefaults {
  return { runtime: 'claude-code', trustStop, perRuntime };
}

/**
 * A transport whose config reports these defaults and whose session list is
 * whatever the caller says it is — the two inputs the start mode is resolved
 * from, plus the one that decides whether it is consulted at all.
 *
 * @param opts.defaults - What `GET /api/config` reports under `executionDefaults`.
 * @param opts.listed - Sessions the list endpoint answers with. A session in
 *   here has STARTED, and its own row is then the only answer.
 * @param opts.detail - What `GET /api/sessions/:id` answers, or undefined for
 *   the 404 a session with no transcript gets.
 */
function transportWith(opts: {
  defaults?: ExecutionDefaults;
  listed?: ReturnType<typeof createMockSession>[];
  detail?: ReturnType<typeof createMockSession>;
}) {
  const base = createMockTransport();
  return createMockTransport({
    getConfig: vi.fn().mockImplementation(async () => ({
      ...(await base.getConfig()),
      ...(opts.defaults ? { executionDefaults: opts.defaults } : {}),
    })),
    listSessions: vi.fn().mockResolvedValue({ sessions: opts.listed ?? [] }),
    getSession: vi.fn().mockResolvedValue(opts.detail),
  });
}

function createWrapper(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('the trust dial on a conversation nobody has written to yet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the configured stop, not the literal Default', async () => {
    const transport = transportWith({ defaults: executionDefaults('autonomy') });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionMode).toBe(CLAUDE_AUTONOMY_MODE));
  });

  it('shows the per-runtime override where one narrows the global stop', async () => {
    // Global says ask; this runtime says autonomy. The client reads the same
    // precedence the server seeds with — the per-runtime leaf first, then the
    // global one — so the dial and the first turn cannot land differently.
    const transport = transportWith({
      defaults: executionDefaults('ask', [
        {
          runtime: 'claude-code',
          model: null,
          trustStop: 'autonomy',
          effort: null,
          supportsEffort: true,
        },
      ]),
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionMode).toBe(CLAUDE_AUTONOMY_MODE));
  });

  it("falls back to the runtime's own declared default when nothing is configured", async () => {
    // Nobody answered the power door. The seed writes NULL, the column means
    // "the runtime decides", and what it decides is the mode it declares as its
    // default — which for claude-code happens to be called `default`, and is
    // read off the profile rather than typed here.
    const transport = transportWith({ defaults: executionDefaults(null) });
    const declared = (await transport.getCapabilities()).capabilities['claude-code'];

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() =>
      expect(result.current.permissionMode).toBe(declared?.permissionModes.default)
    );
  });

  it('never overrules a session that has started', async () => {
    // The direction that matters as much as the fix: a resolved guess must not
    // displace a stored value. This session is in the list AND has a row, and
    // its row says the safest stop while the operator's default says the
    // loosest — so a dial reading `bypassPermissions` here would be claiming a
    // power the session does not have.
    const started = createMockSession({ id: SESSION_ID, permissionMode: 'default' });
    const transport = transportWith({
      defaults: executionDefaults('autonomy'),
      listed: [started],
      detail: started,
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(transport.getSession).toHaveBeenCalled());
    // Settled, and still the stored value — asserted after a flush so this is
    // the resting state rather than a frame the resolution had not reached yet.
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
  });

  it('lets a choice made before the first message win over the configured stop', async () => {
    // `saveSessionSettings` creates an UNBOUND row for a settings change made
    // before sending (DOR-812), and the binding write then fills only columns
    // still holding NULL — so the person's choice survives the seed. The client
    // has to agree: the PATCH's own response is written into the detail cache,
    // and the row it puts there outranks anything resolved from config.
    const transport = transportWith({ defaults: executionDefaults('autonomy') });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionMode).toBe(CLAUDE_AUTONOMY_MODE));

    vi.mocked(transport.updateSession).mockResolvedValue(
      createMockSession({ id: SESSION_ID, permissionMode: 'plan' })
    );
    await result.current.updateSession({ permissionMode: 'plan' });

    await waitFor(() => expect(result.current.permissionMode).toBe('plan'));
  });
});
