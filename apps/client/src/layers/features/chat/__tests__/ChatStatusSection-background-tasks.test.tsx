// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before the component import)
// ──────────────────────────────────────────────────────────────────────────────

// The Trust Dial reads the standing Full-autonomy acknowledgement from user
// config before it sends one. Stubbed to "nobody has acknowledged anything",
// which is the shipped state and the one every case below assumes.
vi.mock('@/layers/entities/config/model/use-autonomy-acknowledgement', () => ({
  useAutonomyAcknowledgement: () => ({
    acknowledgedAt: null,
    acknowledge: vi.fn(),
    clear: vi.fn(),
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

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useCapabilitiesForRuntime: () => undefined,
  useRuntimeCapabilities: () => ({ data: undefined }),
}));

// The runtime chip reads the session list for its "started" signal; the real
// useSessions needs router search params, absent in this suite.
vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => ({ sessions: [], isLoading: false }) as never,
}));

// `useSessionStatus` reports the COLD state: no live event has arrived, so the
// derived context %/cost are null. The snapshot-backed stream store must fill
// these in on cold mount.
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: '/test/dir',
    model: 'default',
    costUsd: null,
    contextPercent: null,
    updateSession: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({})),
}));

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      // A healthy cost and a 20%-full window are quiet by design; pin them so this
      // suite still asserts what it is about — snapshot hydration on cold mount.
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Stub the heavy ContextMenu/Tooltip primitives so the REAL UsageStatusItem/
// ContextItem render inline (we assert their snapshot-derived output).
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/ui')>();
  const Pass = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const PassChild = ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  );
  return {
    ...actual,
    ContextMenu: Pass,
    ContextMenuTrigger: PassChild,
    ContextMenuContent: () => null,
    ContextMenuItem: Pass,
    ContextMenuSeparator: () => null,
    TooltipProvider: Pass,
    Tooltip: Pass,
    TooltipTrigger: PassChild,
    TooltipContent: Pass,
  };
});

// The identity chip needs a router; it is not part of the status line under test.
vi.mock('../ui/status/AgentIdentityChip', () => ({
  AgentIdentityChip: () => null,
}));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    // Keep the real UsageStatusItem / ContextItem — assert their output.
    StatusLine: ({ items }: { items: { key: string; node: React.ReactNode }[] }) => (
      <div>
        {items.map((item) => (
          <div key={item.key}>{item.node}</div>
        ))}
      </div>
    ),
    SessionPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useGitStatus: vi.fn(() => ({ data: undefined })),
    // Pins live in server config (`ui.statusBar.pins`); stub the bridge so this
    // suite needs no query client or transport.
    useStatusBarPins: () => ({ pins: ['usage', 'context'], toggle: vi.fn(), reset: vi.fn() }),
    ConnectionItem: () => null,
  };
});

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks
// ──────────────────────────────────────────────────────────────────────────────

import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { useSessionStreamStore } from '@/layers/entities/session';

const props = {
  sessionId: 'session-1',
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

/**
 * A hydrated session with `n` children the server counts as still running, in
 * whatever lifecycle the case is about.
 */
function snapshotWithChildren(
  n: number,
  lifecycle: SessionSnapshot['status']['lifecycle'] = 'idle',
  inProgressTurn: SessionSnapshot['inProgressTurn'] = null
) {
  return {
    messages: [],
    inProgressTurn,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: n,
      lifecycle,
      lastError: null,
    },
    pendingInteractions: [],
    queuedMessages: [],
    cursor: 3,
  } satisfies SessionSnapshot;
}

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// DOR-1100: an agent whose background tasks are still running has stopped
// talking but is not finished. The status line is where that shows.
describe('ChatStatusSection — background tasks outliving their turn', () => {
  it('reports the children the server still counts after the turn closed', () => {
    act(() => {
      useSessionStreamStore.getState().applySnapshot('session-1', snapshotWithChildren(2));
    });

    render(<ChatStatusSection {...props} />);

    expect(screen.getByLabelText('2 subagents running')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Still working in the background. The agent picks up again when they finish.'
      )
    ).toBeInTheDocument();
  });

  // The failure this replaces: the item was drawn from the turn's own events, so
  // the history reload that follows every `turn_end` emptied it while the
  // children were still working.
  it('keeps reporting them after the turn-end history reload empties the turn', () => {
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot('session-1', snapshotWithChildren(0));
      store.applyEvent('session-1', { type: 'turn_start', seq: 4 });
      store.applyEvent('session-1', {
        type: 'subagent_update',
        seq: 5,
        taskId: 'bt1',
        status: 'running',
        description: 'Run the test suite',
      });
      store.applyEvent('session-1', { type: 'turn_end', seq: 6 });
      store.setHistoryMessages('session-1', []);
    });

    render(<ChatStatusSection {...props} />);

    expect(useSessionStreamStore.getState().sessions['session-1']?.inProgressTurn).toEqual([]);
    expect(screen.getByLabelText('1 subagent running')).toBeInTheDocument();
  });

  it('draws no subagent item at all when nothing is running', () => {
    act(() => {
      useSessionStreamStore.getState().applySnapshot('session-1', snapshotWithChildren(0));
    });

    render(<ChatStatusSection {...props} />);

    expect(screen.queryByLabelText(/subagent/)).not.toBeInTheDocument();
  });

  // While the agent is talking the same count is ordinary delegation, and the
  // line stays quiet about it.
  it('does not explain the wait while the agent is streaming', () => {
    act(() => {
      useSessionStreamStore
        .getState()
        .applySnapshot('session-1', snapshotWithChildren(1, 'streaming'));
    });

    render(<ChatStatusSection {...props} isStreaming />);

    expect(screen.getByLabelText('1 subagent running')).toBeInTheDocument();
    expect(screen.queryByText(/Still working in the background/)).not.toBeInTheDocument();
  });

  // The sentence promises the agent picks up again when the children finish,
  // and that is only true of an IDLE session. These three are the states where
  // it would be a lie, and `isStreaming` collapses all of them into "not
  // streaming" — which is why the gate reads the projected lifecycle instead.
  for (const lifecycle of ['blocked', 'error', 'interrupted'] as const) {
    it(`does not promise a pick-up while the session is ${lifecycle}`, () => {
      act(() => {
        useSessionStreamStore
          .getState()
          .applySnapshot('session-1', snapshotWithChildren(2, lifecycle));
      });

      render(<ChatStatusSection {...props} />);

      // The count is still honest — those children really are running…
      expect(screen.getByLabelText('2 subagents running')).toBeInTheDocument();
      // …but nothing claims the agent is about to carry on.
      expect(screen.queryByText(/Still working in the background/)).not.toBeInTheDocument();
    });
  }
});
