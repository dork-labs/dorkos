/**
 * @vitest-environment jsdom
 *
 * Scope chips, driven the way a person drives them (P3 AC-3, design-decisions §15).
 *
 * `palette-scope.test.ts` proves what a scope ADMITS, against a fixed corpus.
 * This file proves the chip is CONNECTED: the real corpus assembly, the real
 * Fuse, the real scope filter and the real keyboard handlers, through a mock
 * `Transport`, ending at the rows in the DOM. Nothing here stubs
 * `usePaletteSearch`, `usePaletteItems` or `palette-scope`; the only fakes are
 * the ports (transport, router, motion) and the browser APIs jsdom lacks.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { TooltipProvider } from '@/layers/shared/ui';
import { useInteractionStore } from '@/layers/entities/interactions';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

// --- Fixtures ---

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-default',
    kind: 'channel',
    slug: 'default',
    title: 'Default',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: ago(2 * HOUR),
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> & { id: string; title: string }): Session {
  return {
    createdAt: ago(48 * HOUR),
    updatedAt: ago(3 * HOUR),
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  } as Session;
}

const AGENTS = [
  { id: 'agent-orbit', name: 'Orbit', projectPath: '/projects/orbit' },
  { id: 'agent-lander', name: 'Lander', projectPath: '/projects/lander' },
];

const shipping = makeRoom({ id: 'room-shipping', slug: 'shipping', title: 'Shipping' });
const quiet = makeRoom({ id: 'room-quiet', slug: 'quiet', title: 'Quiet' });
const ALL_ROOMS = [shipping, quiet];

/**
 * The corpus, built so every claim below has to discriminate.
 *
 * Every title contains `probe`, so the residual query alone can never explain a
 * filtered list — only the chip can. Two conversations belong to Orbit, one to
 * Lander, and one came from `#shipping` while living in Lander's directory, so
 * an agent scope and a room scope select genuinely different rows.
 */
const orbitOne = makeSession({ id: 'sess-orbit-1', title: 'probe alpha', cwd: '/projects/orbit' });
const orbitTwo = makeSession({ id: 'sess-orbit-2', title: 'probe beta', cwd: '/projects/orbit' });
const landerOne = makeSession({
  id: 'sess-lander-1',
  title: 'probe gamma',
  cwd: '/projects/lander',
});
const fromShipping = makeSession({
  id: 'sess-shipping-1',
  title: 'probe delta',
  cwd: '/projects/lander',
  origin: 'room',
  // Exactly what `applyRoomOriginOverlay` stamps for a channel: the name a
  // person reads, and the id the scope actually joins on (DOR-1157).
  originLabel: '#shipping',
  originRoomId: 'room-shipping',
});
const ALL_SESSIONS = [orbitOne, orbitTwo, landerOne, fromShipping];

// --- Ports ---

const mockTransport = createMockTransport();
const mockNavigate = vi.fn();

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      {/* Conversation rows carry a tooltip; the app shell provides this. */}
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
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
  vi.mocked(mockTransport.listRooms).mockResolvedValue(ALL_ROOMS);
  vi.mocked(mockTransport.listRecentSessions).mockResolvedValue({
    sessions: ALL_SESSIONS,
    agentActivity: {},
    warnings: [],
  });
  mockNavigate.mockClear();
  localStorage.clear();
  useInteractionStore.getState().reset();
});

afterEach(cleanup);

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

vi.mock('@/layers/shared/model', () => ({
  useTransport: () => mockTransport,
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      globalPaletteOpen: true,
      setGlobalPaletteOpen: vi.fn(),
      toggleGlobalPalette: vi.fn(),
      setPickerOpen: vi.fn(),
      setCanvasOpen: vi.fn(),
      setRightPanelOpen: vi.fn(),
      setActiveRightPanelTab: vi.fn(),
      setPreviousCwd: vi.fn(),
      previousCwd: null,
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
  useSlotContributions: () => [],
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

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: AGENTS }, isLoading: false }),
}));

vi.mock('@/layers/entities/command', () => ({ useCommands: () => ({ data: { commands: [] } }) }));

vi.mock('@/layers/entities/tasks', () => ({
  useActiveTaskRunCount: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/orbit', vi.fn()],
  useSessions: () => ({ sessions: [] }),
}));

vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({ sessionCount: 0, recentSessions: [], health: null }),
}));

vi.mock('@/layers/features/profile', () => ({
  PROFILE_PANEL_ID: 'profile',
  useProfileStore: Object.assign(() => ({}), {
    getState: () => ({ openProfileDocked: vi.fn() }),
  }),
}));

vi.mock('motion/react', () => ({
  motion: {
    // `motion.create(Component)` — needed because this mock SHADOWS the complete
    // one in `test-setup.ts`, and a partial shadow breaks the moment anything in
    // the import graph calls it at module scope (`gen-ui/ui/nodes/TableNode.tsx`
    // does). Identity is enough: nothing here renders the wrapped component.
    create: (Component: unknown) => Component,
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

// --- Helpers ---

const input = () => screen.getByTestId('command-palette-input') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const rowTexts = () => screen.getAllByRole('option').map((el) => el.textContent ?? '');

/** Open the palette and wait until the corpus has arrived. */
async function openPalette() {
  render(<CommandPaletteDialog />);
  await waitFor(() => expect(mockTransport.listRooms).toHaveBeenCalled());
  await waitFor(() => expect(mockTransport.listRecentSessions).toHaveBeenCalled());
}

/** Highlight a row by the text it shows, the way arrowing onto it would. */
async function highlight(text: string) {
  await waitFor(() => expect(rowTexts().some((row) => row.includes(text))).toBe(true));
  const row = screen.getAllByRole('option').find((el) => (el.textContent ?? '').includes(text));
  fireEvent.mouseMove(row as Element);
  fireEvent.mouseEnter(row as Element);
  await waitFor(() => expect((row as Element).getAttribute('data-selected')).toBe('true'));
}

/** Press a key on the cmdk root, where the palette's own handlers live. */
function press(key: string, target: Element = input()) {
  fireEvent.keyDown(target, { key, bubbles: true });
}

/**
 * Put the caret before everything, the way ArrowLeft does in a browser.
 *
 * Set directly rather than by pressing a key, because jsdom moves no caret at
 * all — and NOT by pressing Home, which does not do this even in a browser:
 * cmdk's root claims Home for jumping the highlight to the first row and calls
 * `preventDefault`, so `selectionStart` never moves. The real road is ArrowLeft,
 * which the browser spec drives for real.
 */
function caretToStart() {
  input().setSelectionRange(0, 0);
}

describe('P3 AC-3 — @agent produces a visible chip that filters', () => {
  it('turns the highlighted agent into a chip and searches inside it', async () => {
    await openPalette();
    type('@orbit');
    await highlight('Orbit');

    // Before: the agent row is what the query found. The control for the claim
    // below — without it, "no agent rows" could mean the query never matched.
    expect(rowTexts().some((row) => row.includes('Orbit'))).toBe(true);

    press('Tab');

    // The chip, on screen and named.
    expect(await screen.findByTestId('palette-scope-chip')).toHaveTextContent('Orbit');
    // And the list is now that agent's conversations, and only those. Every
    // session in the corpus is titled `probe …`, so a filter that did nothing
    // would leave all four here.
    await waitFor(() => {
      expect(rowTexts().some((row) => row.includes('probe alpha'))).toBe(true);
    });
    expect(rowTexts().some((row) => row.includes('probe beta'))).toBe(true);
    expect(rowTexts().some((row) => row.includes('probe gamma'))).toBe(false);
    expect(rowTexts().some((row) => row.includes('probe delta'))).toBe(false);
    // The agent itself is gone too: it is what you scoped BY, not something
    // inside the scope.
    expect(rowTexts().some((row) => row.includes('/projects/orbit'))).toBe(false);
  });

  it('heads the scoped list with the scope, not with the kind', async () => {
    await openPalette();
    type('@orbit');
    await highlight('Orbit');
    press('Tab');

    await waitFor(() => {
      const headings = screen
        .getAllByText((_, el) => el?.getAttribute('cmdk-group-heading') !== null)
        .map((el) => el.textContent);
      expect(headings).toContain('Conversations with Orbit');
      expect(headings).not.toContain('Conversations');
    });
  });

  it('narrows further on what is typed AFTER the chip', async () => {
    await openPalette();
    type('@orbit');
    await highlight('Orbit');
    press('Tab');
    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe beta'))).toBe(true));

    type('alpha');

    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe beta'))).toBe(false));
    expect(rowTexts().some((row) => row.includes('probe alpha'))).toBe(true);
  });
});

describe('P3 AC-3 — Backspace pops the chip without clearing the residual query', () => {
  it('drops the scope and keeps what was typed', async () => {
    await openPalette();
    type('@orbit');
    await highlight('Orbit');
    press('Tab');
    await screen.findByTestId('palette-scope-chip');

    type('probe');
    caretToStart();
    press('Backspace');

    // The chip is gone…
    await waitFor(() => expect(screen.queryByTestId('palette-scope-chip')).toBeNull());
    // …the query survived, character for character…
    expect(input().value).toBe('probe');
    // …and the list is the unscoped answer to that query, which now includes
    // the conversations the chip was hiding.
    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe gamma'))).toBe(true));
  });

  it('deletes a character instead when the caret is not at the start', async () => {
    // The other half of the same rule. Without it, Backspace anywhere in a
    // scoped query would eat the chip and leave the person unable to edit what
    // they typed.
    await openPalette();
    type('@orbit');
    await highlight('Orbit');
    press('Tab');
    await screen.findByTestId('palette-scope-chip');

    type('alpha');
    input().setSelectionRange(5, 5);
    press('Backspace');

    expect(screen.queryByTestId('palette-scope-chip')).not.toBeNull();
  });
});

describe('#channel behaves identically for rooms', () => {
  it('scopes to the conversations that came from that channel', async () => {
    await openPalette();
    type('#ship');
    await highlight('shipping');
    press('Tab');

    expect(await screen.findByTestId('palette-scope-chip')).toHaveTextContent('#shipping');
    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe delta'))).toBe(true));
    // `probe delta` lives in Lander's directory, so a room scope selecting it
    // cannot be the agent join wearing a different name.
    expect(rowTexts().some((row) => row.includes('probe gamma'))).toBe(false);
    expect(rowTexts().some((row) => row.includes('probe alpha'))).toBe(false);
  });

  it('says so when a channel started nothing, rather than showing an empty box', async () => {
    await openPalette();
    type('#quiet');
    await highlight('quiet');
    press('Tab');

    expect(await screen.findByText('No conversations came from #quiet.')).toBeInTheDocument();
  });

  it('pops on Backspace exactly as an agent chip does', async () => {
    await openPalette();
    type('#ship');
    await highlight('shipping');
    press('Tab');
    await screen.findByTestId('palette-scope-chip');

    caretToStart();
    press('Backspace');

    await waitFor(() => expect(screen.queryByTestId('palette-scope-chip')).toBeNull());
  });
});

describe('two chips at once are rejected, by construction', () => {
  it('leaves no agent and no channel in a scoped list to take a second chip', async () => {
    await openPalette();
    type('@orbit');
    await highlight('Orbit');
    press('Tab');
    await screen.findByTestId('palette-scope-chip');
    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe alpha'))).toBe(true));

    // The claim is structural, so it is asserted structurally: every row on
    // screen is one of the corpus's CONVERSATIONS. Enumerated from the fixtures
    // rather than matched on text — a session row shows its agent's name
    // (`Orbit › probe alpha`), so a text filter for "Orbit" would flag the very
    // rows the scope is supposed to contain.
    //
    // cmdk stamps `data-value` from each row's `value` prop, which is the
    // session id for a conversation, the room id for a channel and the agent's
    // display name for an agent — so this says "no agent and no channel row"
    // in the one place those three are distinguishable.
    //
    // Wrapped in its own `waitFor` rather than read once: the row-text wait
    // above only proves a session row arrived, not that the agent/channel rows
    // it is replacing are gone yet — under load those can still be settling on
    // a later render pass, which is exactly what made this flake (DOR-1502).
    const sessionIds = new Set(ALL_SESSIONS.map((session) => session.id));
    await waitFor(() => {
      const values = screen.getAllByRole('option').map((el) => el.getAttribute('data-value') ?? '');
      expect(values.length).toBeGreaterThan(0);
      expect(values.filter((value) => !sessionIds.has(value))).toEqual([]);
    });

    // The footer agrees, which is what the comment used to promise and never
    // checked: with nothing scopable highlighted, Tab is not offered.
    await highlight('probe alpha');
    expect(screen.queryByText('Search inside')).toBeNull();

    // And pressing it anyway adds nothing.
    press('Tab');
    expect(screen.getAllByTestId('palette-scope-chip')).toHaveLength(1);
    expect(screen.getByTestId('palette-scope-chip')).toHaveTextContent('Orbit');
  });

  it('does not scope on Shift+Tab, which is a person walking focus backwards', async () => {
    // Without the `!e.shiftKey` guard this scopes, so Shift+Tab — the one
    // keystroke whose whole meaning is "go back" — would pick a chip UP.
    await openPalette();
    type('@orbit');
    await highlight('Orbit');

    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true, bubbles: true });

    expect(screen.queryByTestId('palette-scope-chip')).toBeNull();
    // The control: plain Tab on the same highlighted row does scope, so this is
    // a fact about Shift and not about the row being unreachable.
    press('Tab');
    expect(await screen.findByTestId('palette-scope-chip')).toHaveTextContent('Orbit');
  });
});

describe('a prefix inside a scope is a character, not a mode', () => {
  it('does not empty the list when a prefix is typed under a chip', async () => {
    // Every prefix asks for a KIND the scope does not contain, so all three used
    // to empty a scoped list and answer with the same "No conversations with X
    // yet." a genuinely empty scope shows — one character, two meanings, one
    // message. Under a chip the prefixes simply do not apply.
    await openPalette();
    type('@orbit');
    await highlight('Orbit');
    press('Tab');
    await screen.findByTestId('palette-scope-chip');
    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe alpha'))).toBe(true));

    type('#');

    // `#` matched no conversation title, so the list is empty — but the palette
    // says "nothing matched", not "this agent has no conversations", which is
    // the sentence that was wrong.
    await waitFor(() => expect(screen.queryByText('No conversations with Orbit yet.')).toBeNull());
  });

  it('searches for the character when a title contains it', async () => {
    await openPalette();
    type('@lander');
    await highlight('Lander');
    press('Tab');
    await screen.findByTestId('palette-scope-chip');

    // `probe delta` is Lander's, and typing part of its title still finds it —
    // the scope narrowed the corpus, and what comes after the chip is a plain
    // search inside it.
    type('delta');
    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe delta'))).toBe(true));
  });
});

describe('opening a conversation from ⌘K remembers both halves of it', () => {
  it('records the conversation AND the agent whose project it runs in', async () => {
    // The sidebar's own row has always written both (`SidebarChrome.openSession`);
    // ⌘K wrote only the first, so the same act built a weaker memory depending
    // on which door a person used. Both, or the two surfaces disagree.
    await openPalette();
    type('probe alpha');
    await waitFor(() => expect(rowTexts().some((r) => r.includes('probe alpha'))).toBe(true));

    const row = screen
      .getAllByRole('option')
      .find((el) => (el.textContent ?? '').includes('probe alpha'));
    fireEvent.click(row as Element);

    const { opened } = useInteractionStore.getState();
    expect(opened['session:sess-orbit-1']).toBeDefined();
    expect(opened['agent:/projects/orbit']).toBeDefined();
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'sess-orbit-1', dir: '/projects/orbit' },
    });
  });
});

describe('the chip tells you how to work it', () => {
  it('offers Tab only while a scopable row is highlighted', async () => {
    await openPalette();
    // A conversation is not something you can look inside — it IS the inside.
    type('probe alpha');
    await highlight('probe alpha');
    expect(screen.queryByText('Search inside')).toBeNull();

    type('@orbit');
    await highlight('Orbit');
    expect(await screen.findByText('Search inside')).toBeInTheDocument();
  });

  it('offers Backspace only while a chip is up', async () => {
    await openPalette();
    expect(screen.queryByText(/Clear scope/)).toBeNull();

    type('@orbit');
    await highlight('Orbit');
    press('Tab');

    // The hint names its CONDITION: Backspace clears the scope only with the
    // caret at the start, and anywhere else it deletes a character. A bare
    // "Clear scope" was a lie for most of the time a chip is up.
    expect(await screen.findByText('Clear scope, at the start')).toBeInTheDocument();
  });
});
