// @vitest-environment jsdom
/** The room's live lane, driven by the real presence store. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoomEntry, RoomRosterEntry, RoomSignalEvent } from '@dorkos/shared/room-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { RoomLiveLane } from '../ui/RoomLiveLane';

const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigateSpy,
}));

// The fleet reads behind the faces are not what this suite is about, and an unresolved mesh is a
// state the room already handles by falling back to the roster — which is exactly what the names
// below come from.
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

/** Put one live claim in the store, the way the stream would. */
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

/** Put one waiting message in the store, the way the stream would. */
function waiting(
  authorId: string,
  behindRoomId: string | null = 'room-elsewhere',
  since = STARTED,
  othersWaiting = false
): void {
  const event: RoomSignalEvent = {
    type: 'signal',
    signal: 'progress',
    authorId,
    at: since,
    state: 'held',
    entryId: `trigger-${authorId}`,
    since,
    ...(behindRoomId === null ? {} : { heldBehind: { roomId: behindRoomId, othersWaiting } }),
  };
  useRoomPresenceStore.getState().observe(ROOM, event);
}

/** Release a claim through the store, exactly as `releaseClaim` would. */
function released(
  authorId: string,
  outcome?: 'answered' | 'silent',
  entryId = `trigger-${authorId}`,
  since = STARTED
): void {
  const event: RoomSignalEvent = {
    type: 'signal',
    signal: 'progress',
    authorId,
    at: since,
    state: 'done',
    entryId,
    since,
    ...(outcome ? { outcome } : {}),
  };
  useRoomPresenceStore.getState().observe(ROOM, event);
}

/** The line's text, with the separators normalised to single spaces. */
function line(): string {
  return screen.getByTestId('room-presence').textContent!.replace(/\s+/gu, ' ').trim();
}

/** Mount the lane with everything a room hands it. */
/** Where the lane asked to be taken, as the host would hear it. */
const scrollToRowSpy = vi.fn();

function renderLane(
  props: Partial<Parameters<typeof RoomLiveLane>[0]> = {},
  transport = createMockTransport()
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <EventStreamProvider>
      <TransportProvider transport={transport}>
        <QueryClientProvider client={client}>
          <RoomLiveLane
            room={ROOM_WITH_ROSTER}
            entries={ENTRIES}
            laneScope="room"
            stalled={false}
            // The host's, as both real hosts wire it: `Conversation.Timeline`'s own handle,
            // because a row may not be in the document at all — only the virtualized list can
            // scroll one into being.
            onScrollToRow={scrollToRowSpy}
            {...props}
          />
        </QueryClientProvider>
      </TransportProvider>
    </EventStreamProvider>
  );
}

