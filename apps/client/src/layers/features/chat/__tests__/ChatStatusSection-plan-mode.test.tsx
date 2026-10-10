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
  supportsAccounts: true,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  mediaOutput: 'none',
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

vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: [], isLoading: false }) as never,
}));

// Returns a promise, like the hook it stands in for: `useSessionStatus`'s
// `updateSession` is an async function, and the status line now waits on it
// before offering to make a stop the default (spec `trust-dial`, decision 6C).
// A mock that answered `undefined` would be lying about the contract.
const updateSession = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
const permissionMode = { current: 'default' };
vi.mock('@/layers/entities/session/model/settings/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: permissionMode.current,
    // A SETTLED session: something has answered what it runs at, so the
    // permissions control draws the mode rather than its loading placeholder
    // (DOR-2103). Omitting it made every one of these trees render the
    // placeholder, silently — `vi.mock` factories are not checked against the
    // module's own types, so nothing said so.
    permissionModeKnown: true,
    cwd: '/test/dir',
    model: 'claude-opus-4-8',
    costUsd: null,
    contextPercent: null,
    updateSession,
  }),
}));

vi.mock('@/layers/entities/session/model/query/use-models', () => ({
  useModels: () => ({
    data: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsAutoMode: false }],
  }),
}));

vi.mock('@/layers/entities/session/model/query/use-subagents', () => ({
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
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn(), getQueryData: vi.fn() })),
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
 * Assert the settings PATCH the component sent: the whole argument list, so an
 * acknowledgement or a handlers bag riding along fails it.
 */
function expectPatched(payload: Record<string, unknown>): void {
  expect(updateSession.mock.calls[0]).toEqual([payload]);
}

beforeEach(() => {
  updateSession.mockClear();
  caps.current = CLAUDE_CAPS;
  permissionMode.current = 'default';
  useSessionChatStore.setState({ modeBeforePlan: {} });
});

afterEach(cleanup);

describe('ChatStatusSection — Full autonomy is a normal choice', () => {
  it('writes the autonomy stop straight through, with no dialog and no acknowledgement', () => {
    // ADR 261006-225605 retired the consent ritual. Before it, this click opened
    // a confirm dialog and patched nothing until it was answered.
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(updateSession).toHaveBeenCalledTimes(1);
    expectPatched({ permissionMode: 'bypassPermissions' });
  });

  it('writes a stop that still asks the same way', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('select-act'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
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

  it('restores Full autonomy on leaving Plan, with no acknowledgement', () => {
    // The one click OUT of planning, for a session that was running without
    // asking before it went in.
    useSessionChatStore.setState({ modeBeforePlan: { [SESSION_ID]: 'bypassPermissions' } });
    permissionMode.current = 'plan';
    renderSection();

    fireEvent.click(planChip());

    expectPatched({ permissionMode: 'bypassPermissions' });
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
