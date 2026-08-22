// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { useSessionChatStore } from '@/layers/entities/session';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before component import)
// ──────────────────────────────────────────────────────────────────────────────

// The Trust Dial reads the standing Full-autonomy acknowledgement from user
// config before it sends one. Defaults to "nobody has acknowledged anything",
// which is the shipped state and the one most cases below assume; the
// leaving-Plan case sets it, because that is the state it is about.
const standingAck = { current: null as string | null };
vi.mock('@/layers/entities/config/model/use-autonomy-acknowledgement', () => ({
  useAutonomyAcknowledgement: () => ({
    acknowledgedAt: standingAck.current,
    acknowledge: vi.fn(),
    clear: vi.fn(),
    canRemember: true,
    isPending: false,
  }),
}));

// The status line now also asks where NEW sessions start, so it reads config and
// can write it (spec `trust-dial`, decision 6C). Stubbed to "nothing configured,
// writes go nowhere" — the offer is its own suite's subject
// (`ChatStatusSection-make-default.test.tsx`), and every case below is about
// something else.
vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: undefined }),
}));
vi.mock('@/layers/entities/config/model/use-update-config', () => ({
  useUpdateConfig: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

/** Claude's declared modes — `plan` is the way of working the chip is built on. */
const CLAUDE_CAPS: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      {
        id: 'plan',
        label: 'Plan',
        stop: 'ask',
        axis: 'working',
        asks: 'always',
        reach: 'read',
        promise: 'Reads and plans only. Nothing changes until you approve the plan.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

/** A runtime that declares no way of working at all. */
const CODEX_CAPS: RuntimeCapabilities = {
  ...CLAUDE_CAPS,
  type: 'codex',
  permissionModes: {
    supported: true,
    default: 'default',
    values: CLAUDE_CAPS.permissionModes.values.filter((v) => v.id !== 'plan'),
  },
};

const caps = { current: CLAUDE_CAPS as RuntimeCapabilities | undefined };

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useCapabilitiesForRuntime: () => caps.current,
  useRuntimeCapabilities: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => ({ sessions: [], isLoading: false }) as never,
}));

// Returns a promise, like the hook it stands in for: `useSessionStatus`'s
// `updateSession` is an async function, and the status line now waits on it
// before offering to make a stop the default (spec `trust-dial`, decision 6C).
// A mock that answered `undefined` would be lying about the contract.
const updateSession = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
const permissionMode = { current: 'default' };
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: permissionMode.current,
    cwd: '/test/dir',
    model: 'claude-opus-4-8',
    costUsd: null,
    contextPercent: null,
    updateSession,
  }),
}));

vi.mock('@/layers/entities/session/model/use-models', () => ({
  useModels: () => ({
    data: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsAutoMode: false }],
  }),
}));

vi.mock('@/layers/entities/session/model/use-subagents', () => ({
  useSubagents: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/workspace', () => ({
  useWorkspaceForSession: () => null,
}));

vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({ runCommandIntent: vi.fn() })),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      pendingAccount: null,
      setPendingAccount: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../ui/status/AgentIdentityChip', () => ({
  AgentIdentityChip: () => null,
}));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    StatusLine: ({ items }: { items: { key: string; node: React.ReactNode }[] }) => (
      <div data-testid="status-line">
        {items.map((item) => (
          <div key={item.key}>{item.node}</div>
        ))}
      </div>
    ),
    CwdItem: () => null,
    GitStatusItem: () => null,
    PermissionModeItem: ({ onChangeMode }: { onChangeMode: (m: string) => void }) => (
      <>
        <button
          type="button"
          data-testid="select-autonomy"
          onClick={() => onChangeMode('bypassPermissions')}
        >
          select autonomy
        </button>
        <button type="button" data-testid="select-act" onClick={() => onChangeMode('acceptEdits')}>
          select act
        </button>
      </>
    ),
    ModelConfigPopover: () => null,
    ContextItem: () => null,
    UsageStatusItem: () => null,
    ConnectionItem: () => null,
    SubagentsItem: () => null,
    SessionPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useGitStatus: vi.fn(() => ({ data: undefined })),
    // `default` permissions are quiet by design, and this suite drives mode
    // changes from that item — pin it into the line. Pins live in server config;
    // stub the bridge so no query client or transport is needed.
    useStatusBarPins: () => ({ pins: ['permission'], toggle: vi.fn(), reset: vi.fn() }),
  };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// Import after mocks
import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { TooltipProvider } from '@/layers/shared/ui';

/** The app shell provides one; the status line's items assume it. */
function renderSection() {
  return render(
    <TooltipProvider>
      <ChatStatusSection {...defaultProps} />
    </TooltipProvider>
  );
}

const SESSION_ID = 'plan-session-1';

const defaultProps = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

/** The composer's Plan switch. */
function planChip() {
  return screen.getByRole('button', { name: /plan/i });
}

/**
 * Assert the settings PATCH the component sent, ignoring the handlers bag beside
 * it. Mode changes carry an `onError` so a refused Full-autonomy write can
 * reopen the door rather than surface a raw error — which is behavior of its own
 * and not something every assertion about a permission mode should restate.
 */
