/**
 * @vitest-environment jsdom A new conversation shows the power level it will actually run at
 * (DOR-2103).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExecutionDefaults, SessionSettings } from '@dorkos/shared/schemas';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { TransportProvider } from '@/layers/shared/model';
import { createMockSession, createMockTransport } from '@dorkos/test-utils/mock-factories';
import { useSessionStatus } from '../use-session-status';

/** The working directory, mutable so one case can let it LAND mid-render. */
const appState: { selectedCwd: string | null } = { selectedCwd: '/test/cwd' };

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(appState) : appState,
  };
});

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The runtime's own id for the Full-autonomy stop, in the capability profile
 * `createMockTransport` serves.
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
  /** Make `GET /api/capabilities` fail, the way an unreachable server does. */
  capabilitiesFail?: boolean;
  /** Make `GET /api/sessions/:id` fail for a session the list already carries. */
  detailFail?: boolean;
  listed?: ReturnType<typeof createMockSession>[];
  detail?: ReturnType<typeof createMockSession>;
  stored?: SessionSettings | null;
  /** A runtime to add to the capability map, built off the shipped claude-code profile. */
  extraRuntime?: { type: string; permissionModes: RuntimeCapabilities['permissionModes'] };
}) {
  const base = createMockTransport();
  return createMockTransport({
    getConfig: vi.fn().mockImplementation(async () => ({
      ...(await base.getConfig()),
      ...(opts.defaults ? { executionDefaults: opts.defaults } : {}),
    })),
    listSessions: vi.fn().mockResolvedValue({ sessions: opts.listed ?? [] }),
    getSession: opts.detailFail
      ? vi.fn().mockRejectedValue(new Error('session read failed'))
      : vi.fn().mockResolvedValue(opts.detail),
    getStoredSessionSettings: vi.fn().mockResolvedValue(opts.stored ?? null),
    ...(opts.capabilitiesFail
      ? { getCapabilities: vi.fn().mockRejectedValue(new Error('capabilities read failed')) }
      : {}),
    ...(opts.extraRuntime
      ? {
          getCapabilities: vi.fn().mockImplementation(async () => {
            const shipped = await base.getCapabilities();
            const { type, permissionModes } = opts.extraRuntime!;
            // Built off a real profile so the added runtime is complete in
            // every field but the one the case is about.
            const template = shipped.capabilities['claude-code'] as RuntimeCapabilities;
            return {
              capabilities: {
                ...shipped.capabilities,
                [type]: {
                  ...template,
                  type,
                  permissionModes,
                  settings: { ...template.settings, configSection: null },
                },
              },
              defaultRuntime: shipped.defaultRuntime,
            };
          }),
        }
      : {}),
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
    appState.selectedCwd = '/test/cwd';
  });

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('shows the configured stop, not the literal Default', async () => {
    const transport = transportWith({ defaults: executionDefaults('autonomy') });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionMode).toBe(CLAUDE_AUTONOMY_MODE));
  });

  it("falls back to the runtime's own declared default when nothing is configured", async () => {
    // Nobody answered the power door.
    const transport = transportWith({ defaults: executionDefaults(null) });
    const declared = (await transport.getCapabilities()).capabilities['claude-code'];

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() =>
      expect(result.current.permissionMode).toBe(declared?.permissionModes.default)
    );
  });

  it('prefers a choice made before the first message after a reload', async () => {
    // THE PROBE (DOR-2103 review).
    const transport = transportWith({
      defaults: executionDefaults('autonomy'),
      listed: [],
      stored: { permissionMode: 'default' },
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() =>
      expect(transport.getStoredSessionSettings).toHaveBeenCalledWith(SESSION_ID)
    );
    await waitFor(() => expect(result.current.permissionModeKnown).toBe(true));
    expect(result.current.permissionMode).toBe('default');
    expect(result.current.permissionMode).not.toBe(CLAUDE_AUTONOMY_MODE);
  });

  it('still reads the row when the browser says it is offline', async () => {
    // PROBE F (DOR-2103 round 3).
    onlineManager.setOnline(false);
    const transport = transportWith({
      defaults: executionDefaults('autonomy'),
      stored: { permissionMode: 'plan' },
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    // Not merely settled — the read actually RAN and its value is on screen,
    // which is the difference `networkMode: 'always'` makes.
    await waitFor(() => expect(result.current.permissionMode).toBe('plan'));
    expect(result.current.permissionModeKnown).toBe(true);
    expect(transport.getStoredSessionSettings).toHaveBeenCalledWith(SESSION_ID);
  });

  it('never overrules a session that has started', async () => {
    // The direction that matters as much as the fix: a resolved guess must not displace a stored
    // value.
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
    // `saveSessionSettings` creates an UNBOUND row for a settings change made before sending
    // (DOR-812), and the binding write then fills only columns still holding NULL — so the
    // person's choice survives the seed.
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
