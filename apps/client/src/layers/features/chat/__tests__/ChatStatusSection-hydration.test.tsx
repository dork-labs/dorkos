// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before the component import)
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('@/layers/shared/model/use-is-mobile', () => ({ useIsMobile: () => false }));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useActiveCapabilities: () => undefined,
  useDefaultCapabilities: () => undefined,
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
      showShortcutChips: false,
      showStatusBarCwd: false,
      showStatusBarPermission: false,
      showStatusBarModel: false,
      showStatusBarCost: true,
      showStatusBarContext: true,
      showStatusBarCache: true,
      showStatusBarUsage: false,
      showStatusBarGit: false,
      showStatusBarSound: false,
      showStatusBarPolling: false,
      enableNotificationSound: false,
      setEnableNotificationSound: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
      setShowStatusBarCwd: vi.fn(),
      setShowStatusBarGit: vi.fn(),
      setShowStatusBarPermission: vi.fn(),
      setShowStatusBarModel: vi.fn(),
      setShowStatusBarCost: vi.fn(),
      setShowStatusBarContext: vi.fn(),
      setShowStatusBarCache: vi.fn(),
      setShowStatusBarUsage: vi.fn(),
      setShowStatusBarSound: vi.fn(),
      setShowStatusBarPolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Stub the heavy ContextMenu/Tooltip primitives so the REAL CostItem/ContextItem
// render inline (we assert their snapshot-derived output).
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

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    // Keep the real CostItem / ContextItem / CacheItem — assert their output.
    StatusLine: Object.assign(
      ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      {
        Item: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
          visible ? <div>{children}</div> : null,
      }
    ),
    useGitStatus: vi.fn(() => ({ data: undefined })),
    StatusBarConfigurePopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    // System-managed items use the real StatusLine.Item context internally; stub
    // them so the mocked StatusLine doesn't trip their context guard. Not under test.
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
  onChipClick: vi.fn(),
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
      cacheStats: { cacheReadTokens: 1000, cacheCreationTokens: 250 },
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
    },
    pendingInteractions: [],
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
