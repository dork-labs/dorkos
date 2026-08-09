// @vitest-environment jsdom
/**
 * The honest quiet state (team-room-home spec D3.6).
 *
 * Three promises are pinned here. "All quiet." is a claim about RIGHT NOW, so it
 * is measured against the read cursor as it stood when the page opened —
 * anything said since is a conversation, and a conversation is not a quiet
 * morning. The room never fakes a recap: with nothing scheduled it says two
 * words and stops, and every forward look it does draw is read out of a real
 * task. And it never talks over the pinned triage header: anything waiting or
 * wrong is the header's line, and this stands down for good.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { Task } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';

// The attention rows navigate, and the session list reads `?session=`. Neither
// is what this file is about, so the router is stubbed rather than stood up.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useRouter: () => ({ state: { location: { pathname: '/', search: {} } } }),
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

// DorkBot's suggestion has its own suite, where the registry can be controlled.
// What matters here is the one thing only this file can answer: WHEN the quiet
// state lets it speak at all. The rest of the barrel is kept (DOR-902) — a
// factory that returns only the one override deletes every other export for
// anything else in the tree that imports from it.
let suggestionQualifies = true;
vi.mock('@/layers/features/feature-promos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/feature-promos')>();
  return {
    ...actual,
    QuietSuggestion: () => (suggestionQualifies ? <p data-testid="quiet-suggestion" /> : null),
  };
});

import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '@/layers/entities/room';
import { HomeQuietState } from '../ui/HomeQuietState';

const ROOM_ID = 'team-room';
const VIEWER_ID = 'author-you';

/** One post in the room, so it has a history behind it. */
function post(seq: number): RoomEntry {
  return {
    roomId: ROOM_ID,
    seq,
    id: `entry-${seq}`,
    authorId: 'dorian',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-08-07T10:00:00.000Z',
  };
}

/** A scheduled task, overriding only what a test cares about. */
function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'morning-standup',
    displayName: 'Morning standup',
    description: null,
    prompt: 'Summarise yesterday',
    cron: '0 9 * * *',
    timezone: null,
    agentId: null,
    enabled: true,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'active',
    filePath: '/tasks/morning-standup.md',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    nextRun: null,
    ...overrides,
  };
}

/** A pending approval, so the header has something to say instead. */
function buildApproval(): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    hasAgentPath: true,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
  };
}

/** A mesh report with agents nobody can reach — one real attention row. */
function unreachable(count: number) {
  return {
    totalAgents: count,
    activeCount: 0,
    inactiveCount: 0,
    staleCount: 0,
    unreachableCount: count,
    byRuntime: {},
    byProject: {},
  };
}

/**
 * #team with a roster, so the reader has a read cursor to be frozen from.
 *
 * `lastReadSeq` is the whole point of this fixture: it is where the reader had
 * got to when the page opened, and everything the room says after it is what
 * makes the morning not quiet.
 */
function roomWithCursor(lastReadSeq: number) {
  return {
    id: ROOM_ID,
    kind: 'channel' as const,
    slug: 'team',
    title: '#team',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    wellKnown: 'team',
    createdAt: '2026-08-01T09:00:00.000Z',
    lastActivityAt: '2026-08-07T10:00:00.000Z',
    viewerAuthorId: VIEWER_ID,
    reactionFrequents: [] as string[],
    members: [
      {
        roomId: ROOM_ID,
        authorId: VIEWER_ID,
        responseMode: 'always' as const,
        joinedAt: '2026-08-01T09:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq,
        author: { id: VIEWER_ID, kind: 'human' as const, displayName: 'Dorian', handle: null },
        origin: 'local' as const,
      },
    ],
  };
}

/**
 * Render the quiet state over a room whose history is already in the cache —
 * which is how it reaches this component in the app, since the room surface
 * below it does the fetching.
 *
 * `lastReadSeq` defaults to the newest entry, i.e. a reader who is caught up.
 * That is the only arrangement the line is allowed to appear in, so it is the
 * baseline every other test varies from.
 */
