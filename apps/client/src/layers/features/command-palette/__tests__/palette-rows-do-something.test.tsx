/**
 * @vitest-environment jsdom
 *
 * Rows that were offered and did nothing (DOR-1051).
 *
 * Four groups in the palette rendered rows a person could highlight, press
 * Enter on, and watch the dialog close with no other effect: slash commands,
 * the "Continue: …" suggestion, an agent's recent sessions, and any action an
 * extension contributed. Each case here presses the row and asserts the thing
 * it claims to do.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { sessionKeys, useSessionChatStore } from '@/layers/entities/session';
import {
  registerPaletteCommandHandler,
  unregisterPaletteCommandHandler,
} from '../model/palette-command-handlers';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

// --- Fixtures ---

const ACTIVE_CWD = '/projects/current';

const agents: AgentPathEntry[] = [
  { id: 'agent-1', name: 'Auth Service', projectPath: '/projects/auth' },
];

/** The conversation `ACTIVE_CWD` is already on, cached so resolution is a hit. */
const cachedSession = {
  id: 'session-current',
  title: 'Wiring the palette',
  cwd: ACTIVE_CWD,
  createdAt: '2026-08-09T10:00:00.000Z',
  updatedAt: '2026-08-09T10:05:00.000Z',
};

const mockTransport = createMockTransport();

let client: QueryClient;

/** A fresh client per render, seeded with the active directory's sessions. */
function render(ui: React.ReactElement, { seedSessions = true } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (seedSessions) client.setQueryData(sessionKeys.list(ACTIVE_CWD), [cachedSession]);
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// jsdom implements neither, and cmdk needs both.
globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});
Element.prototype.scrollIntoView = vi.fn();

// --- Mocks ---

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockSetGlobalPaletteOpen = vi.fn();
const mockSetDir = vi.fn((_dir: string | null, opts?: { onOpened?: () => void }) => {
  opts?.onOpened?.();
});

vi.mock('@/layers/shared/model', () => ({
  useTransport: () => mockTransport,
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      globalPaletteOpen: true,
      setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
      toggleGlobalPalette: vi.fn(),
      setPickerOpen: vi.fn(),
      setCanvasOpen: vi.fn(),
      setRightPanelOpen: vi.fn(),
      setActiveRightPanelTab: vi.fn(),
      setPreviousCwd: vi.fn(),
      previousCwd: null,
      selectedCwd: ACTIVE_CWD,
      setSelectedCwd: vi.fn(),
      setSessionId: vi.fn(),
      globalPaletteInitialSearch: null,
      clearGlobalPaletteInitialSearch: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  useReportIssue: () => vi.fn(),
  useFeedbackDialogStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openFeedback: vi.fn() };
    return selector ? selector(state) : state;
  },
  useIsMobile: () => false,
  useNow: () => Date.now(),
  useSettingsDeepLink: () => ({ open: vi.fn(), close: vi.fn() }),
  useTasksDeepLink: () => ({ open: vi.fn(), close: vi.fn() }),
  useOpenConnections: () => vi.fn(),
  useAgentCreationStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
  useImportProjectsStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // The session resolver, the chat store and the key factory are all REAL here
  // — they are what the claims below are about.
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => [ACTIVE_CWD, mockSetDir],
}));

/** One slash command, one suggestion, one extension-contributed quick action. */
vi.mock('../model/use-palette-items', () => ({
  usePaletteItems: () => ({
    rooms: { channels: [], dms: [], unread: [], isLoading: false, isError: false },
    recentAgents: agents,
    allAgents: agents,
    features: [],
    commands: [{ name: '/deploy', description: 'Deploy service' }],
    quickActions: [
      { id: 'ext:demo:ping', label: 'Ping the demo', icon: 'Plus', action: 'ext:demo:ping' },
      { id: 'ext:ghost:gone', label: 'Ghost action', icon: 'Plus', action: 'ext:ghost:gone' },
    ],
    // The flat list the search reads. The command entry has to be here or the
    // `>` page filters `/deploy` straight back out.
    searchableItems: [
      { id: 'cmd-/deploy', name: '/deploy', type: 'command', data: { name: '/deploy' } },
    ],
    suggestions: [
      {
        id: 'suggestion-continue',
        label: 'Continue: Wiring the palette',
        description: 'Resume your most recent session',
        icon: 'Clock',
        action: 'continueSession:session-current',
      },
    ],
    isLoading: false,
  }),
}));

