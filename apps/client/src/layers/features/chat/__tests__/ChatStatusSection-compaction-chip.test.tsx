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

// A DELIBERATELY DIVERGENT coarse estimate (99) vs the SDK breakdown's 88.4:
// both the badge and the inline action must prefer the SDK percentage, so any edit
// that changes one derivation and not the other makes the two numbers differ.
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: '/test/dir',
    model: 'default',
    costUsd: null,
    contextPercent: 99,
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
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
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

// The identity chip needs a router; it is not part of the status line under test.
vi.mock('../ui/status/AgentIdentityChip', () => ({
  AgentIdentityChip: () => null,
}));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    // Keep the real ContextItem — its rendered percent is one side of the assert.
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
    useStatusBarPins: () => ({ pins: [], toggle: vi.fn(), reset: vi.fn() }),
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
  syncConnectionState: 'connected' as const,
};

/** An SDK breakdown whose percentage (88.4) rounds differently from the coarse 99. */
const contextUsage: ContextUsage = {
  totalTokens: 176_800,
  maxTokens: 200_000,
  percentage: 88.4,
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

describe('ChatStatusSection — inline compact action percent (DOR-112)', () => {
  it('names the SAME percent in the action as the ContextItem badge beside it', () => {
    // Purpose: the action's "Context N% full" label and the badge it sits beside
    // must derive N from one source. The coarse estimate is pinned to a divergent
    // 99 above, so if a future edit switches either surface to a different
    // derivation, the two numbers stop matching.
    act(() => {
      useSessionChatStore.getState().updateSession(SESSION_ID, { contextUsage });
    });

    render(<ChatStatusSection {...props} />);

    // The badge: "<percent>%" (SDK-preferred: round(88.4) = 88).
    const badgeText = screen.getByText(/^\d+%$/).textContent ?? '';
    const badgePercent = Number(badgeText.replace('%', ''));

    // The action's label: "Context <percent>% full — compact now".
    const action = screen.getByTestId('compaction-chip');
    const match = /Context (\d+)% full/.exec(action.getAttribute('aria-label') ?? '');
    expect(match).not.toBeNull();
    const actionPercent = Number(match![1]);

    expect(actionPercent).toBe(badgePercent);
    // Guard against both surfaces silently switching to the coarse estimate
    // together — the SDK percentage must win when a breakdown exists.
    expect(actionPercent).toBe(88);
  });

  it('offers no compact affordance mid-turn, however full the window is', () => {
    // Purpose: `/compact` mid-turn can only 409 (`SESSION_LOCKED`), so DOR-112
    // requirement 1 is that the affordance HIDES rather than shows and relies on
    // the error toast. The percent is over the action threshold and the runtime
    // supports compact, so the only thing withholding the button is `isStreaming` —
    // which is exactly the input a separately-derived visibility condition dropped.
    act(() => {
      useSessionChatStore.getState().updateSession(SESSION_ID, { contextUsage });
    });

    render(<ChatStatusSection {...props} isStreaming />);

    // The badge still reports the state — this is a missing button, not a missing item.
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.queryByTestId('compaction-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /compact/i })).not.toBeInTheDocument();
  });
});