beforeEach(() => {
  navigateSpy.mockClear();
  scrollToRowSpy.mockClear();
  useRoomPresenceStore.getState().reset();
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

    // No sentence, no placeholder — but the lane itself is mounted and 24px tall, which is the
    // whole reason nothing moves when a claim arrives.
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

    // Each on its own clock, not the aggregate's — Rae started thirty seconds after Kai and the
    // peek has to say so.
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

  it('counts up on its own, with nothing arriving — and not before ten seconds', async () => {
    working('kai');

    renderLane();
    // No number yet. A timer that starts at `0s` draws the eye for nothing, so
    // the lane waits ten seconds before it puts one up (design record).
    expect(line()).toBe('Kai is working on it');

    // Two steps: the leaf sleeps until its number is DUE rather than ticking through the silence,
    // so the first wake is what starts the per-second timer and the second advance is what the
    // timer answers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(line()).toBe('Kai is working on it · 10s');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(line()).toBe('Kai is working on it · 12s');
  });

  it('announces the sentence, and never the number that ticks', async () => {
    // The announcer is mounted before anything is working, so the sentence lands as a CHANGE to a
    // region assistive technology is already watching — a live region that appears with its text
    // already in it is the case that goes unannounced.
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

  it('clears presence for a stream it cannot read, rather than freezing it', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');

    renderLane({ stalled: true, onRetry: vi.fn() });

    // The rung that beats presence. A client that cannot read the stream must
    // not claim to know who is working — a frozen "· 42s" is the lie.
    expect(screen.queryByTestId('room-presence')).toBeNull();
    expect(screen.getByTestId('room-stalled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toContain('New messages aren’t arriving');
  });

  it('offers a Stop per agent, and an honest count in the footer for several', () => {
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');
    renderLane();
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

    // One agent: its own Stop, and no footer — there is nothing else to stop.
    expect(screen.getByTestId('live-peek-stop')).toHaveTextContent('Stop');
    expect(screen.queryByTestId('live-peek-stop-all')).toBeNull();

    cleanup();
    act(() => working('ana', 'working', '2026-07-30T10:00:30.000Z'));
    renderLane();
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

    // Two: a Stop on each row, each naming its own agent, and the footer for
    // the "and everything else" case with the count that keeps it honest.
    expect(screen.getAllByTestId('live-peek-stop')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Stop Kai' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop Ana' })).toBeInTheDocument();
    const all = screen.getByTestId('live-peek-stop-all');
    expect(all).toHaveTextContent('Stop everything in this room');
    expect(all).toHaveTextContent('Stops all 2');
  });

  it('sends a row’s Stop to that agent, and the footer’s to the whole room', async () => {
    // **The single most likely wiring mistake here**: both controls reaching one mutation.
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');
    act(() => working('ana', 'working', '2026-07-30T10:00:30.000Z'));
    const transport = createMockTransport();
    renderLane({}, transport);
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

    fireEvent.click(screen.getByRole('button', { name: 'Stop Ana' }));
    await act(async () => {
      await Promise.resolve();
    });

    // Ana's row, Ana's id — not Kai's, which a `.map` closing over the wrong row
    // makes easy and no snapshot would catch.
    expect(transport.haltRoomAgent).toHaveBeenCalledWith(ROOM, 'ana');
    expect(transport.haltRoom).not.toHaveBeenCalled();
    // And only Ana's button says a stop is on its way.
    expect(screen.getByRole('button', { name: 'Stop Kai' })).toBeEnabled();

    fireEvent.click(screen.getByTestId('live-peek-stop-all'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(transport.haltRoom).toHaveBeenCalledWith(ROOM);
    expect(transport.haltRoomAgent).toHaveBeenCalledTimes(1);
  });

  it('takes the reader to the row an agent’s trigger is drawn on', () => {
    // The room's flow draws top-level entries, so a claim on one gets the flow's
    // own row id.
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');

    renderLane();
    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));
    fireEvent.click(screen.getByTestId('live-peek-replying-to'));

    expect(scrollToRowSpy).toHaveBeenCalledWith('room-entry-trigger-kai');
  });

  it('offers the session an agent’s work runs in, and asks for it only on open', async () => {
    // The client half of the one server change this phase made (`GET /api/rooms/:id/sessions`,
    // whose own answers are pinned in `rooms-sessions.test.ts`).
    vi.useRealTimers();
    working('kai');
    const transport = createMockTransport();
    transport.listRoomSessions = vi
      .fn()
      .mockResolvedValue({ bindings: [{ authorId: 'kai', sessionId: 'session-kai' }] });

    renderLane({}, transport);
    expect(transport.listRoomSessions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

    fireEvent.click(await screen.findByTestId('live-peek-open-session'));
    expect(transport.listRoomSessions).toHaveBeenCalledWith(ROOM);
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'session-kai' },
    });
  });

  it('hands the caret back when the peek closes out from under it', () => {
    // Radix returns focus to a trigger it CLOSED; it has nothing to return to when the trigger is
    // removed, so the browser drops the caret on `document.body` and Tab restarts at the top of
    // the page.
    vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
    working('kai');

    renderLane();
    const trigger = screen.getByRole('button', { name: 'Show who is working' });
    trigger.focus();
    fireEvent.click(trigger);

    act(() => useRoomPresenceStore.getState().clearAuthor(ROOM, 'kai'));

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(document.querySelector('[data-slot="live-lane"]'));
  });

  it('draws only THIS room’s prompt, never one raised in another room', async () => {
    // The `roomId` filter is the whole reason the event carries a room.
    const transport = createMockTransport();
    vi.mocked(transport.listPendingInteractions).mockResolvedValue({
      interactions: [
        {
          sessionId: 'session-elsewhere',
          cwd: '/projects/elsewhere',
          roomId: 'some-other-room',
          interaction: {
            type: 'approval',
            id: 'tc-elsewhere',
            startedAt: Date.parse(STARTED),
            remainingMs: 600_000,
            timeoutMs: 600_000,
            toolName: 'Edit',
            displayName: 'Edit elsewhere.md',
            input: '{}',
            hasSuggestions: false,
          },
        },
        {
          sessionId: 'session-here',
          cwd: '/projects/here',
          roomId: ROOM,
          roomAuthorId: 'kai',
          interaction: {
            type: 'approval',
            id: 'tc-here',
            startedAt: Date.parse(STARTED),
            remainingMs: 600_000,
            timeoutMs: 600_000,
            toolName: 'Edit',
            displayName: 'Edit here.md',
            input: '{}',
            hasSuggestions: false,
          },
        },
      ],
    });

    renderLane({}, transport);
    // This suite runs on fake timers, so the query is flushed by hand rather
    // than by a poller that would never tick.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const lane = screen.getByTestId('lane-ask');
    expect(lane.textContent).toContain('here.md');
    expect(lane.textContent).not.toContain('elsewhere.md');
    // And it is named from the room's own roster, not from a directory.
    expect(lane.textContent).toContain('Kai');
  });

  describe('a message waiting on an agent working elsewhere', () => {
    /** Let the room-list query resolve, without running the clock forward. */
    async function settleRoomList(): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
    }

    /** A transport whose room list this reader CAN see the other room in. */
    function seeingTransport() {
      const transport = createMockTransport();
      transport.listRooms = vi.fn().mockResolvedValue([
        { id: ROOM, kind: 'channel', slug: 'deploys', title: 'Deploys' },
        { id: 'room-elsewhere', kind: 'channel', slug: 'mio-engagement', title: 'Mio Engagement' },
      ]);
      return transport;
    }

    it('says who will pick it up and where, when this reader can see that room', async () => {
      waiting('kai');
      renderLane({}, seeingTransport());
      await settleRoomList();

      expect(screen.getByTestId('room-held').textContent).toContain(
        'Kai will pick this up when it finishes in #mio-engagement'
      );
      // And it is NOT the working line: nothing is running here.
      expect(screen.queryByTestId('room-presence')).toBeNull();
    });

    it('puts the wait under the working rows in the peek, and both can be stopped', () => {
      vi.setSystemTime(new Date('2026-07-30T10:00:42.000Z'));
      working('ana');
      waiting('kai');
      renderLane();
      fireEvent.click(screen.getByRole('button', { name: 'Show who is working' }));

      const rows = screen.getAllByTestId('live-peek-row');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('Ana');
      expect(rows[1].textContent).toContain('Kai');
      expect(rows[1].textContent).toContain('waiting to start');

      // **Every row can be stopped, held ones included** — this sentence used to read "Stop
      // counts working rows only", and `specs/room-per-agent-stop` §5.2 amends it: a row's Stop
      // is `haltAgent` now, so pressing it on the wait stops this conversation waiting for Kai
      // and touches nothing Ana is doing.
      expect(screen.getAllByTestId('live-peek-stop')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Stop Ana' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop Kai' })).toBeInTheDocument();
      expect(screen.getByTestId('live-peek-stop-all')).toHaveTextContent('Stops all 2');
    });
  });

  describe('a turn that released with nothing to show (D7)', () => {
    it('draws nothing at all for a release with no `outcome` — the regression that matters', () => {
      // A server that predates D7 sends exactly this frame today, and this is
      // the whole promise: absent renders exactly what it always has.
      working('kai');
      renderLane();

      act(() => released('kai'));

      expect(screen.queryByTestId('room-presence')).toBeNull();
      expect(screen.queryByTestId('lane-silent-finish')).toBeNull();
      // Nothing to say and the lane looks like it — mounted, empty, 24px.
      expect(document.querySelector('[data-slot="live-lane"]')).toHaveClass('h-6');
    });
  });
});
