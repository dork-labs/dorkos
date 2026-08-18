// @vitest-environment jsdom
/**
 * The room's live lane, driven by the real presence store.
 *
 * The suite `RoomPresenceLine.test.tsx`, moved to the component that
 * replaced it. Every claim it made about the words, the announcer and the
 * collapse to one row per agent is still made here; three of them changed
 * subject rather than being dropped, and each says so where it does:
 *
 * - The line is now **always mounted at a fixed height**, so "draws nothing at
 *   all" is a claim about the CONTENT rather than about the element.
 * - The elapsed reading **starts at ten seconds** (design record: a number that
 *   starts at `0s` draws the eye for nothing), so the counting-up case waits for
 *   it rather than reading `0s`.
 * - Past three agents the names move into the **peek** rather than into an
 *   inline disclosure list, so the count opens a popover.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoomEntry, RoomRosterEntry, RoomSignalEvent } from '@dorkos/shared/room-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { RoomLiveLane } from '../ui/RoomLiveLane';

const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateSpy }));

// The fleet reads behind the faces are not what this suite is about, and an
// unresolved mesh is a state the room already handles by falling back to the
// roster — which is exactly what the names below come from.
vi.mock('../model/agent-info-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../model/agent-info-context')>()),
  useRoomAgentDirectory: () => ({ info: new Map(), faces: new Map() }),
}));

const ROOM = 'room-1';
const STARTED = '2026-07-30T10:00:00.000Z';

/** A roster entry for an agent, which is all this lane reads off a member. */
function member(id: string, displayName: string): RoomRosterEntry {
  return {
    roomId: ROOM,
    authorId: id,
    responseMode: 'engaged',
    joinedAt: STARTED,
    joinedSeq: 0,
    lastReadSeq: 0,
    author: { id, kind: 'agent', displayName, handle: null },
    origin: 'local',
  };
}

const ROSTER = [
  member('kai', 'Kai'),
  member('ana', 'Ana'),
  member('sam', 'Sam'),
  member('rae', 'Rae'),
];

/** One entry, so the peek has something to quote back. */
function entry(id: string, text: string): RoomEntry {
  return {
    id,
    roomId: ROOM,
    seq: 1,
    kind: 'post',
    authorId: 'reader',
    body: { text },
    createdAt: STARTED,
    reactions: [],
    attachments: [],
  } as unknown as RoomEntry;
}

const ENTRIES = [entry('trigger-kai', 'can you log today’s decisions?')];

/** The room the lane draws for, with only what it reads off one. */
const ROOM_WITH_ROSTER = {
  id: ROOM,
  kind: 'channel',
  members: ROSTER,
  viewerAuthorId: 'reader',
} as unknown as Parameters<typeof RoomLiveLane>[0]['room'];

/**
 * Put one live claim in the store, the way the stream would.
 *
 * Set the clock BEFORE calling this, not after: `lastSeenAt` is read from the
 * clock as it stands, and a claim whose last publish is older than the TTL is
 * one this lane is right to have forgotten. Age comes from `since`, which is
 * what the server sends and what the elapsed time is derived from.
 */
function working(
  authorId: string,
  state: 'working' | 'working_late' = 'working',
  since = STARTED,
  entryId = `trigger-${authorId}`
): void {
  const event: RoomSignalEvent = {
    type: 'signal',
    signal: 'progress',
    authorId,
    at: since,
    state,
    entryId,
    since,
  };
  useRoomPresenceStore.getState().observe(ROOM, event);
}

/** The line's text, with the separators normalised to single spaces. */
function line(): string {
  return screen.getByTestId('room-presence').textContent!.replace(/\s+/gu, ' ').trim();
}

/** Mount the lane with everything a room hands it. */
function renderLane(props: Partial<Parameters<typeof RoomLiveLane>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TransportProvider transport={createMockTransport()}>
      <QueryClientProvider client={client}>
        <RoomLiveLane
          room={ROOM_WITH_ROSTER}
          entries={ENTRIES}
          laneScope="room"
          stalled={false}
          {...props}
        />
      </QueryClientProvider>
    </TransportProvider>
  );
}

