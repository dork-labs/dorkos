/**
 * @vitest-environment jsdom
 *
 * The ranking, reached the way a person reaches it (design-decisions §15).
 *
 * `palette-ranking.test.ts` proves what the scorer does with a corpus. This file
 * proves the scorer is CONNECTED: the real corpus assembly, the real Fuse, the
 * real interaction store and the real migration off the retired agent-frecency
 * key, through a mock `Transport`, ending at the order of rows in the DOM.
 *
 * That split is deliberate and it is the lesson this programme keeps re-learning
 * — a mechanism can be correct in every unit test and never be called. Nothing
 * here stubs `usePaletteSearch`, `usePaletteUsage`, `usePaletteItems` or
 * `useLegacyFrecencyMigration`; the only fakes are the ports (transport,
 * router, motion) and the browser APIs jsdom lacks.
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

/**
 * A channel with something waiting, and no term to match.
 *
 * It exists for the bare-prefix case: with `#` alone every row scores a perfect
 * relevance and this row's unread would otherwise crown it "Best match" for a
 * query nobody typed.
 */
const loudChannel = makeRoom({
  id: 'room-loud',
  slug: 'loud',
  title: 'loud',
  unreadCount: 4,
  lastActivityAt: ago(HOUR),
});

/**
 * A channel whose name sits BETWEEN two agents' on the `orbit` query, so the
 * ranked list interleaves kinds and the heading for `Agents` has to appear
 * twice. Fixed group order could not produce that list at all.
 */
const orbitChannel = makeRoom({
  id: 'room-orbit',
  slug: 'orbit',
  title: 'orbit',
  // Fresher than `orbiter-relay` (which has no activity at all) and staler than
  // the `orbit` agent below — so the ranking lands it BETWEEN two agents, on the
  // recency signal alone.
  lastActivityAt: ago(12 * HOUR),
});

const ALL_ROOMS = [shippingChannel, alphaOne, alphaTwo, loudChannel, orbitChannel];

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
  // `orbit` matches both of these and `#orbit`; the channel's own freshness puts
  // it between them, which is what makes the Agents heading repeat.
  { id: 'agent-orbit', name: 'orbit', projectPath: '/projects/orbit' },
  { id: 'agent-orbiter', name: 'orbiter-relay', projectPath: '/projects/orbiter-relay' },
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
    // The one agent with a run behind it. It is what lifts `orbit` above
    // `#orbit`, which is what makes the Agents heading repeat below.
    agentActivity: { '/projects/orbit': ago(HOUR) },
    warnings: [],
  });
  mockNavigate.mockClear();
  // Storage and the store both start empty, so each case's seeding is the only
  // history the ranker can see.
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
  it('leaves two equally-matching agents in their default order with no history', async () => {
    await search('@runner', 'Runner One', 'Runner Two');
    const at = positions('Runner One', 'Runner Two');
    expect(at['Runner One']).toBeLessThan(at['Runner Two']!);
  });

  it('lifts the agent this person opens all the time', async () => {
    useInteractionStore
      .getState()
      .mergeUsage([
        { key: 'agent:/projects/runner-two', lastUsedAt: Date.now() - HOUR, useCount: 25 },
      ]);

    await search('@runner', 'Runner One', 'Runner Two');
    const at = positions('Runner One', 'Runner Two');
    expect(at['Runner Two']).toBeLessThan(at['Runner One']!);
  });

  it('separates two agents on the COUNT alone, when they were opened at the same instant', async () => {
    // The half of frecency that only landed in P3.3. Both were opened at the
    // same moment, so `lastUsedAt` cannot order them and only `useCount` can —
    // which is what makes this red when the count stops reaching the ranker,
    // where the case above still passes on recency.
    const sameInstant = Date.now() - HOUR;
    useInteractionStore.getState().mergeUsage([
      { key: 'agent:/projects/runner-one', lastUsedAt: sameInstant, useCount: 1 },
      { key: 'agent:/projects/runner-two', lastUsedAt: sameInstant, useCount: 40 },
    ]);

    await search('@runner', 'Runner One', 'Runner Two');
    const at = positions('Runner One', 'Runner Two');
    expect(at['Runner Two']).toBeLessThan(at['Runner One']!);
  });

  it('counts an open the palette itself records, without any seeding', async () => {
    // The whole chain in one case: choose a row, and the store the sidebar
    // reads is what remembers it. Before P3.3 the count lived in ⌘K's own
    // localStorage key and only ever counted agents.
    await search('alpha', 'alpha-two');
    const row = screen
      .getAllByRole('option')
      .find((el) => (el.textContent ?? '').includes('alpha-two'));
    fireEvent.click(row as Element);

    expect(useInteractionStore.getState().counts[`room:${alphaTwo.id}`]).toBe(1);
  });
});

