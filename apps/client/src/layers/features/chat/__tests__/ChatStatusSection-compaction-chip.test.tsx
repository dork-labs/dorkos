// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ContextUsage } from '@dorkos/shared/types';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before the component import) — modeled on the hydration suite,
// keeping the REAL ContextItem and CompactionChip so their rendered output is
// what's compared.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('@/layers/shared/model/use-is-mobile', () => ({ useIsMobile: () => false }));

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

// A DELIBERATELY DIVERGENT coarse estimate (90) vs the SDK breakdown's 82.4:
// both surfaces must prefer the SDK percentage, so any edit that changes one
// derivation and not the other makes the two rendered numbers differ.
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: '/test/dir',
    model: 'default',
    costUsd: null,
    contextPercent: 90,
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
  useTransport: vi.fn(() => ({ runCommandIntent: vi.fn() })),
}));

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      showShortcutChips: false,
      showStatusBarCwd: false,
      showStatusBarPermission: false,
      showStatusBarModel: false,
      showStatusBarContext: true,
      showStatusBarCache: false,
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
      setShowStatusBarContext: vi.fn(),
      setShowStatusBarCache: vi.fn(),
      setShowStatusBarUsage: vi.fn(),
      setShowStatusBarSound: vi.fn(),
      setShowStatusBarPolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Stub the heavy ContextMenu/Tooltip primitives so the REAL ContextItem renders
// inline.
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
    // Keep the real ContextItem — its rendered percent is one side of the assert.
    StatusLine: Object.assign(
      ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      {
        Item: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
          visible ? <div>{children}</div> : null,
      }
    ),
    useGitStatus: vi.fn(() => ({ data: undefined })),
    StatusBarConfigurePopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ConnectionItem: () => null,
    SubagentsItem: () => null,
  };
});

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks
// ──────────────────────────────────────────────────────────────────────────────

import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { useSessionChatStore } from '@/layers/entities/session';

const SESSION_ID = 'percent-session-1';

const props = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  onChipClick: vi.fn(),
  syncConnectionState: 'connected' as const,
};

/** An SDK breakdown whose percentage (82.4) rounds differently from the coarse 90. */
const contextUsage: ContextUsage = {
  totalTokens: 164_800,
  maxTokens: 200_000,
  percentage: 82.4,
  model: 'claude-opus-4-6',
  categories: [],
};

beforeEach(() => {
  useSessionChatStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatStatusSection — compaction chip percent (DOR-112)', () => {
  it('renders the SAME percent in the chip as in the ContextItem for one contextUsage', () => {
    // Purpose: the chip's "Context N% full" copy and the ContextItem badge it
    // sits beside must derive N from one source. The coarse estimate is pinned
    // to a divergent 90 above, so if a future edit switches either surface to
    // a different derivation, the two rendered numbers stop matching.
    act(() => {
      useSessionChatStore.getState().updateSession(SESSION_ID, { contextUsage });
    });

    render(<ChatStatusSection {...props} />);

    // ContextItem's badge: "<percent>%" (SDK-preferred: round(82.4) = 82).
    const badgeText = screen.getByText(/^\d+%$/).textContent ?? '';
    const badgePercent = Number(badgeText.replace('%', ''));

    // The chip's copy: "Context <percent>% full — Compact now".
    const chip = screen.getByTestId('compaction-chip');
    const chipMatch = /Context (\d+)% full/.exec(chip.textContent ?? '');
    expect(chipMatch).not.toBeNull();
    const chipPercent = Number(chipMatch![1]);

    expect(chipPercent).toBe(badgePercent);
    // Guard against both surfaces silently switching to the coarse estimate
    // together — the SDK percentage must win when a breakdown exists.
    expect(chipPercent).toBe(82);
  });
});
