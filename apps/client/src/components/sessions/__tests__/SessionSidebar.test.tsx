import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSidebar } from '../SessionSidebar';
import type { Transport } from '@lifeos/shared/transport';
import type { Session } from '@lifeos/shared/types';
import { TransportProvider } from '../../../contexts/TransportContext';

// Mock motion/react
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

// Mock useSessionId (nuqs-backed)
const mockSetSessionId = vi.fn();
vi.mock('../../../hooks/use-session-id', () => ({
  useSessionId: () => [null, mockSetSessionId] as const,
}));

// Mock useDirectoryState (nuqs-backed)
vi.mock('../../../hooks/use-directory-state', () => ({
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
}));

// Mock app store (sidebar state + selectedCwd)
const mockSetSidebarOpen = vi.fn();
vi.mock('../../../stores/app-store', () => ({
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
vi.mock('../../../hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

// Mock session-utils to avoid time-dependent behavior
vi.mock('../../../lib/session-utils', () => ({
  groupSessionsByTime: (sessions: Session[]) => {
    if (sessions.length === 0) return [];
    const today = sessions.filter(s => s.updatedAt >= '2026-02-07');
    const older = sessions.filter(s => s.updatedAt < '2026-02-07');
    const groups = [];
    if (today.length > 0) groups.push({ label: 'Today', sessions: today });
    if (older.length > 0) groups.push({ label: 'Older', sessions: older });
    return groups;
  },
  formatRelativeTime: (iso: string) => iso >= '2026-02-07' ? '1h ago' : 'Jan 1, 3pm',
}));

function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    ...overrides,
  };
}

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

let mockTransport: Transport;

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>{ui}</TransportProvider>
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

  it('renders "New chat" button', () => {
    renderWithQuery(<SessionSidebar />);
    expect(screen.getByText('New chat')).toBeDefined();
  });

  it('shows empty state when no sessions', async () => {
    renderWithQuery(<SessionSidebar />);
    await waitFor(() => {
      expect(screen.getByText('No conversations yet')).toBeDefined();
    });
  });

  it('renders sessions grouped by time', async () => {
    mockTransport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue([
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

  it('creates session on "New chat" click', async () => {
    const newSession = makeSession({ id: 'new-1', title: 'New session' });
    mockTransport = createMockTransport({
      createSession: vi.fn().mockResolvedValue(newSession),
    });

    renderWithQuery(<SessionSidebar />);
    fireEvent.click(screen.getByText('New chat'));

    await waitFor(() => {
      expect(vi.mocked(mockTransport.createSession).mock.calls[0][0]).toEqual({ permissionMode: 'default', cwd: '/test/cwd' });
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
      listSessions: vi.fn().mockResolvedValue([
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
      listSessions: vi.fn().mockResolvedValue([
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
