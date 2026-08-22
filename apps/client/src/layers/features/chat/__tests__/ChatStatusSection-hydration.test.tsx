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
      pendingAccount: null,
      setPendingAccount: vi.fn(),
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
    TooltipContent: () => null,
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
    SubagentsItem: () => null,
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

function makeSnapshot(): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: null,
    status: {
      contextUsage: {
        totalTokens: 40_000,
        maxTokens: 200_000,
        outputTokens: 500,
        cacheReadTokens: 1000,
        cacheCreationTokens: 250,
      },
      cost: 0.1,
      usage: { kind: 'pay-as-you-go', costUsd: 0.1 },
      cacheStats: { cacheReadTokens: 1000, cacheCreationTokens: 250 },
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
    },
    pendingInteractions: [],
    queuedMessages: [],
    cursor: 3,
  };
}

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatStatusSection — snapshot-backed cold mount', () => {
  it('renders cost and context % from the hydrated snapshot when no live event has arrived', () => {
    // Purpose: on refresh/cold mount the status bar must show server-derived items
    // immediately from the snapshot, not wait for the first streaming event.
    act(() => {
      useSessionStreamStore.getState().applySnapshot('session-1', makeSnapshot());
    });

    render(<ChatStatusSection {...props} />);

    // Cost from snapshot.status.cost (0.10) — would be absent if read from the
    // legacy store (null on cold mount).
    expect(screen.getByText('$0.10')).toBeInTheDocument();
    // Context % derived from 40000 / 200000 = 20%.
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('does not render cost/context when the session has not hydrated', () => {
    // Purpose: with no snapshot and a cold legacy status, the server-derived items
    // stay hidden (no zero placeholders).
    render(<ChatStatusSection {...props} />);
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
    expect(screen.queryByText('20%')).not.toBeInTheDocument();
  });
});
