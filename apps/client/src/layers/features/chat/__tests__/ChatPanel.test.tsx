// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Mock motion/react with Proxy pattern
vi.mock('motion/react', () => ({
  motion: new Proxy({}, {
    get: (_target: unknown, prop: string) => {
      return ({ children, initial: _i, animate: _a, exit: _e, transition: _t, drag: _d, dragConstraints: _dc, dragElastic: _de, onDragEnd: _ode, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
        const Tag = prop as keyof React.JSX.IntrinsicElements;
        return <Tag {...props}>{children}</Tag>;
      };
    },
  }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock useIsMobile — default to mobile
const mockUseIsMobile = vi.fn(() => true);
vi.mock('@/layers/shared/lib/use-is-mobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock useChatSession
vi.mock('../model/use-chat-session', () => ({
  useChatSession: () => ({
    messages: [],
    input: '',
    setInput: vi.fn(),
    handleSubmit: vi.fn(),
    status: 'idle',
    error: null,
    stop: vi.fn(),
    isLoadingHistory: false,
    sessionStatus: null,
    streamStartTime: null,
    estimatedTokens: null,
    isTextStreaming: false,
  }),
}));

// Mock useCommands
vi.mock('@/layers/entities/command/model/use-commands', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));

// Mock useTaskState
vi.mock('../model/use-task-state', () => ({
  useTaskState: () => ({
    tasks: [],
    activeForm: null,
    isCollapsed: true,
    toggleCollapse: vi.fn(),
    handleTaskEvent: vi.fn(),
  }),
}));

// Mock useSessionId
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => ['test-session', vi.fn()],
}));

// Mock useSessionStatus
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({ permissionMode: 'default' }),
}));

// Mock useDirectoryState
vi.mock('@/layers/entities/session/model/use-directory-state', () => ({
  useDirectoryState: () => ['/test/dir', vi.fn()],
}));

// Mock useAppStore
const mockShowShortcutChips = vi.fn(() => true);
vi.mock('@/layers/shared/lib/app-store', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = { showShortcutChips: mockShowShortcutChips(), setIsStreaming: vi.fn(), setIsWaitingForUser: vi.fn(), setActiveForm: vi.fn() };
    return selector(state);
  },
}));

// Mock child components
vi.mock('../ui/ChatInput', () => ({
  ChatInput: vi.fn(() => <div data-testid="chat-input">ChatInput</div>),
}));

vi.mock('../ui/MessageList', () => ({
  MessageList: vi.fn(() => <div data-testid="message-list">MessageList</div>),
}));

vi.mock('../ui/ShortcutChips', () => ({
  ShortcutChips: vi.fn(() => <div data-testid="shortcut-chips">ShortcutChips</div>),
}));

vi.mock('@/layers/features/status/ui/StatusLine', () => ({
  StatusLine: vi.fn(() => <div data-testid="status-line">StatusLine</div>),
}));

vi.mock('../ui/TaskListPanel', () => ({
  TaskListPanel: vi.fn(() => null),
}));

vi.mock('@/layers/features/commands', () => ({
  CommandPalette: vi.fn(() => null),
}));

vi.mock('@/layers/features/files', () => ({
  FilePalette: vi.fn(() => null),
  useFiles: () => ({ data: { files: [] } }),
}));

import { ChatPanel } from '../ui/ChatPanel';

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

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUseIsMobile.mockReturnValue(true);
  mockShowShortcutChips.mockReturnValue(true);
  localStorage.clear();
});

describe('ChatPanel collapse', () => {
  it('mobile: renders drag handle', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ChatPanel sessionId="test" />);
    const handle = screen.getByLabelText(/input extras/);
    expect(handle).toBeTruthy();
    expect(handle.getAttribute('role')).toBe('button');
  });

  it('desktop: does not render drag handle', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(<ChatPanel sessionId="test" />);
    expect(screen.queryByLabelText(/input extras/)).toBeNull();
  });

  it('mobile: chips and status bar visible by default', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ChatPanel sessionId="test" />);
    expect(screen.getByTestId('shortcut-chips')).toBeTruthy();
    expect(screen.getByTestId('status-line')).toBeTruthy();
  });

  it('mobile: tap handle hides chips and status bar', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ChatPanel sessionId="test" />);
    fireEvent.click(screen.getByLabelText(/input extras/));
    expect(screen.queryByTestId('shortcut-chips')).toBeNull();
    expect(screen.queryByTestId('status-line')).toBeNull();
  });

  it('mobile: tap handle again shows chips and status bar', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ChatPanel sessionId="test" />);
    const handle = screen.getByLabelText(/input extras/);
    fireEvent.click(handle);
    expect(screen.queryByTestId('shortcut-chips')).toBeNull();
    fireEvent.click(screen.getByLabelText(/input extras/));
    expect(screen.getByTestId('shortcut-chips')).toBeTruthy();
    expect(screen.getByTestId('status-line')).toBeTruthy();
  });
});

describe('ChatPanel first-use hint', () => {
  it('shows hint when localStorage count < 3 on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    localStorage.setItem('gateway-gesture-hint-count', '1');
    render(<ChatPanel sessionId="test" />);
    expect(screen.getByText('Swipe to collapse')).toBeTruthy();
  });

  it('does not show hint when count >= 3', () => {
    mockUseIsMobile.mockReturnValue(true);
    localStorage.setItem('gateway-gesture-hint-count', '3');
    render(<ChatPanel sessionId="test" />);
    expect(screen.queryByText('Swipe to collapse')).toBeNull();
  });

  it('increments count on dismiss', () => {
    vi.useFakeTimers();
    mockUseIsMobile.mockReturnValue(true);
    localStorage.setItem('gateway-gesture-hint-count', '0');
    render(<ChatPanel sessionId="test" />);
    expect(screen.getByText('Swipe to collapse')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(localStorage.getItem('gateway-gesture-hint-count')).toBe('1');
    vi.useRealTimers();
  });

  it('does not show hint on desktop regardless of count', () => {
    mockUseIsMobile.mockReturnValue(false);
    localStorage.setItem('gateway-gesture-hint-count', '0');
    render(<ChatPanel sessionId="test" />);
    expect(screen.queryByText('Swipe to collapse')).toBeNull();
  });
});
