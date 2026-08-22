// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSessionChatStore } from '@/layers/entities/session';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before component import)
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

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

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

// updateSession spy shared across the test — exposed via a module-level holder.
// Returns a promise, like the hook it stands in for: `useSessionStatus`'s
// `updateSession` is an async function, and the status line now waits on it
// before offering to make a stop the default (spec `trust-dial`, decision 6C).
// A mock that answered `undefined` would be lying about the contract.
const updateSession = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: '/test/dir',
    model: 'claude-opus-4-8',
    costUsd: null,
    contextPercent: null,
    updateSession,
  }),
}));

// useModels reports the active model supports auto mode.
vi.mock('@/layers/entities/session/model/use-models', () => ({
  useModels: () => ({
    data: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsAutoMode: true }],
  }),
}));

vi.mock('@/layers/entities/session/model/use-subagents', () => ({
  useSubagents: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/workspace', () => ({
  useWorkspaceForSession: () => null,
}));

// The compaction chip (DOR-112) resolves `useTransport()` unconditionally —
// stub it so this suite (which never crosses the compaction threshold) still
// renders without a real TransportProvider.
vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({
    runCommandIntent: vi.fn(),
  })),
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

// Mock PermissionModeItem so we can drive its onChangeMode directly without
// the dropdown internals. Render a button that selects 'auto'.
// The identity chip needs a router; it is not part of the status line under test.
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
      <button type="button" data-testid="select-auto" onClick={() => onChangeMode('auto')}>
        select auto
      </button>
    ),
    ModelConfigPopover: () => null,
    ContextItem: () => null,
    UsageStatusItem: () => null,
    ConnectionItem: () => null,
    SubagentsItem: () => null,
    SessionPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useGitStatus: vi.fn(() => ({ data: undefined })),
    // `default` permissions are quiet by design; this suite drives the auto-mode
    // confirmation from that item, so pin it into the line. Pins live in server
    // config (`ui.statusBar.pins`); stub the bridge so this suite needs no query
    // client or transport.
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

const SESSION_ID = 'auto-session-1';

const defaultProps = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

beforeEach(() => {
  updateSession.mockClear();
  // Reset client-only auto-confirmation state between tests.
  useSessionChatStore.setState({ autoConfirmedSessions: {} });
});

afterEach(() => {
  cleanup();
});

describe('ChatStatusSection — auto-mode entry confirmation', () => {
  it('first selection of auto opens the modal and does NOT call updateSession until confirm', () => {
    render(<ChatStatusSection {...defaultProps} />);

    fireEvent.click(screen.getByTestId('select-auto'));

    // Modal is open, mode not yet applied.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('confirming records the session and applies updateSession({ permissionMode: auto })', () => {
    render(<ChatStatusSection {...defaultProps} />);

    fireEvent.click(screen.getByTestId('select-auto'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Auto mode' }));

    // First argument only — the mode writer also passes an `onError` so a
    // refused Full-autonomy write can reopen its door, which Auto never triggers.
    expect(updateSession.mock.calls[0]?.[0]).toEqual({ permissionMode: 'auto' });
    expect(useSessionChatStore.getState().hasConfirmedAuto(SESSION_ID)).toBe(true);
  });

  it('second selection in the same (confirmed) session applies directly without the modal', () => {
    render(<ChatStatusSection {...defaultProps} />);

    // First: confirm.
    fireEvent.click(screen.getByTestId('select-auto'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Auto mode' }));
    updateSession.mockClear();

    // Second selection: applies directly, no modal.
    fireEvent.click(screen.getByTestId('select-auto'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // The first argument only: mode changes also carry an `onError` so a refused
    // Full-autonomy write can reopen its door, which is nothing to do with Auto.
    expect(updateSession.mock.calls[0]?.[0]).toEqual({ permissionMode: 'auto' });
  });

  it('cancel leaves the mode unchanged and does not record the session', () => {
    render(<ChatStatusSection {...defaultProps} />);

    fireEvent.click(screen.getByTestId('select-auto'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateSession).not.toHaveBeenCalled();
    expect(useSessionChatStore.getState().hasConfirmedAuto(SESSION_ID)).toBe(false);
  });
});
