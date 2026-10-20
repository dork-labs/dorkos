// @vitest-environment jsdom
/**
 * The status line hidden under a chat drawn as a DM (DOR-3074): the line goes,
 * and what a typed command opens (the usage reveal) stays.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before the component import)
// ──────────────────────────────────────────────────────────────────────────────

const capsState = { data: undefined };
const sessionRow = { runtime: 'claude-code' };

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
  useRuntimeCapabilities: () => capsState,
}));

vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () =>
    ({
      sessions: [{ id: SESSION_ID, runtime: sessionRow.runtime, model: null }],
      isLoading: false,
    }) as never,
}));

vi.mock('@/layers/entities/session/model/settings/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    // A SETTLED session: something has answered what it runs at, so the
    // permissions control draws the mode rather than its loading placeholder
    // (DOR-2103). Omitting it made every one of these trees render the
    // placeholder, silently — `vi.mock` factories are not checked against the
    // module's own types, so nothing said so.
    permissionModeKnown: true,
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
    useQueryClient: vi.fn(() => ({
      invalidateQueries: vi.fn(),
      getQueryData: vi.fn(),
      getQueriesData: vi.fn(() => []),
    })),
  };
});

vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({})),
}));

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      selectedCwd: '/test/dir',
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

// The identity chip needs a router; it is not part of what this suite asserts.
vi.mock('../ui/status/AgentIdentityChip', () => ({ AgentIdentityChip: () => null }));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    // The real promotion + budget pipeline runs; only its OUTPUT is stubbed, so the
    // assertion is about which items earned a slot rather than how they draw.
    StatusLine: ({ trailing }: { trailing?: React.ReactNode }) => (
      <div data-testid="status-line">{trailing}</div>
    ),
    UsageRevealPopover: () => <div data-testid="usage-reveal" />,
    WifiTurnCapPill: () => <span data-testid="wifi-cap" />,
    SessionPopover: ({ open }: { open: boolean }) => (
      <div data-testid="session-popover" data-open={String(open)} />
    ),
    useGitStatus: vi.fn(() => ({ data: undefined })),
    useStatusBarPins: () => ({ pins: [], toggle: vi.fn(), reset: vi.fn() }),
    RuntimeItem: () => null,
    ModelConfigPopover: () => null,
    PermissionModeItem: () => null,
    CwdItem: () => null,
    ConnectionItem: () => null,
    SubagentsItem: () => null,
  };
});

// The compaction reading, steered per case: 85%+ full is when it warns.
const compaction = vi.hoisted(() => ({
  visible: false,
  percent: 0,
  pending: false,
  onCompact: vi.fn(),
}));
vi.mock('../model/status/use-compaction-chip', () => ({
  useCompactionChip: () => compaction,
}));

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks
// ──────────────────────────────────────────────────────────────────────────────

import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { fireEvent } from '@testing-library/react';

const SESSION_ID = 'line-hidden-session';

const props = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatStatusSection — lineHidden', () => {
  it('draws the status line by default', () => {
    render(<ChatStatusSection {...props} />);
    expect(screen.getByTestId('status-line')).toBeInTheDocument();
  });

  it('draws no status line in a DM, and keeps what /context opens', () => {
    render(<ChatStatusSection {...props} lineHidden />);
    expect(screen.queryByTestId('status-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-reveal')).toBeInTheDocument();
  });

  it('keeps why every turn asks on Wi-Fi in view in a DM', () => {
    render(<ChatStatusSection {...props} lineHidden />);
    expect(screen.getByTestId('dm-safety-line')).toContainElement(screen.getByTestId('wifi-cap'));
  });

  it('warns of a nearly full context in a DM, with the way to compact it', () => {
    compaction.visible = true;
    compaction.percent = 87;
    try {
      render(<ChatStatusSection {...props} lineHidden />);
      expect(screen.getByTestId('dm-compact-warning')).toHaveTextContent('Context 87% full');
      fireEvent.click(screen.getByRole('button', { name: 'Compact chat' }));
      expect(compaction.onCompact).toHaveBeenCalledOnce();
    } finally {
      compaction.visible = false;
    }
  });

  it('ignores the session shortcut in a DM, so nothing opens later on its own', () => {
    const { rerender } = render(<ChatStatusSection {...props} lineHidden />);
    fireEvent.keyDown(document, { key: '.', metaKey: true, shiftKey: true });
    rerender(<ChatStatusSection {...props} />);
    expect(screen.getByTestId('session-popover')).toHaveAttribute('data-open', 'false');

    fireEvent.keyDown(document, { key: '.', metaKey: true, shiftKey: true });
    expect(screen.getByTestId('session-popover')).toHaveAttribute('data-open', 'true');
  });
});
