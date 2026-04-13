// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentListItem } from '../ui/AgentListItem';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => false };
});

vi.mock('@/layers/entities/agent', () => ({
  useAgentVisual: () => ({ color: '#aaaaaa', emoji: '🤖' }),
  AgentIdentity: ({ name, emoji }: { name: string; emoji: string }) => (
    <span data-testid="agent-identity">
      <span>{emoji}</span>
      <span>{name}</span>
    </span>
  ),
}));

vi.mock('@/layers/entities/session', () => ({
  useAgentHottestStatus: () => ({
    kind: 'idle',
    color: 'rgba(128,128,128,0.08)',
    pulse: false,
    label: 'Idle',
  }),
  usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  SessionRow: ({
    session,
    isActive,
    onClick,
    onFork,
    onRename,
  }: {
    variant: string;
    session: { id: string; title: string };
    isActive: boolean;
    onClick: () => void;
    onFork?: (sessionId: string) => void;
    onRename?: (sessionId: string, title: string) => void;
  }) => (
    <button
      type="button"
      data-testid={`session-${session.id}`}
      data-active={isActive}
      data-has-fork={!!onFork}
      data-has-rename={!!onRename}
      onClick={onClick}
    >
      {session.title}
      {onFork && (
        <button type="button" data-testid={`fork-${session.id}`} onClick={() => onFork(session.id)}>
          Fork
        </button>
      )}
      {onRename && (
        <button
          type="button"
          data-testid={`rename-${session.id}`}
          onClick={() => onRename(session.id, 'New name')}
        >
          Rename
        </button>
      )}
    </button>
  ),
}));

