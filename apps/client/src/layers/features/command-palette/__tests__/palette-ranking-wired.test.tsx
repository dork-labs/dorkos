/**
 * @vitest-environment jsdom
 *
 * The ranking, reached the way a person reaches it (design-decisions §15).
 *
 * `palette-ranking.test.ts` proves what the scorer does with a corpus. This file
 * proves the scorer is CONNECTED: the real corpus assembly, the real Fuse, the
 * real interaction store and the real agent-frecency key, through a mock
 * `Transport`, ending at the order of rows in the DOM.
 *
 * That split is deliberate and it is the lesson this programme keeps re-learning
 * — a mechanism can be correct in every unit test and never be called. Nothing
 * here stubs `usePaletteSearch`, `usePaletteUsage`, `usePaletteItems` or
 * `useAgentFrecency`; the only fakes are the ports (transport, router, motion)
 * and the browser APIs jsdom lacks.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { useInteractionStore } from '@/layers/entities/interactions';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

// --- Fixtures ---

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-default',
    kind: 'channel',
    slug: 'default',
    title: 'Default',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** An exact match for `shipping` — the "high-relevance room" of P3 AC-2. */
const shippingChannel = makeRoom({
  id: 'room-shipping',
  slug: 'shipping',
  title: 'shipping',
  lastActivityAt: ago(48 * HOUR),
});

/** Two channels that match `alpha` equally well, so only history separates them. */
const alphaOne = makeRoom({ id: 'room-alpha-one', slug: 'alpha-one', title: 'alpha-one' });
const alphaTwo = makeRoom({ id: 'room-alpha-two', slug: 'alpha-two', title: 'alpha-two' });

const ALL_ROOMS = [shippingChannel, alphaOne, alphaTwo];

/**
 * The agents. `Shopping List` is the "low-relevance agent" of P3 AC-2: one
 * letter away from `shipping`, so Fuse admits it and scores it clearly worse.
 *
 * Under the fixed group order this ranking replaced, agents were a group drawn
 * ABOVE channels — so `Shopping List` came first whatever either row scored,
 * which is exactly what the first case below would catch.
 */
const AGENTS = [
  { id: 'agent-shopping', name: 'Shopping List', projectPath: '/projects/shopping' },
  { id: 'agent-runner-one', name: 'Runner One', projectPath: '/projects/runner-one' },
  { id: 'agent-runner-two', name: 'Runner Two', projectPath: '/projects/runner-two' },
];

// --- Ports ---

const mockTransport = createMockTransport();
const mockNavigate = vi.fn();

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
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
    sessions: [],
    agentActivity: {},
    warnings: [],
  });
  mockNavigate.mockClear();
  // Both usage stores start empty, so each case's seeding is the only history
  // the ranker can see.
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
  useDirectoryState: () => ['/projects/shopping', vi.fn()],
  useSessions: () => ({ sessions: [] }),
}));

vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({ sessionCount: 0, recentSessions: [], health: null }),
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

// --- Helpers ---

const searchInput = () => screen.getByPlaceholderText('Search rooms, agents, commands...');
const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });

/**
 * Where each named row sits in the rendered list, top to bottom.
 *
 * Read off `role="option"`, which is what a person's Down arrow walks and what
 * cmdk's Enter acts on — the same list, not a parallel account of it.
 */