describe('the retired agent-frecency key, migrated on the way in', () => {
  /** The shipped key, written exactly the way the retired hook wrote it. */
  function seedLegacyAgentFrecency(agentId: string, totalCount: number) {
    localStorage.setItem(
      'dorkos:agent-frecency-v2',
      JSON.stringify([{ agentId, timestamps: [Date.now() - HOUR], totalCount }])
    );
  }

  /**
   * P3 AC-4, at the DOM.
   *
   * `legacy-frecency-migration.test.ts` proves the translation is correct.
   * This proves it is CONNECTED — the real key, read by the real hook the real
   * palette mounts, translated onto the real store, scored by the real ranker,
   * ending at which row is drawn first. Unwire any link in that chain and this
   * reds; nothing else in the suite would.
   */
  it('keeps the rank of an agent this person already used, through the real chain', async () => {
    seedLegacyAgentFrecency('agent-runner-two', 25);

    await search('@runner', 'Runner One', 'Runner Two');

    const at = positions('Runner One', 'Runner Two');
    expect(at['Runner Two']).toBeLessThan(at['Runner One']!);
  });

  it('deletes the key from this browser once it has been read', async () => {
    seedLegacyAgentFrecency('agent-runner-two', 25);
    // Present before, so "absent after" is a change rather than a fact about
    // an empty store.
    expect(localStorage.getItem('dorkos:agent-frecency-v2')).not.toBeNull();

    await search('@runner', 'Runner One', 'Runner Two');

    expect(localStorage.getItem('dorkos:agent-frecency-v2')).toBeNull();
    // And the history landed somewhere: the count is on the record the corpus
    // ranks that agent under.
    expect(useInteractionStore.getState().counts['agent:/projects/runner-two']).toBe(25);
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

  /**
   * The bare-prefix hole, in the browser tree rather than in the scorer.
   *
   * `#` is a truthy search with an empty term, so the palette leaves the command
   * center and draws the ranked list — but nobody typed anything for a row to be
   * the best match FOR. `#loud` has four unread and would otherwise be crowned.
   * Reachable in the product from the chat header's agent chip, which opens the
   * palette pre-filled with a bare `@`.
   */
  it('never appears for a bare prefix, where nothing was typed to match', async () => {
    await search('#', 'loud', 'alpha-one');

    expect(screen.queryByText('Best match')).not.toBeInTheDocument();
    // The unread channel is still first — the ranking ran, only the claim about
    // it was withheld. Without this the case would pass on an empty list.
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('loud');
  });
});

describe('one list, with the headings following the ranking', () => {
  /**
   * P3 AC-2's structural consequence: when the ranking interleaves kinds, a
   * heading appears twice. Fixed group order could not draw this list — every
   * agent sat in one block, above every channel, always.
   *
   * `M10` (grouping collapses repeat runs) reds a unit test on `groupRankedRows`;
   * this is the same claim in the DOM, so the two cannot drift.
   */
  it('repeats a heading when a channel ranks between two agents', async () => {
    await search('orbit', 'orbit', 'orbiter-relay');

    const headings = screen
      .getAllByText((_, el) => el?.getAttribute('cmdk-group-heading') !== null)
      .map((el) => el.textContent);
    expect(headings).toContain('Agents');
    expect(headings).toContain('Channels');
    // The claim: `Agents` heads two separate runs, because a channel came
    // between them in the ranking.
    expect(headings.filter((h) => h === 'Agents')).toHaveLength(2);
    expect(headings.indexOf('Channels')).toBeGreaterThan(headings.indexOf('Agents'));
  });
});
