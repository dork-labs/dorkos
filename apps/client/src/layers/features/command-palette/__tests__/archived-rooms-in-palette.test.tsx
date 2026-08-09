/**
 * @vitest-environment jsdom
 *
 * Archived rooms, findable from the palette and nowhere else (DOR-1051).
 *
 * A channel somebody closed used to vanish from the product entirely: the
 * server has always been able to list them, but no client ever asked. The
 * palette asks — and it is the ONLY thing that does, which is the claim most of
 * this file is about.
 *
 * Like `rooms-in-palette.test.tsx`, the room hook, the ordering and the row are
 * all the real ones, reached through a mock `Transport`.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
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
    unreadCount: null,
    participants: null,
    ...overrides,
  };
}

/**
 * A live channel with something waiting.
 *
 * Unread deliberately: it is the POSITIVE ANCHOR the zero-query case waits on.
 * A negative assertion ("the archived room is not here") resolves happily
 * against an empty DOM, so without a row that must be present it passes before
 * the room list has even arrived — which is what it did.
 */
const live = makeRoom({
  id: 'room-live',
  slug: 'shipping',
  title: 'Shipping',
  lastActivityAt: '2026-07-26T09:00:00.000Z',
  unreadCount: 1,
});

/**
 * A closed channel that is both unread and the last thing that spoke, so
 * "archived sorts last" cannot pass by accident, and "archived is never in the
 * Unread group" is a claim about a room that would otherwise qualify.
 */
const archived = makeRoom({
  id: 'room-archived',
  slug: 'shipping-2025',
  title: 'Shipping 2025',
  archived: true,
  lastActivityAt: '2026-07-26T20:00:00.000Z',
  unreadCount: 4,
});

const mockTransport = createMockTransport();

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// jsdom implements neither, and cmdk needs both.
globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});
Element.prototype.scrollIntoView = vi.fn();

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

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
  useMeshAgentPaths: () => ({ data: { agents: [] }, isLoading: false }),
}));

vi.mock('@/layers/entities/command', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));

vi.mock('@/layers/entities/tasks', () => ({
  useActiveTaskRunCount: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/ana', vi.fn()],
  useSessions: () => ({ sessions: [] }),
}));

vi.mock('../model/use-agent-frecency', () => ({
  useAgentFrecency: () => ({
    entries: [],
    recordUsage: vi.fn(),
    getSortedAgentIds: (ids: string[]) => ids,
  }),
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
  // Answers the way the route does: archived rooms only when asked for.
  vi.mocked(mockTransport.listRooms).mockImplementation(
    async (query?: { includeArchived?: boolean }) =>
      query?.includeArchived ? [live, archived] : [live]
  );
});

afterEach(cleanup);

const searchInput = () => screen.getByTestId('command-palette-input');
const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });
const rowNames = () => screen.getAllByRole('option').map((el) => el.textContent);

async function optionFor(text: string): Promise<HTMLElement> {
  const row = (await screen.findByText(text)).closest('[role="option"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('archived rooms in the palette', () => {
  it('asks for them — and is the only reader that does', async () => {
    render(<CommandPaletteDialog />);
    await waitFor(() => expect(mockTransport.listRooms).toHaveBeenCalled());

    expect(mockTransport.listRooms).toHaveBeenCalledWith({ includeArchived: true });
    // Never the bare call as well: a second, archive-free fetch here would mean
    // the palette and the sidebar are sharing one cache entry after all.
    expect(vi.mocked(mockTransport.listRooms).mock.calls).toEqual([[{ includeArchived: true }]]);
  });

  it('finds a channel that was closed', async () => {
    render(<CommandPaletteDialog />);
    type('#');

    await waitFor(() => expect(screen.getByText('#shipping-2025')).toBeInTheDocument());
  });

  it('says on the row that it is archived', async () => {
    render(<CommandPaletteDialog />);
    type('#');

    const row = await optionFor('#shipping-2025');
    expect(within(row).getByText('Archived')).toBeInTheDocument();
    // And a live channel is not labelled, so this is the room's state showing
    // rather than a badge on every row.
    const liveRow = await optionFor('#shipping');
    expect(within(liveRow).queryByText('Archived')).toBeNull();
  });

  it('ranks it below a live channel, however loudly it ended', async () => {
    render(<CommandPaletteDialog />);
    type('#');

    await waitFor(() => expect(screen.getByText('#shipping-2025')).toBeInTheDocument());
    // `archived` is unread AND the most recent thing that spoke, so it outranks
    // `live` on every key except the one that matters.
    expect(rowNames().findIndex((n) => n?.includes('#shipping-2025'))).toBeGreaterThan(
      rowNames().findIndex((n) => n?.includes('#shipping'))
    );
  });

  it('never leads the palette with one, even when it is owed a read', async () => {
    // Zero-query shows the Unread group and nothing else room-shaped. Both
    // rooms here are unread, so the ONLY thing that can separate them is the
    // archived guard.
    render(<CommandPaletteDialog />);

    // The positive anchor first, so the absence below is asserted against a
    // list that has demonstrably arrived and rendered. Without it this case
    // passed against an empty DOM — and stayed green with the guard deleted.
    await screen.findByText('#shipping');

    expect(screen.queryByText('#shipping-2025')).not.toBeInTheDocument();
  });

  it('opens it like any other room', async () => {
    render(<CommandPaletteDialog />);
    type('#');

    fireEvent.click(await optionFor('#shipping-2025'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/channels',
      search: { id: 'room-archived' },
    });
  });
});