vi.mock('../ui/AgentContextMenu', () => ({
  AgentContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../ui/AgentActivityBadge', () => ({
  AgentActivityBadge: ({ label }: { label: string }) => (
    <span data-testid="activity-badge">{label}</span>
  ),
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSession(id: string, title: string) {
  return {
    id,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode: 'default' as const,
  };
}

const MOCK_SESSIONS = [mockSession('s1', 'Session 1'), mockSession('s2', 'Session 2')];

function buildProps(overrides: Partial<Parameters<typeof AgentListItem>[0]> = {}) {
  return {
    path: '/agents/test-agent',
    agent: null,
    isActive: false,
    isExpanded: false,
    isPinned: false,
    onSelect: vi.fn(),
    onToggleExpand: vi.fn(),
    onTogglePin: vi.fn(),
    onOpenProfile: vi.fn(),
    sessions: [],
    isLoadingSessions: false,
    activeSessionId: null,
    onSessionClick: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

function renderItem(overrides: Partial<Parameters<typeof AgentListItem>[0]> = {}) {
  const props = buildProps(overrides);
  const result = render(
    <TooltipProvider>
      <SidebarProvider>
        <AgentListItem {...props} />
      </SidebarProvider>
    </TooltipProvider>
  );
  return { ...result, props };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentListItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Rendering ---

  it('renders the agent display name from path fallback', () => {
    renderItem();
    expect(screen.getByText('test-agent')).toBeInTheDocument();
  });

  it('uses displayName prop when provided', () => {
    renderItem({ displayName: 'Custom Name' });
    expect(screen.getByText('Custom Name')).toBeInTheDocument();
  });

  it('renders the activity badge', () => {
    renderItem();
    expect(screen.getByTestId('activity-badge')).toHaveTextContent('Idle');
  });

  // --- Row click behavior ---

  it('calls onSelect when clicking an inactive row', () => {
    const { props } = renderItem({ isActive: false });
    fireEvent.click(screen.getByTestId('agent-identity').closest('[data-slot="agent-list-item"]')!);
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onToggleExpand).not.toHaveBeenCalled();
  });

  it('calls onToggleExpand when clicking an active row', () => {
    const { props } = renderItem({ isActive: true });
    fireEvent.click(screen.getByTestId('agent-identity').closest('[data-slot="agent-list-item"]')!);
    expect(props.onToggleExpand).toHaveBeenCalledTimes(1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  // --- Expanded state ---

  it('does not render session preview when collapsed', () => {
    renderItem({ isActive: true, isExpanded: false, sessions: MOCK_SESSIONS });
    expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
  });

  it('renders session previews when active and expanded', () => {
    renderItem({ isActive: true, isExpanded: true, sessions: MOCK_SESSIONS });
    expect(screen.getByText('Session 1')).toBeInTheDocument();
    expect(screen.getByText('Session 2')).toBeInTheDocument();
  });

  it('limits preview to MAX_PREVIEW_SESSIONS (3)', () => {
    const manySessions = Array.from({ length: 5 }, (_, i) => mockSession(`s${i}`, `Session ${i}`));
    renderItem({ isActive: true, isExpanded: true, sessions: manySessions });
    expect(screen.getByText('Session 0')).toBeInTheDocument();
    expect(screen.getByText('Session 2')).toBeInTheDocument();
    expect(screen.queryByText('Session 3')).not.toBeInTheDocument();
  });

  it('calls onSessionClick when a session preview is clicked', () => {
    const { props } = renderItem({
      isActive: true,
      isExpanded: true,
      sessions: MOCK_SESSIONS,
    });
    fireEvent.click(screen.getByTestId('session-s1'));
    expect(props.onSessionClick).toHaveBeenCalledWith('s1');
  });

  it('marks the active session in preview', () => {
    renderItem({
      isActive: true,
      isExpanded: true,
      sessions: MOCK_SESSIONS,
      activeSessionId: 's2',
    });
    expect(screen.getByTestId('session-s2')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('session-s1')).toHaveAttribute('data-active', 'false');
  });

  // --- Expanded action buttons ---

  it('renders "New session" button when sessions exist', () => {
    renderItem({ isActive: true, isExpanded: true, sessions: MOCK_SESSIONS });
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('hides "New session" button when no sessions exist', () => {
    renderItem({ isActive: true, isExpanded: true, sessions: [] });
    expect(screen.queryByText('New session')).not.toBeInTheDocument();
  });

  it('calls onNewSession from expanded new session button', () => {
    const { props } = renderItem({ isActive: true, isExpanded: true, sessions: MOCK_SESSIONS });
    fireEvent.click(screen.getByText('New session'));
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
  });

  // --- Accessibility ---

  it('does not nest interactive role="button" elements', () => {
    const { container } = renderItem({ isActive: true, isExpanded: true });
    const row = container.querySelector('[data-slot="agent-list-item"]')!;
    expect(row).not.toHaveAttribute('role', 'button');
  });

  // --- Rename/Fork propagation ---

  it('passes onForkSession to SessionRow when provided', () => {
    renderItem({
      isActive: true,
      isExpanded: true,
      sessions: MOCK_SESSIONS,
      onForkSession: vi.fn(),
    });
    expect(screen.getByTestId('session-s1')).toHaveAttribute('data-has-fork', 'true');
  });

  it('passes onRenameSession to SessionRow when provided', () => {
    renderItem({
      isActive: true,
      isExpanded: true,
      sessions: MOCK_SESSIONS,
      onRenameSession: vi.fn(),
    });
    expect(screen.getByTestId('session-s1')).toHaveAttribute('data-has-rename', 'true');
  });

  it('does not pass fork to SessionRow when omitted', () => {
    renderItem({
      isActive: true,
      isExpanded: true,
      sessions: MOCK_SESSIONS,
    });
    expect(screen.getByTestId('session-s1')).toHaveAttribute('data-has-fork', 'false');
  });

  it('calls onForkSession with session ID when fork is triggered', () => {
    const onForkSession = vi.fn();
    renderItem({
      isActive: true,
      isExpanded: true,
      sessions: MOCK_SESSIONS,
      onForkSession,
    });
    fireEvent.click(screen.getByTestId('fork-s1'));
    expect(onForkSession).toHaveBeenCalledWith('s1');
  });

  it('calls onRenameSession with session ID and title when rename is triggered', () => {
    const onRenameSession = vi.fn();
    renderItem({
      isActive: true,
      isExpanded: true,
      sessions: MOCK_SESSIONS,
      onRenameSession,
    });
    fireEvent.click(screen.getByTestId('rename-s1'));
    expect(onRenameSession).toHaveBeenCalledWith('s1', 'New name');
  });
});
