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
import { useInteractionStore } from '@/layers/entities/interactions';
// Reaching into another feature, as only a test may: the claim is an agreement
// between the palette and the chat send funnel, and an agreement asserted
// against a re-typed copy of the rule is not asserted at all.
import { isNativeCommandContent } from '@/layers/features/chat/model/native-commands';
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

/**
 * The ranking fields of a corpus row with no history behind it.
 *
 * The real search and ranking run in this file — nothing stubs them — so every
 * corpus row has to answer them. Which order they produce is another file's
 * claim; this one is about rows that DO something when you press them.
 */
const unranked = {
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
} as const;

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
    allAgents: agents,
    features: [],
    // `/compact` beside the generic one because it is a command the send funnel
    // genuinely RECOGNIZES, so the drafts below can be put through the real
    // recognizer instead of being compared to a hoped-for string.
    commands: [
      { name: '/deploy', description: 'Deploy service' },
      { name: '/compact', description: 'Compact the conversation' },
    ],
    quickActions: [
      { id: 'ext:demo:ping', label: 'Ping the demo', icon: 'Plus', action: 'ext:demo:ping' },
      { id: 'ext:ghost:gone', label: 'Ghost action', icon: 'Plus', action: 'ext:ghost:gone' },
    ],
    // The flat list the search reads. The command entry has to be here or the
    // `>` page filters `/deploy` straight back out.
    searchableItems: [
      {
        id: 'cmd-/deploy',
        name: '/deploy',
        type: 'command',
        ...unranked,
        data: { name: '/deploy' },
      },
      {
        id: 'cmd-/compact',
        name: '/compact',
        type: 'command',
        ...unranked,
        data: { name: '/compact' },
      },
      {
        id: 'ext:demo:ping',
        name: 'Ping the demo',
        type: 'quick-action',
        ...unranked,
        data: {
          id: 'ext:demo:ping',
          label: 'Ping the demo',
          icon: 'Plus',
          action: 'ext:demo:ping',
        },
      },
      {
        id: 'ext:ghost:gone',
        name: 'Ghost action',
        type: 'quick-action',
        ...unranked,
        data: {
          id: 'ext:ghost:gone',
          label: 'Ghost action',
          icon: 'Plus',
          action: 'ext:ghost:gone',
        },
      },
    ],
    newActions: [],
    sessions: [],
    // One live conversation, so the Continue group has a row to press.
    continueRows: [
      {
        session: {
          id: 'session-current',
          who: 'Current Project',
          title: 'Wiring the palette',
          cwd: ACTIVE_CWD,
          agent: null,
          lastActivityAt: '2026-08-09T10:05:00.000Z',
        },
        verb: 'Editing palette.ts…',
        signal: 'working',
      },
    ],
    // The agent row the sub-menu cases drill in from.
    recent: [
      {
        kind: 'agent',
        key: `agent:${agents[0].projectPath}`,
        lastActivityAt: '2026-08-09T10:00:00.000Z',
        agent: agents[0],
      },
    ],
    isLoading: false,
  }),
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

vi.mock('@/layers/features/profile', () => ({
  PROFILE_PANEL_ID: 'profile',
  useProfileStore: Object.assign(() => ({}), {
    getState: () => ({ openProfileDocked: vi.fn() }),
  }),
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
  useInteractionStore.getState().reset();
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
    // And it leaves the same memory the conversation rows do — this row lands a
    // person IN a conversation, so ranking has to know it happened. Recorded
    // AFTER the resolve, never before: a lookup that failed is not an open.
    const { opened } = useInteractionStore.getState();
    expect(opened['session:session-current']).toBeDefined();
    expect(opened[`agent:${ACTIVE_CWD}`]).toBeDefined();
  });

  it('still produces a RUNNABLE command when the composer already had text', async () => {
    // The assertion that matters is not the string's shape but what the send
    // funnel makes of it. Appending the command to the draft
    // (`ship it /compact `) reads fine and is not a command at all: both
    // recognizers anchor at position 0, so it goes to the model as prose while
    // the row looks like it worked.
    useSessionChatStore.getState().updateSession('session-current', { input: 'ship it' });
    render(<CommandPaletteDialog />);
    type('>');

    fireEvent.click(rowFor('/compact'));

    await waitFor(() => expect(isNativeCommandContent(draftFor('session-current'))).toBe(true));
    // …and the text the person typed is still there, as the command's argument.
    expect(draftFor('session-current')).toBe('/compact ship it');
  });

  it('swaps the command when the composer already held one, keeping its arguments', async () => {
    // Picking a command while one is typed means "this one instead". Stacking
    // them would hand `/clear` to `/compact` as argument text.
    useSessionChatStore
      .getState()
      .updateSession('session-current', { input: '/clear focus on the API changes' });
    render(<CommandPaletteDialog />);
    type('>');

    fireEvent.click(rowFor('/compact'));

    await waitFor(() =>
      expect(draftFor('session-current')).toBe('/compact focus on the API changes')
    );
    expect(isNativeCommandContent(draftFor('session-current'))).toBe(true);
  });

  it('closes the palette', () => {
    render(<CommandPaletteDialog />);
    type('>');

    fireEvent.click(rowFor('/deploy'));

    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });
});

describe('a Continue row', () => {
  it('opens the conversation it names, in that conversation’s own directory', () => {
    render(<CommandPaletteDialog />);

    fireEvent.click(rowFor('Wiring the palette'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'session-current', dir: ACTIVE_CWD },
    });
  });

  it('says what the conversation is doing, in the ladder’s words', () => {
    render(<CommandPaletteDialog />);

    expect(screen.getByText('Editing palette.ts…')).toBeInTheDocument();
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
      // Quick actions are reached by typing now — the untyped palette is
      // Continue / Recent / New and nothing else (§15).
      type('ping');

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
    type('ghost');

    fireEvent.click(rowFor('Ghost action'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ext:ghost:gone'));
    warn.mockRestore();
  });
});
