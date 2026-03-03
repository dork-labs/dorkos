import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSidebar } from '../ui/SessionSidebar';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// Mock useSessionId (nuqs-backed)
const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [null, mockSetSessionId] as const,
}));

// Mock useDirectoryState (nuqs-backed)
vi.mock('@/layers/entities/session/model/use-directory-state', () => ({
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
}));

// Mock app store (sidebar state + selectedCwd)
const mockSetSidebarOpen = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setSidebarOpen: mockSetSidebarOpen,
      selectedCwd: '/test/cwd',
      recentCwds: [],
    };
    return selector ? selector(state) : state;
  },
}));

// Mock useIsMobile
vi.mock('@/layers/shared/model/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

// Mock usePulseEnabled
vi.mock('@/layers/entities/pulse/model/use-pulse-config', () => ({
  usePulseEnabled: () => true,
}));

// Mock useCompletedRunBadge
const mockClearBadge = vi.fn();
vi.mock('@/layers/entities/pulse/model/use-completed-run-badge', () => ({
  useCompletedRunBadge: () => ({ unviewedCount: 0, clearBadge: mockClearBadge }),
}));

// Mock sonner
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

// Mock favicon-utils
vi.mock('@/layers/shared/lib/favicon-utils', () => ({
  updateTabBadge: vi.fn(),
  hashToHslColor: (_s: string) => 'hsl(0, 70%, 55%)',
  hashToEmoji: (_s: string) => '🤖',
}));

// Mock session-utils to avoid time-dependent behavior
vi.mock('@/layers/shared/lib/session-utils', () => ({
  groupSessionsByTime: (sessions: Session[]) => {
    if (sessions.length === 0) return [];
    const today = sessions.filter((s) => s.updatedAt >= '2026-02-07');
    const older = sessions.filter((s) => s.updatedAt < '2026-02-07');
    const groups = [];
    if (today.length > 0) groups.push({ label: 'Today', sessions: today });
    if (older.length > 0) groups.push({ label: 'Older', sessions: older });
    return groups;
  },
  formatRelativeTime: (iso: string) => (iso >= '2026-02-07' ? '1h ago' : 'Jan 1, 3pm'),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    title: overrides.title ?? 'Test session',
    createdAt: overrides.createdAt ?? '2026-02-07T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-02-07T14:00:00Z',
    permissionMode: overrides.permissionMode ?? 'default',
    ...overrides,
  };
}

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

let mockTransport: Transport;

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <TooltipProvider>{ui}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
    mockSetSidebarOpen.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders "New session" button', () => {
    renderWithQuery(<SessionSidebar />);
    expect(screen.getByText('New session')).toBeDefined();
  });

  it('shows empty state when no sessions', async () => {
    renderWithQuery(<SessionSidebar />);
    await waitFor(() => {
      expect(screen.getByText('No conversations yet')).toBeDefined();
    });
  });

  it('renders sessions grouped by time', async () => {
    mockTransport = createMockTransport({
      listSessions: vi
        .fn()
        .mockResolvedValue([
          makeSession({ id: 's1', title: 'Today session', updatedAt: '2026-02-07T12:00:00Z' }),
          makeSession({ id: 's2', title: 'Old session', updatedAt: '2025-06-01T10:00:00Z' }),
        ]),
    });

    renderWithQuery(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByText('Today')).toBeDefined();
      expect(screen.getByText('Older')).toBeDefined();
    });

    expect(screen.getByText('Today session')).toBeDefined();
    expect(screen.getByText('Old session')).toBeDefined();
  });

  it('creates session on "New session" click', async () => {
    const newSession = makeSession({ id: 'new-1', title: 'New session' });
    mockTransport = createMockTransport({
      createSession: vi.fn().mockResolvedValue(newSession),
    });

    renderWithQuery(<SessionSidebar />);
    fireEvent.click(screen.getByText('New session'));

    await waitFor(() => {
      expect(vi.mocked(mockTransport.createSession).mock.calls[0][0]).toEqual({
        permissionMode: 'default',
        cwd: '/test/cwd',
      });
    });
  });

  it('renders close sidebar button', () => {
    renderWithQuery(<SessionSidebar />);
    expect(screen.getByLabelText('Close sidebar')).toBeDefined();
  });

  it('closes sidebar when close button clicked', () => {
    renderWithQuery(<SessionSidebar />);
    fireEvent.click(screen.getByLabelText('Close sidebar'));
    expect(mockSetSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('hides "Today" header when it is the only group', async () => {
    mockTransport = createMockTransport({
      listSessions: vi
        .fn()
        .mockResolvedValue([
          makeSession({ id: 's1', title: 'Only today', updatedAt: '2026-02-07T12:00:00Z' }),
        ]),
    });

    renderWithQuery(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByText('Only today')).toBeDefined();
    });

    expect(screen.queryByText('Today')).toBeNull();
  });

  it('auto-selects first session when no active session', async () => {
    mockTransport = createMockTransport({
      listSessions: vi
        .fn()
        .mockResolvedValue([
          makeSession({ id: 's1', title: 'First session' }),
          makeSession({ id: 's2', title: 'Second session' }),
        ]),
    });

    renderWithQuery(<SessionSidebar />);

    await waitFor(() => {
      expect(mockSetSessionId).toHaveBeenCalledWith('s1');
    });
  });
});
