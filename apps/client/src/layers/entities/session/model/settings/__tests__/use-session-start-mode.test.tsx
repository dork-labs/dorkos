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
import type { ExecutionDefaults, SessionSettings } from '@dorkos/shared/schemas';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
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

/**
 * A runtime whose declared default is NOT the word "default".
 *
 * This declaration is the whole reason the fallback can be tested at all. Every
 * shipped production runtime happens to call its ask-stop mode `'default'`, so
 * against those the honest answer and the literal the client used to print are
 * the same string, and a case built on one of them cannot tell them apart —
 * measured: re-introducing `?? 'default'` in the hook left 154 client test
 * files green (DOR-2103 review). `test-mode` ships exactly this shape on
 * purpose, and this mirrors it.
 */
const QUIRK_MODES: RuntimeCapabilities['permissionModes'] = {
  supported: true,
  default: 'always-allow',
  values: [
    {
      id: 'always-allow',
      label: 'Always allow',
      stop: 'autonomy',
      asks: 'never',
      reach: 'everything',
      promise: 'Runs everything without asking.',
    },
  ],
};

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

  it("shows a runtime's own declared default when that default is not called 'default'", async () => {
    // THE case that can tell the honest answer from the literal. Nothing is
    // configured, this runtime declares no mode at any stop but autonomy, and
    // its declared default is `always-allow` — so the honest answer and the
    // string the client used to print differ, and only one of them passes.
    const transport = transportWith({
      defaults: executionDefaults(null),
      extraRuntime: { type: 'quirk', permissionModes: QUIRK_MODES },
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'quirk'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionMode).toBe('always-allow'));
  });

  it('prefers a choice made before the first message after a reload', async () => {
    // THE PROBE (DOR-2103 review). A settings change made before sending writes
    // a `session_metadata` row with no runtime (DOR-812). Nothing on the client
    // survives a reload, and `GET /api/sessions/:id` 404s for a session with no
    // transcript, so before `getStoredSessionSettings` existed the dial fell
    // back to the operator's configured stop — reading Full autonomy for a
    // conversation the person had deliberately moved DOWN to Default. Wrong in
    // the one direction this product must never be wrong in.
    //
    // The reload shape exactly: list empty (never started), no detail row, a
    // stored row present.
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

  it('says nothing at all on the first frame of a cold load', async () => {
    // The reported symptom, compressed: every query cold, so nothing has
    // answered what this session runs at — and `permissionMode` carries
    // `resolvePermissionMode`'s placeholder, which is shaped exactly like a
    // real answer. A surface that painted it would read "Default" for a few
    // frames and then flip, which is the same wrong sentence the ticket is
    // about. `permissionModeKnown` is what the permissions control gates on.
    const transport = transportWith({ defaults: executionDefaults('autonomy') });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    // First frame, before any query has settled.
    expect(result.current.permissionModeKnown).toBe(false);
    // And it resolves to the real stop rather than staying unknown.
    await waitFor(() => expect(result.current.permissionModeKnown).toBe(true));
    expect(result.current.permissionMode).toBe(CLAUDE_AUTONOMY_MODE);
  });

  it('does not ask for stored settings once a session has started', async () => {
    // A rail of listed conversations must not cost one request per row: a
    // started session's settings already ride its `Session`, overlaid
    // server-side from the same row.
    const started = createMockSession({ id: SESSION_ID, permissionMode: 'default' });
    const transport = transportWith({ listed: [started], detail: started });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionModeKnown).toBe(true));
    expect(transport.getStoredSessionSettings).not.toHaveBeenCalled();
  });

  it('stops asking when the capability read fails, instead of pulsing forever', async () => {
    // PROBE B (DOR-2103 re-review). `startMode` is `undefined` both while the
    // capability map is loading and once it has failed, and the first version
    // of the flag could not tell those apart — so a session on an unreachable
    // server pulsed for the lifetime of the window. Settled means "nothing
    // more is coming", which a failure satisfies.
    const transport = transportWith({
      defaults: executionDefaults('autonomy'),
      capabilitiesFail: true,
    });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionModeKnown).toBe(true));
    // No answer to be had, so the control falls back to the placeholder and
    // draws it — rather than claiming to still be working.
    expect(result.current.permissionMode).toBe('default');
  });

  it('falls back to the list row when a started session detail read fails', async () => {
    // PROBE C (DOR-2103 re-review). The rail renders this session at Full
    // power off its LIST row while the status line waited forever on the
    // failed detail read — one session described two ways, one of them a
    // spinner. The list row is stored truth for a started session, so it is
    // the answer here too.
    const started = createMockSession({ id: SESSION_ID, permissionMode: 'bypassPermissions' });
    const transport = transportWith({ listed: [started], detailFail: true });

    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.permissionModeKnown).toBe(true));
    expect(result.current.permissionMode).toBe('bypassPermissions');
  });

  it('has nothing to be loading when no session is selected', async () => {
    // PROBE A (DOR-2103 re-review), at the hook. The embed's session store
    // starts null and resets on every directory switch, so this is an ordinary
    // resting state — and the first version reported it as "still loading"
    // forever. Nothing is loading; there is no session to load anything for.
    const transport = transportWith({ defaults: executionDefaults('autonomy') });

    const { result } = renderHook(() => useSessionStatus(null, null, false, 'claude-code'), {
      wrapper: createWrapper(transport),
    });

    expect(result.current.permissionModeKnown).toBe(true);
    expect(result.current.permissionMode).toBe('default');
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
