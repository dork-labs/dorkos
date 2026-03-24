// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { STORAGE_KEYS } from '@/layers/shared/lib/constants';

// Mock useIsMobile — default to mobile
const mockUseIsMobile = vi.fn(() => true);
vi.mock('@/layers/shared/model/use-is-mobile', () => ({
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
    promptSuggestions: [],
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
    taskMap: new Map(),
    activeForm: null,
    isCollapsed: true,
    toggleCollapse: vi.fn(),
    handleTaskEvent: vi.fn(),
    statusTimestamps: new Map(),
  }),
}));

// Mock useFileUpload — avoids TransportProvider requirement
vi.mock('../model/use-file-upload', () => ({
  useFileUpload: () => ({
    pendingFiles: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clearFiles: vi.fn(),
    uploadAndGetPaths: vi.fn().mockResolvedValue([]),
    hasPendingFiles: false,
    isUploading: false,
  }),
}));

// Mock useSessionId
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => ['test-session', vi.fn()],
}));

// Mock useSessionStatus
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: null,
    model: null,
    costUsd: null,
    contextPercent: null,
    updateSession: vi.fn(),
  }),
}));

// Mock TanStack Query — ChatStatusSection uses useQuery and useQueryClient
vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({ data: undefined })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

// Mock useTransport — ChatStatusSection fetches config via transport
vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({
    getConfig: vi.fn().mockResolvedValue({}),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock useDirectoryState
vi.mock('@/layers/entities/session/model/use-directory-state', () => ({
  useDirectoryState: () => ['/test/dir', vi.fn()],
}));

// Mock useAppStore — supports both selector call and no-selector (destructure) call patterns
const mockShowShortcutChips = vi.fn(() => true);
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      showShortcutChips: mockShowShortcutChips(),
      setIsStreaming: vi.fn(),
      setIsTextStreaming: vi.fn(),
      setIsWaitingForUser: vi.fn(),
      setActiveForm: vi.fn(),
      showStatusBarCwd: false,
      showStatusBarPermission: false,
      showStatusBarModel: false,
      showStatusBarCost: false,
      showStatusBarContext: false,
      showStatusBarGit: false,
      showStatusBarSound: false,
      showStatusBarTunnel: false,
      showStatusBarVersion: false,
      enableNotificationSound: false,
      setEnableNotificationSound: vi.fn(),
    };
    return selector ? selector(state) : state;
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

vi.mock('@/layers/features/status', () => ({
  StatusLine: Object.assign(
    vi.fn(() => <div data-testid="status-line">StatusLine</div>),
    {
      Item: vi.fn(({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
        visible ? <>{children}</> : null
      ),
    }
  ),
  CwdItem: vi.fn(() => null),
  GitStatusItem: vi.fn(() => null),
  PermissionModeItem: vi.fn(() => null),
  ModelItem: vi.fn(() => null),
  CostItem: vi.fn(() => null),
  ContextItem: vi.fn(() => null),
  NotificationSoundItem: vi.fn(() => null),
  SyncItem: vi.fn(() => null),
  PollingItem: vi.fn(() => null),
  TunnelItem: vi.fn(() => null),
  VersionItem: vi.fn(() => null),
  useGitStatus: vi.fn(() => ({ data: undefined })),
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
    localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, '1');
    render(<ChatPanel sessionId="test" />);
    expect(screen.getByText('Swipe to collapse')).toBeTruthy();
  });

  it('does not show hint when count >= 3', () => {
    mockUseIsMobile.mockReturnValue(true);
    localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, '3');
    render(<ChatPanel sessionId="test" />);
    expect(screen.queryByText('Swipe to collapse')).toBeNull();
  });

  it('increments count on dismiss', () => {
    vi.useFakeTimers();
    mockUseIsMobile.mockReturnValue(true);
    localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, '0');
    render(<ChatPanel sessionId="test" />);
    expect(screen.getByText('Swipe to collapse')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT)).toBe('1');
    vi.useRealTimers();
  });

  it('does not show hint on desktop regardless of count', () => {
    mockUseIsMobile.mockReturnValue(false);
    localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, '0');
    render(<ChatPanel sessionId="test" />);
    expect(screen.queryByText('Swipe to collapse')).toBeNull();
  });
});