function expectPatched(payload: Record<string, unknown>): void {
  expect(updateSession.mock.calls[0]?.[0]).toEqual(payload);
}

beforeEach(() => {
  updateSession.mockClear();
  caps.current = CLAUDE_CAPS;
  permissionMode.current = 'default';
  standingAck.current = null;
  useSessionChatStore.setState({ modeBeforePlan: {}, autonomyConfirmedSessions: {} });
});

afterEach(cleanup);

describe('ChatStatusSection — the door into Full autonomy', () => {
  it('asks before it writes — selecting the autonomy stop patches nothing', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('says what THIS agent means by it, in the runtime’s own sentence', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Runs everything without asking, including outside this project.'
    );
    // …and what it does not cover.
    expect(screen.getByText(/covers tools inside the session/i)).toBeInTheDocument();
  });

  it('applies the mode once confirmed, and remembers the session said yes', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    // The acknowledgement rides the request that needs it: the server refuses
    // this mode without one, so confirming and patching are one act.
    expectPatched({ permissionMode: 'bypassPermissions', acknowledgedAutonomy: true });
    expect(useSessionChatStore.getState().autonomyConfirmedSessions[SESSION_ID]).toBe(true);
  });

  it('leaves the session alone when cancelled', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateSession).not.toHaveBeenCalled();
    expect(useSessionChatStore.getState().autonomyConfirmedSessions[SESSION_ID]).toBeUndefined();
  });

  it('asks once per session, not once per switch', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));
    updateSession.mockClear();

    fireEvent.click(screen.getByTestId('select-autonomy'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // Still acknowledged — the session remembers saying yes, so the second
    // switch asserts that consent instead of asking for it again.
    expectPatched({ permissionMode: 'bypassPermissions', acknowledgedAutonomy: true });
  });

  it('never stands between a person and a stop that still asks', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('select-act'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // No acknowledgement on a stop that still asks — the flag is only ever sent
    // where the server would refuse without it.
    expectPatched({ permissionMode: 'acceptEdits' });
  });
});

describe('ChatStatusSection — the composer’s Plan switch', () => {
  it('is offered on a runtime that declares a way of working', () => {
    renderSection();

    expect(planChip()).toHaveAttribute('aria-pressed', 'false');
  });

  it('is absent on a runtime that declares none', () => {
    caps.current = CODEX_CAPS;
    renderSection();

    expect(screen.queryByRole('button', { name: /plan/i })).not.toBeInTheDocument();
  });

  it('switches the session into the runtime’s planning mode', () => {
    renderSection();

    fireEvent.click(planChip());
    expectPatched({ permissionMode: 'plan' });
  });

  it('reads as on while the session is planning', () => {
    permissionMode.current = 'plan';
    renderSection();

    expect(planChip()).toHaveAttribute('aria-pressed', 'true');
  });

  it('puts the session back where it was when switched off', () => {
    // On at Act…
    permissionMode.current = 'acceptEdits';
    const { rerender } = renderSection();
    fireEvent.click(planChip());
    expectPatched({ permissionMode: 'plan' });

    // …and off again returns to Act, not to the runtime's default.
    permissionMode.current = 'plan';
    rerender(
      <TooltipProvider>
        <ChatStatusSection {...defaultProps} />
      </TooltipProvider>
    );
    updateSession.mockClear();
    fireEvent.click(planChip());
    expectPatched({ permissionMode: 'acceptEdits' });
  });

  it('carries the acknowledgement when the mode it restores is Full autonomy', () => {
    // The one click OUT of planning, for a session that was running without
    // asking before it went in. The server refuses that mode without an
    // acknowledgement, so leaving Plan has to assert the standing one like any
    // other autonomy write — otherwise this exact click is the one that 428s,
    // and it is not a click a person can route around.
    standingAck.current = '2026-08-01T09:30:00.000Z';
    useSessionChatStore.setState({ modeBeforePlan: { [SESSION_ID]: 'bypassPermissions' } });
    permissionMode.current = 'plan';
    renderSection();

    fireEvent.click(planChip());

    expectPatched({ permissionMode: 'bypassPermissions', acknowledgedAutonomy: true });
  });

  it('does not restore a remembered mode the runtime no longer offers', () => {
    // The runtime can change under a session before its first message. Restoring
    // a mode that is gone would PATCH something the server rejects, on the one
    // path out of planning.
    useSessionChatStore.setState({ modeBeforePlan: { [SESSION_ID]: 'auto' } });
    permissionMode.current = 'plan';
    renderSection();

    fireEvent.click(planChip());
    expectPatched({ permissionMode: 'default' });
  });

  it('falls back to the runtime’s default when it was already planning on arrival', () => {
    // Nothing remembered — the session was opened mid-plan.
    permissionMode.current = 'plan';
    renderSection();

    fireEvent.click(planChip());
    expectPatched({ permissionMode: 'default' });
  });
});
