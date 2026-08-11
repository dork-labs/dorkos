// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useExtensionRegistry, createInitialSlots } from '@/layers/shared/model';

// Mock useIsMobile — default to mobile
const mockUseIsMobile = vi.fn(() => true);
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

// The Ask DorkBot seed hook reads the roster so it can say how big the fleet is
// (BC-48). Stubbed to "no roster", which is what an unseeded session sees and
// what every case below is: none of them carry `?seed=`.
vi.mock('@/layers/entities/mesh/model/use-mesh-agent-paths', () => ({
  useMeshAgentPaths: () => ({ data: undefined }),
}));

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock useChatSession — status is controllable so the suggestion-chip idle gate
// can be exercised.
let mockChatStatus = 'idle';
vi.mock('../model/use-chat-session', () => ({
  useChatSession: () => ({
    messages: [],
    input: '',
    setInput: vi.fn(),
    handleSubmit: vi.fn(),
    submitContent: vi.fn(),
    status: mockChatStatus,
    error: null,
    stop: vi.fn(),
    retryMessage: vi.fn(),
    isLoadingHistory: false,
    hydrated: true,
    sessionStatus: null,
    streamStartTime: null,
    estimatedTokens: null,
    isTextStreaming: false,
    isWaitingForUser: false,
    waitingType: null,
    activeInteraction: null,
    pendingInteractions: [],
    markToolCallResponded: vi.fn(),
    systemStatus: null,
    promptSuggestions: [],
    syncConnectionState: 'connected',
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
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

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
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      setIsStreaming: vi.fn(),
      setIsTextStreaming: vi.fn(),
      setIsWaitingForUser: vi.fn(),
      setActiveForm: vi.fn(),
      enableNotificationSound: false,
      setEnableNotificationSound: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Mock child components. The composer forwards a real handle so the tests can
// see WHICH focus entry point the panel reaches for.
const chatInputFocus = vi.fn();
const chatInputFocusIfDesktop = vi.fn();
vi.mock('@/layers/features/composer', async (importActual) => {
  const actual = await importActual<typeof import('@/layers/features/composer')>();
  return {
    Composer: {
      // ChatPanel renders the real ChatInputContainer, which composes the card
      // and the lane — so both keys must exist or the container renders
      // `undefined` and every test in this file dies at mount. Root is a
      // pass-through (nothing here asserts the chrome, and a real one would
      // mount react-dropzone's document listeners); the lane is real, since it
      // is a single positioned div with nothing to stub.
      Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      OverlayLane: actual.Composer.OverlayLane,
      Input: React.forwardRef<unknown, Record<string, unknown>>(
        function MockComposerInput(_p, ref) {
          React.useImperativeHandle(ref, () => ({
            focus: chatInputFocus,
            focusUnlessTouch: chatInputFocusIfDesktop,
            focusAt: vi.fn(),
          }));
          return <div data-testid="chat-input">Composer.Input</div>;
        }
      ),
      Attachments: actual.Composer.Attachments,
      ClearArmedHint: actual.Composer.ClearArmedHint,
    },
  };
});

vi.mock('../ui/MessageList', () => ({
  MessageList: vi.fn(() => <div data-testid="message-list">MessageList</div>),
}));

vi.mock('@/layers/features/status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/features/status')>()),
  StatusLine: vi.fn(() => <div data-testid="status-line">StatusLine</div>),
  SessionPopover: vi.fn(({ children }: { children: React.ReactNode }) => <>{children}</>),
  AutoModeConfirmDialog: vi.fn(() => null),
  UsageRevealPopover: vi.fn(() => null),
  useGitStatus: vi.fn(() => ({ data: undefined })),
  // Pins live in server config (`ui.statusBar.pins`); stub the bridge so this
  // suite needs no query client or transport.
  useStatusBarPins: () => ({ pins: [], toggle: vi.fn(), reset: vi.fn() }),
}));

vi.mock('../ui/tasks/TaskListPanel', () => ({
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
  mockChatStatus = 'idle';
  useExtensionRegistry.setState({ slots: createInitialSlots() });
  localStorage.clear();
});

describe('ChatPanel status line', () => {
  // The width budget caps the line at one row of at most a few items, so there is
  // nothing left to collapse: no drag handle, no swipe gesture, and no hint to
  // teach either of them.
  it.each([
    ['a phone', true],
    ['desktop', false],
  ])('shows one uncollapsible status line on %s', (_label, mobile) => {
    mockUseIsMobile.mockReturnValue(mobile);
    render(<ChatPanel sessionId="test" />);
    expect(screen.getByTestId('status-line')).toBeTruthy();
    expect(screen.queryByLabelText(/input extras/)).toBeNull();
    expect(screen.queryByText('Swipe to collapse')).toBeNull();
  });
});

describe('ChatPanel suggestion-chip slot', () => {
  function registerChip() {
    useExtensionRegistry.getState().register('chat.suggestion-chips', {
      id: 'test-chip',
      component: () => <div data-testid="suggestion-chip" />,
    });
  }

  it('renders suggestion chips only while idle, never mid-stream', () => {
    registerChip();

    mockChatStatus = 'idle';
    const { rerender } = render(<ChatPanel sessionId="test" />);
    expect(screen.getByTestId('suggestion-chip')).toBeTruthy();

    // A turn starts: the chip must not interrupt it.
    mockChatStatus = 'streaming';
    rerender(<ChatPanel sessionId="test" />);
    expect(screen.queryByTestId('suggestion-chip')).toBeNull();

    // The turn settles: the chip returns.
    mockChatStatus = 'idle';
    rerender(<ChatPanel sessionId="test" />);
    expect(screen.getByTestId('suggestion-chip')).toBeTruthy();
  });
});

describe('ChatPanel composer focus', () => {
  // The composer's own mount autofocus has always been guarded (touch devices
  // pop the software keyboard and scroll the view). ChatPanel then focused it
  // through the handle on mount, on every session switch, and again on
  // `?prompt=` seeding — with no mobile check — so the guard only ever
  // protected the dashboard and onboarding composers.
  it('reaches for the guarded focus, never the unguarded one, on mount', () => {
    render(<ChatPanel sessionId="test" />);
    expect(chatInputFocusIfDesktop).toHaveBeenCalled();
    expect(chatInputFocus).not.toHaveBeenCalled();
  });

  it('reaches for the guarded focus on a session switch', () => {
    const { rerender } = render(<ChatPanel sessionId="test" />);
    chatInputFocusIfDesktop.mockClear();
    chatInputFocus.mockClear();

    rerender(<ChatPanel sessionId="other" />);

    expect(chatInputFocusIfDesktop).toHaveBeenCalled();
    expect(chatInputFocus).not.toHaveBeenCalled();
  });

  it('reaches for the guarded focus when a launch prompt seeds the composer', () => {
    render(<ChatPanel sessionId="test" launchPrompt="re-run this" />);
    expect(chatInputFocusIfDesktop).toHaveBeenCalled();
    expect(chatInputFocus).not.toHaveBeenCalled();
  });

  it('focuses the composer an Ask DorkBot seed opens, which it never types into', () => {
    // BC-48 says "empty AND focused", and the two halves have different owners:
    // the seed hook is what leaves the box empty, and this effect is the whole
    // of what puts the caret in it. Nothing else focuses on a seeded launch —
    // `useDorkBotSeed` has no `onSeeded` — so if this stopped firing, Ask
    // DorkBot would land somebody in a conversation they have to click into.
    render(<ChatPanel sessionId="test" launchSeed="dorkbot-help" />);
    expect(chatInputFocusIfDesktop).toHaveBeenCalled();
    expect(chatInputFocus).not.toHaveBeenCalled();
  });
});