function renderQuiet({
  entries = [post(1)],
  lastReadSeq,
  presenceOccupied = false,
  transport: overrides = {},
}: {
  entries?: RoomEntry[];
  lastReadSeq?: number;
  presenceOccupied?: boolean;
  transport?: Partial<Transport>;
} = {}) {
  const caughtUpTo = lastReadSeq ?? entries.at(-1)?.seq ?? 0;
  const transport = createMockTransport({
    getRoom: vi.fn().mockResolvedValue(roomWithCursor(caughtUpTo)),
    ...overrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  queryClient.setQueryData(roomKeys.entries(ROOM_ID), entries);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  const view = render(<HomeQuietState roomId={ROOM_ID} presenceOccupied={presenceOccupied} />, {
    wrapper: Wrapper,
  });

  /** Re-render with a different presence occupancy, keeping everything else. */
  const setPresence = (occupied: boolean) =>
    view.rerender(<HomeQuietState roomId={ROOM_ID} presenceOccupied={occupied} />);

  return { transport, queryClient, setPresence, ...view };
}

/** The quiet line, or `null` when it drew nothing at all. */
function quietLine(): HTMLElement | null {
  return document.querySelector('[data-slot="home-quiet-state"]');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.useRealTimers();
  suggestionQualifies = true;
});

describe('HomeQuietState — when it speaks', () => {
  it('says "All quiet." and nothing more when there is nothing ahead', async () => {
    const { transport } = renderQuiet();

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
    await waitFor(() => expect(transport.listTasks).toHaveBeenCalled());
    // The whole line, so a padded second sentence would show up here.
    expect(quietLine()!.textContent).toBe('All quiet.');
  });

  it('names a scheduled run with a real time when there is one', async () => {
    // Tomorrow morning, local — not "now plus 26 hours", which lands two days
    // out for anyone running this suite late in the evening.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const at = tomorrow.toISOString();
    const task = buildTask({ nextRun: at });
    renderQuiet({ transport: { listTasks: vi.fn().mockResolvedValue([task]) } });

    await screen.findByText('All quiet.');
    await waitFor(() => expect(quietLine()!.textContent).toContain(task.displayName));
    // Read off the fixture's own timestamp — not a sentence this test invented.
    expect(quietLine()!.textContent).toContain(
      new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    );
    expect(quietLine()!.textContent).toContain('tomorrow');
  });

  it('leaves the forward look off when the scheduler is switched off', async () => {
    const listTasks = vi.fn().mockResolvedValue([buildTask({ nextRun: new Date().toISOString() })]);
    const { transport } = renderQuiet({
      transport: {
        listTasks,
        getConfig: vi
          .fn()
          .mockResolvedValue({ tasks: { enabled: false }, relay: { enabled: false } }),
      },
    });

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    // A feature nobody has switched on has no runs to promise.
    expect(listTasks).not.toHaveBeenCalled();
    expect(quietLine()!.textContent).toBe('All quiet.');
  });
});

describe('HomeQuietState — when it stands down', () => {
  it('draws nothing on a room with no history — day one is the chips, not a recap', async () => {
    const { transport } = renderQuiet({ entries: [] });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });

  it('draws nothing while the history has not loaded', async () => {
    // No `setQueryData` for this room at all: nothing is known yet, and nothing
    // is claimed.
    const transport = createMockTransport();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <HomeQuietState roomId={ROOM_ID} presenceOccupied={false} />
        </TransportProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });

  it('draws nothing when an approval is waiting — the header already says so', async () => {
    const { transport } = renderQuiet({
      transport: {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      },
    });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(quietLine()).toBeNull());
  });

  it('draws nothing when something needs attention', async () => {
    const { transport } = renderQuiet({
      transport: { getMeshStatus: vi.fn().mockResolvedValue(unreachable(1)) },
    });

    await waitFor(() => expect(transport.getMeshStatus).toHaveBeenCalled());
    await waitFor(() => expect(quietLine()).toBeNull());
  });

  it('draws nothing while somebody is working — that is not quiet', async () => {
    const { transport } = renderQuiet({ presenceOccupied: true });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });
});