function positions(...names: string[]): Record<string, number> {
  const rows = screen.getAllByRole('option').map((el) => el.textContent ?? '');
  const found: Record<string, number> = {};
  for (const name of names) {
    const index = rows.findIndex((text) => text.includes(name));
    expect(index, `no row for "${name}" among ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
    found[name] = index;
  }
  return found;
}

/**
 * Type a query and wait until every row it should produce is on screen.
 *
 * Waiting on the ROWS rather than on a piece of text, because the real search
 * highlights the matched run — a matched name is split across a `<mark>` and its
 * siblings, so `findByText` on it finds nothing. `role="option"` is stable
 * whatever the highlighting does to the words inside.
 */
async function search(query: string, ...expected: string[]) {
  render(<CommandPaletteDialog />);
  await waitFor(() => expect(mockTransport.listRooms).toHaveBeenCalled());
  type(query);
  await waitFor(() => {
    const rows = screen.getAllByRole('option').map((el) => el.textContent ?? '');
    for (const name of expected) {
      expect(
        rows.some((text) => text.includes(name)),
        `no row for "${name}"`
      ).toBe(true);
    }
  });
}

describe('P3 AC-2, wired end to end', () => {
  it('draws a high-relevance channel above a low-relevance agent', async () => {
    await search('shipping', 'shipping', 'Shopping List');

    // Both rows are on screen — the negative half of this claim is worthless
    // without the positive one, since a missing agent row would also satisfy
    // "the channel is above the agent".
    const at = positions('shipping', 'Shopping List');
    expect(at['shipping']).toBeLessThan(at['Shopping List']!);
  });
});

describe('the interaction store moves rank, through the hook', () => {
  it('leaves two equally-matching channels in their default order with no history', async () => {
    await search('alpha', 'alpha-one', 'alpha-two');
    const at = positions('alpha-one', 'alpha-two');
    // The control. Without it, the case below could pass because the seeded
    // room was already first for a reason that has nothing to do with usage.
    expect(at['alpha-one']).toBeLessThan(at['alpha-two']!);
  });

  it('lifts the one this person opened, using the store the sidebar also writes', async () => {
    useInteractionStore.getState().recordOpened('room', alphaTwo.id);

    await search('alpha', 'alpha-one', 'alpha-two');
    const at = positions('alpha-one', 'alpha-two');
    expect(at['alpha-two']).toBeLessThan(at['alpha-one']!);
  });

  it('records an open when a room is chosen here, so the next search is better', async () => {
    await search('alpha', 'alpha-two');
    expect(useInteractionStore.getState().opened[`room:${alphaTwo.id}`]).toBeUndefined();

    const row = screen
      .getAllByRole('option')
      .find((el) => (el.textContent ?? '').includes('alpha-two'));
    fireEvent.click(row as Element);

    expect(useInteractionStore.getState().opened[`room:${alphaTwo.id}`]).toBeDefined();
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: { id: alphaTwo.id } });
  });
});

describe('how often you use something moves rank, through the hook', () => {
  /** The shipped agent-frecency key, written the way the real hook writes it. */
  function seedAgentFrecency(agentId: string, totalCount: number) {
    localStorage.setItem(
      'dorkos:agent-frecency-v2',
      JSON.stringify([{ agentId, timestamps: [Date.now() - HOUR], totalCount }])
    );
  }

  it('leaves two equally-matching agents in their default order with no history', async () => {
    await search('@runner', 'Runner One', 'Runner Two');
    const at = positions('Runner One', 'Runner Two');
    expect(at['Runner One']).toBeLessThan(at['Runner Two']!);
  });

  it('lifts the agent this person opens all the time', async () => {
    seedAgentFrecency('agent-runner-two', 25);

    await search('@runner', 'Runner One', 'Runner Two');
    const at = positions('Runner One', 'Runner Two');
    expect(at['Runner Two']).toBeLessThan(at['Runner One']!);
  });
});

describe('the Best match section', () => {
  it('heads the list when one row stands clear', async () => {
    await search('shipping', 'shipping', 'Shopping List');

    expect(screen.getByText('Best match')).toBeInTheDocument();
    // And it is the row it says it is: first in the list, not merely present.
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('shipping');
  });

  it('stays away when the top two rows are the same answer twice', async () => {
    await search('alpha', 'alpha-one', 'alpha-two');

    expect(screen.queryByText('Best match')).not.toBeInTheDocument();
    // The list is still there, in ranked order — absent does not mean empty.
    const at = positions('alpha-one', 'alpha-two');
    expect(at['alpha-one']).toBeLessThan(at['alpha-two']!);
  });
});
