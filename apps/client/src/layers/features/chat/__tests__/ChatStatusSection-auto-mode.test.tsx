// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSessionChatStore } from '@/layers/entities/session';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before component import)
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('@/layers/shared/model/use-is-mobile', () => ({
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
const updateSession = vi.fn();
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
      showShortcutChips: false,
      enableNotificationSound: false,
      setEnableNotificationSound: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Mock PermissionModeItem so we can drive its onChangeMode directly without
// the dropdown internals. Render a button that selects 'auto'.
vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    StatusLine: Object.assign(
      ({ children }: { children: React.ReactNode }) => (
        <div data-testid="status-line">{children}</div>
      ),
      {
        Item: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
          visible ? <div>{children}</div> : null,
      }
    ),
    CwdItem: () => null,
    GitStatusItem: () => null,
    PermissionModeItem: ({ onChangeMode }: { onChangeMode: (m: string) => void }) => (
      <button type="button" data-testid="select-auto" onClick={() => onChangeMode('auto')}>
        select auto
      </button>
    ),
    ModelConfigPopover: () => null,
    CacheItem: () => null,
    ContextItem: () => null,
    UsageStatusItem: () => null,
    NotificationSoundItem: () => null,
    PollingItem: () => null,
    ConnectionItem: () => null,
    SubagentsItem: () => null,
    StatusBarConfigurePopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useGitStatus: vi.fn(() => ({ data: undefined })),
    STATUS_BAR_REGISTRY: actual.STATUS_BAR_REGISTRY,
    // Status-bar visibility lives in server config (DOR-431). Only the
    // permission item is shown; this suite drives its onChangeMode.
    useStatusBarPrefs: () => ({
      cwd: false,
      git: false,
      runtime: false,
      model: false,
      cache: false,
      context: false,
      usage: false,
      permission: true,
      sound: false,
      polling: false,
    }),
    useUpdateStatusBarPrefs: () => ({
      setVisibility: vi.fn(),
      reset: vi.fn(),
      isPending: false,
    }),
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
  onChipClick: vi.fn(),
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

    expect(updateSession).toHaveBeenCalledWith({ permissionMode: 'auto' });
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
    expect(updateSession).toHaveBeenCalledWith({ permissionMode: 'auto' });
  });

  it('cancel leaves the mode unchanged and does not record the session', () => {
    render(<ChatStatusSection {...defaultProps} />);

    fireEvent.click(screen.getByTestId('select-auto'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateSession).not.toHaveBeenCalled();
    expect(useSessionChatStore.getState().hasConfirmedAuto(SESSION_ID)).toBe(false);
  });
});