describe('HomeQuietState — "quiet" is a claim about right now', () => {
  it('says nothing over a room that has been talking since the reader arrived', async () => {
    // The reader had read up to entry 1. Entries 2 and 3 landed after that, so
    // the feed underneath this line is a live conversation — and "All quiet."
    // over it is the room asserting something its own contents disprove.
    const { transport } = renderQuiet({
      entries: [post(1), post(2), post(3)],
      lastReadSeq: 1,
    });

    await waitFor(() => expect(transport.getRoom).toHaveBeenCalledWith(ROOM_ID));
    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });

  it('speaks when everything in the room is at or behind where the reader had got to', async () => {
    renderQuiet({ entries: [post(1), post(2), post(3)], lastReadSeq: 3 });

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
  });

  it('says nothing to a reader who is not a member — no cursor is not "nothing new"', async () => {
    const { transport } = renderQuiet({
      // A room the reader can see but is not in: the roster holds somebody else.
      transport: {
        getRoom: vi.fn().mockResolvedValue({
          ...roomWithCursor(1),
          viewerAuthorId: 'somebody-else',
        }),
      },
    });

    await waitFor(() => expect(transport.getRoom).toHaveBeenCalled());
    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });

  it('holds the cursor it arrived with, so reading the room cannot make it lie', async () => {
    // The reader arrives caught up, and the line is honest.
    const { queryClient } = renderQuiet({ entries: [post(1), post(2)], lastReadSeq: 2 });
    expect(await screen.findByText('All quiet.')).toBeInTheDocument();

    // Now somebody says something, and looking at the room marks it read — which
    // is exactly what `useMarkRoomRead` does to this cache, within a frame. A
    // component reading the LIVE cursor would compare 3 against 3, call it
    // caught up, and leave "All quiet." sitting over a message that had just
    // arrived. The frozen copy still remembers arriving at 2.
    act(() => {
      queryClient.setQueryData(roomKeys.entries(ROOM_ID), [post(1), post(2), post(3)]);
      queryClient.setQueryData(roomKeys.detail(ROOM_ID), roomWithCursor(3));
    });

    await waitFor(() => expect(quietLine()).toBeNull());
  });
});

describe('HomeQuietState — DorkBot may say one thing (spec D5.3)', () => {
  /** The suggestion stub, or `null` when the quiet state never mounted it. */
  const suggestion = () => screen.queryByTestId('quiet-suggestion');

  it('offers the suggestion when there is nothing ahead', async () => {
    renderQuiet();

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
    await waitFor(() => expect(suggestion()).toBeInTheDocument());
    // Inside the quiet state's own strip, so it fades and retires with it.
    expect(quietLine()!.contains(suggestion())).toBe(true);
  });

  it('still speaks under a real run, below it — discovery is not only for the idle', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    renderQuiet({
      transport: {
        listTasks: vi.fn().mockResolvedValue([buildTask({ nextRun: tomorrow.toISOString() })]),
      },
    });

    // Somebody who runs schedules ALWAYS has a forward look, so a rule that hid
    // the suggestion whenever one existed would hide it from the people using
    // the product most. What keeps the pair honest is qualification — a promo
    // offering what this install already has does not qualify — not silence.
    await waitFor(() => expect(quietLine()!.textContent).toContain('Morning standup'));
    const forwardLookLine = quietLine()!.querySelector('p')!;
    expect(suggestion()).toBeInTheDocument();

    // Under it, not woven into it.
    expect(forwardLookLine.contains(suggestion())).toBe(false);
    expect(
      forwardLookLine.compareDocumentPosition(suggestion()!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('says nothing at all when an approval is waiting — the whole line stands down', async () => {
    const { transport } = renderQuiet({
      transport: {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      },
    });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(quietLine()).toBeNull());
    // The gate is inherited, not restated: no line, so no suggestion either.
    expect(suggestion()).toBeNull();
  });

  it('leaves the line at two words when nothing qualifies — no empty container', async () => {
    suggestionQualifies = false;
    const { transport } = renderQuiet();

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
    await waitFor(() => expect(transport.listTasks).toHaveBeenCalled());
    expect(quietLine()!.textContent).toBe('All quiet.');
  });

  it('says nothing over a room that has been talking, suggestion and all', async () => {
    const { transport } = renderQuiet({ entries: [post(1), post(2)], lastReadSeq: 1 });

    await waitFor(() => expect(transport.getRoom).toHaveBeenCalledWith(ROOM_ID));
    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
    expect(suggestion()).toBeNull();
  });
});

describe('HomeQuietState — it comes down once', () => {
  it('does not blink back in when the presence strip clears again', async () => {
    const { setPresence } = renderQuiet();

    // Shown: the room is quiet and nobody is working.
    expect(await screen.findByText('All quiet.')).toBeInTheDocument();

    // An agent picks something up. The header takes over, and this stands down.
    setPresence(true);
    await waitFor(() => expect(quietLine()).toBeNull());

    // The turn ends. A line that came back here would be a bordered element
    // appearing and disappearing above a feed somebody is reading, every time an
    // agent breathed.
    setPresence(false);
    await waitFor(() => expect(quietLine()).toBeNull());
    expect(screen.queryByText('All quiet.')).toBeNull();
  });
});