// Passthrough search, preserving only the prefix modes the cases below use.
vi.mock('../model/use-palette-search', () => ({
  usePaletteSearch: (items: Array<{ id: string; type: string; name: string }>, search: string) => {
    const prefix = search.startsWith('@') ? '@' : search.startsWith('>') ? '>' : null;
    return { results: items.map((item) => ({ item, matches: undefined })), prefix, term: search };
  },
  parsePrefix: (search: string) => ({ prefix: null, term: search }),
}));

vi.mock('../model/use-global-palette', () => ({
  useGlobalPalette: () => ({
    globalPaletteOpen: true,
    setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
    toggleGlobalPalette: vi.fn(),
  }),
}));

/** Two conversations under the agent, so the sub-menu has rows to press. */
vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({
    sessionCount: 2,
    health: null,
    recentSessions: [
      { id: 'session-older', title: 'Older thread', lastActive: '2026-08-08T10:00:00.000Z' },
      { id: 'session-newer', title: 'Newer thread', lastActive: '2026-08-09T10:00:00.000Z' },
    ],
  }),
}));

vi.mock('@/layers/features/agent-hub', () => ({
  useAgentHubStore: Object.assign(() => ({}), { getState: () => ({ openHub: vi.fn() }) }),
}));

vi.mock('motion/react', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', props, children),
    span: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & { children?: React.ReactNode }) =>
      React.createElement('span', props, children),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
  LayoutGroup: ({ children }: { children?: React.ReactNode }) => children,
}));

beforeEach(() => {
  vi.clearAllMocks();
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
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

afterEach(cleanup);

// --- Helpers ---

const searchInput = () => screen.getByTestId('command-palette-input');
const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });

/** The palette row carrying `text`. */
function rowFor(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[data-slot="command-item"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

const draftFor = (sessionId: string) => useSessionChatStore.getState().getSession(sessionId).input;

describe('a slash command row', () => {
  it('takes you to the conversation it would run in, with the command typed in', async () => {
    render(<CommandPaletteDialog />);
    type('>');

    fireEvent.click(rowFor('/deploy'));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/session',
        search: { session: 'session-current', dir: ACTIVE_CWD },
      })
    );
    // Typed in, not sent: a global palette must not fire `/clear` at an agent
    // on one keystroke. The trailing space puts the caret where an argument goes.
    expect(draftFor('session-current')).toBe('/deploy ');
  });

  it('never eats a draft the person had already typed', async () => {
    // An unsent draft is the one thing in a session entry the server cannot
    // hand back (DOR-480), so the command joins it rather than replacing it.
    useSessionChatStore.getState().updateSession('session-current', { input: 'ship it' });
    render(<CommandPaletteDialog />);
    type('>');

    fireEvent.click(rowFor('/deploy'));

    await waitFor(() => expect(draftFor('session-current')).toBe('ship it /deploy '));
  });

  it('closes the palette', () => {
    render(<CommandPaletteDialog />);
    type('>');

    fireEvent.click(rowFor('/deploy'));

    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });
});

describe('the "Continue:" suggestion', () => {
  it('opens the session it names', () => {
    render(<CommandPaletteDialog />);

    fireEvent.click(rowFor('Continue: Wiring the palette'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'session-current', dir: ACTIVE_CWD },
    });
  });
});

describe("an agent's recent sessions", () => {
  it('opens the one you pick, in that agent’s directory', () => {
    render(<CommandPaletteDialog />);
    fireEvent.click(rowFor('Auth Service'));

    fireEvent.click(rowFor('Older thread'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      // The AGENT's directory, not the one you were in — the transcript is
      // resolved from `?dir=`, so the wrong one reads another project's history.
      search: { session: 'session-older', dir: '/projects/auth' },
    });
  });
});

describe('an action an extension contributed', () => {
  it('runs the handler that extension registered', () => {
    const handler = vi.fn();
    registerPaletteCommandHandler('ext:demo:ping', handler);
    try {
      render(<CommandPaletteDialog />);

      fireEvent.click(rowFor('Ping the demo'));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
    } finally {
      unregisterPaletteCommandHandler('ext:demo:ping');
    }
  });

  it('says so when nobody claims the action, instead of failing mutely', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<CommandPaletteDialog />);

    fireEvent.click(rowFor('Ghost action'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ext:ghost:gone'));
    warn.mockRestore();
  });
});