beforeEach(() => {
  navigateSpy.mockClear();
  useRoomPresenceStore.setState({ rooms: {} });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(STARTED));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RoomLiveLane', () => {
  it('says nothing at all when nobody is working, and still holds its place', () => {
    renderLane();

    // No sentence, no placeholder — but the lane itself is mounted and 24px
    // tall, which is the whole reason nothing moves when a claim arrives. (The
    // height is a browser claim; `lane-no-shift.spec.ts` is what can see it.)
    expect(screen.queryByTestId('room-presence')).toBeNull();
    expect(document.querySelector('[data-slot="live-lane"]')).toHaveClass('h-6');
    // The announcer is the one thing that stays, and `sr-only` takes no room.
    const announcer = screen.getByRole('status');
    expect(announcer).toBeEmptyDOMElement();
    expect(announcer).toHaveClass('sr-only');
  });

  it('names one agent and how long it has been on it', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');

    renderLane();

    expect(line()).toBe('Kai is working on it · 42s');
  });

  it('says so when a turn has outrun the room’s wait', () => {
    vi.setSystemTime(new Date('2026-07-30T10:12:00.000Z'));
    working('kai', 'working_late');

    renderLane();

    expect(line()).toBe('Kai is still working — this is taking longer than usual · 12m');
  });

  it('names two, and counts from the one that started first', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai', 'working', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:00:30.000Z');

    renderLane();

    expect(line()).toBe('Kai and Ana are working on it · 42s');
  });

  it('names three', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai', 'working', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:00:10.000Z');
    working('sam', 'working', '2026-07-30T10:00:20.000Z');

    renderLane();

    expect(line()).toBe('Kai, Ana and Sam are working on it · 42s');
  });

  it('says a long wait is a long wait with more than one agent on it', () => {
    // The defect this pins: the taking-longer wording was the single-agent case
    // only, so a second agent picking something up silently withdrew the one
    // statement a waiting person can act on.
    vi.setSystemTime(new Date('2026-07-30T10:12:00.000Z'));
    working('kai', 'working_late', '2026-07-30T10:00:00.000Z');
    working('ana', 'working_late', '2026-07-30T10:00:30.000Z');

    renderLane();

    expect(line()).toBe('Kai and Ana are still working — this is taking longer than usual · 12m');
    expect(screen.getByRole('status').textContent).toBe(
      'Kai and Ana are still working — this is taking longer than usual'
    );
  });

  it('counts past three, and hands the names over in the peek', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:40.000Z'));
    working('kai', 'working', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:00:10.000Z');
    working('sam', 'working', '2026-07-30T10:00:20.000Z');
    working('rae', 'working', '2026-07-30T10:00:30.000Z');

    renderLane();

    expect(line()).toBe('4 agents are working on it · 40s');
    expect(screen.queryByTestId('live-peek')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

    // Each on its own clock, not the aggregate's — Rae started thirty seconds
    // after Kai and the peek has to say so. Read per row rather than as one
    // string: a letter avatar puts its own letter into `textContent`.
    const rows = screen.getAllByTestId('live-peek-row');
    expect(rows).toHaveLength(4);
    expect(
      rows.map((row) => [
        within(row).getByText(/^(Kai|Ana|Sam|Rae)$/u).textContent,
        within(row).getByText(/^\d+s$/u).textContent,
      ])
    ).toEqual([
      ['Kai', '40s'],
      ['Ana', '30s'],
      ['Sam', '20s'],
      ['Rae', '10s'],
    ]);
  });

  it('carries the long wait into the count, and into the peek row it belongs to', () => {
    // Past the naming limit the line used to drop state twice over — the count
    // never said anything was slow, and the list behind it printed four
    // identical-looking rows. That list is exactly where a person goes to find
    // out which agent to chase.
    vi.setSystemTime(new Date('2026-07-30T10:20:00.000Z'));
    working('kai', 'working_late', '2026-07-30T10:00:00.000Z');
    working('ana', 'working', '2026-07-30T10:19:00.000Z');
    working('sam', 'working', '2026-07-30T10:19:20.000Z');
    working('rae', 'working', '2026-07-30T10:19:40.000Z');

    renderLane();

    expect(line()).toBe('4 agents are still working — this is taking longer than usual · 20m');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show who is working',
      })
    );

    const rows = screen.getAllByTestId('live-peek-row');
    expect(within(rows[0]!).getByText('still working')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('working')).toBeInTheDocument();
  });

  it('renders an agent once however many claims it holds, at the older one', () => {
    vi.setSystemTime(new Date('2026-07-30T10:12:00.000Z'));
    working('kai', 'working', '2026-07-30T10:00:30.000Z', 'trigger-a');
    working('kai', 'working_late', '2026-07-30T10:00:00.000Z', 'trigger-b');

    renderLane();

    expect(line()).toBe('Kai is still working — this is taking longer than usual · 12m');
  });

  it('counts up on its own, with nothing arriving — and not before ten seconds', async () => {
    working('kai');

    renderLane();
    // No number yet. A timer that starts at `0s` draws the eye for nothing, so
    // the lane waits ten seconds before it puts one up (design record).
    expect(line()).toBe('Kai is working on it');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    expect(line()).toBe('Kai is working on it · 11s');
  });

  it('announces the sentence, and never the number that ticks', async () => {
    // The announcer is mounted before anything is working, so the sentence lands
    // as a CHANGE to a region assistive technology is already watching — a live
    // region that appears with its text already in it is the case that goes
    // unannounced.
    renderLane();
    const announcer = screen.getByRole('status');
    expect(announcer).toBeEmptyDOMElement();

    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    act(() => working('kai', 'working', STARTED));

    // The sentence, and only the sentence. The elapsed time is on screen beside
    // it — an announcer that carried it would re-read itself every second.
    expect(announcer.textContent).toBe('Kai is working on it');
    expect(line()).toBe('Kai is working on it · 42s');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    // Three seconds of ticking on screen, nothing new said out loud.
    expect(announcer.textContent).toBe('Kai is working on it');
    expect(line()).toBe('Kai is working on it · 45s');
  });

  it('counts an agent the roster has not caught up with, without naming it', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('newcomer');

    renderLane();

    expect(line()).toBe('An agent is working on it · 42s');
  });

  it('clears presence for a stream it cannot read, rather than freezing it', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');

    renderLane({ stalled: true, onRetry: vi.fn() });

    // The rung that beats presence. A client that cannot read the stream must
    // not claim to know who is working — a frozen "· 42s" is the lie.
    expect(screen.queryByTestId('room-presence')).toBeNull();
    expect(screen.getByTestId('room-stalled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toContain("New messages aren't coming through");
  });

  it('names the thread’s announcer apart from the room’s', () => {
    renderLane({ laneScope: 'thread' });

    expect(screen.getByTestId('thread-presence-announcer')).toBeInTheDocument();
    expect(screen.queryByTestId('room-presence-announcer')).toBeNull();
  });

  it('offers one Stop for one agent, and an honest count for several', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');
    renderLane();
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

    // One agent: stopping the room and stopping the agent are the same act.
    expect(screen.getByTestId('live-peek-stop')).toHaveTextContent('Stop');
    expect(screen.queryByTestId('live-peek-stop-all')).toBeNull();

    cleanup();
    act(() => working('ana', 'working', '2026-07-30T10:00:30.000Z'));
    renderLane();
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

    // Two: no per-row stop at all, and the footer says how many it takes down.
    expect(screen.queryByTestId('live-peek-stop')).toBeNull();
    const all = screen.getByTestId('live-peek-stop-all');
    expect(all).toHaveTextContent('Stop everything in this room');
    expect(all).toHaveTextContent('Stops all 2');
  });

  it('takes the reader to the entry an agent is answering', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');
    const onScrollToRow = vi.fn();

    renderLane({ onScrollToRow });
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));
    fireEvent.click(screen.getByTestId('live-peek-replying-to'));

    expect(onScrollToRow).toHaveBeenCalledWith('trigger-kai');
  });
});
