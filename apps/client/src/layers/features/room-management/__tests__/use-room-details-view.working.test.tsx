// @vitest-environment jsdom
/**
 * Telling "nobody is working here" apart from "nothing is telling me" (DOR-786).
 *
 * Presence rides each room's own SSE stream, and only the room ON SCREEN has one
 * open — so the sheet opened from a sidebar row over some other room heard
 * nothing and drew nothing, which is exactly what a quiet room looks like. A
 * person reading it could not tell the two apart, and neither could the sheet.
 *
 * The room read now carries `workingAgents`, the server's own live read of the
 * claim map. These tests pin the three states that follow from it and the
 * precedence between the two sources.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomPresenceStore, PRESENCE_TTL_MS } from '@/layers/entities/room';
import { useRoomDetailsView } from '../model/use-room-details-view';

const ROOM_ID = '01JZROOM';
const ANA = '01JZANA';
const WHEN = '2026-08-22T12:00:00.000Z';

afterEach(() => {
  cleanup();
  useRoomPresenceStore.getState().reset();
  vi.restoreAllMocks();
});

/** A room read, with whatever the server said about who is working. */
function room(workingAgents?: RoomWithRoster['workingAgents']): RoomWithRoster {
  return {
    id: ROOM_ID,
    kind: 'channel',
    slug: 'backend',
    title: '#backend',
    topic: null,
    archived: false,
    ambientMaxEntries: 40,
    createdAt: WHEN,
    lastActivityAt: WHEN,
    bridge: null,
    members: [],
    viewerAuthorId: '01JZHUMAN',
    reactionFrequents: ['👍', '🎉', '👀'],
    ...(workingAgents === undefined ? {} : { workingAgents }),
  };
}

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Render the sheet's view over one room read. */
function render(getRoom: () => Promise<RoomWithRoster>) {
  const transport = createMockTransport({
    getRoom: vi.fn(getRoom),
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
  });
  return renderHook(() => useRoomDetailsView(ROOM_ID, true), { wrapper: wrapperFor(transport) });
}

describe('what the room sheet can say about who is working', () => {
  it('cannot say anything until the room read lands', async () => {
    const { result } = render(() => new Promise<RoomWithRoster>(() => {}));

    // The state a sheet spends its first frames in, and the one it used to be
    // indistinguishable from a quiet room. Nothing may draw "nobody is working"
    // off this.
    expect(result.current.workingKnown).toBe(false);
    expect(result.current.working).toEqual([]);
  });

  it('says nobody is working once the room has answered with an empty list', async () => {
    const { result } = render(async () => room([]));

    await waitFor(() => expect(result.current.workingKnown).toBe(true));
    // Now — and only now — an empty list is a claim about the ROOM. `[]` from
    // the server is an answer; the absence above was not.
    expect(result.current.working).toEqual([]);
  });

  it('draws the working rows the room read carried, with no stream open', async () => {
    const { result } = render(async () => room([{ authorId: ANA, since: WHEN }]));

    await waitFor(() => expect(result.current.working).toHaveLength(1));
    expect(result.current.working[0].authorId).toBe(ANA);
    expect(result.current.working[0].since).toBe(WHEN);
    // Never `working_late`: whether the room has stopped WAITING is a judgement
    // the dispatcher publishes and the claim map does not record.
    expect(result.current.working[0].state).toBe('working');
    expect(result.current.workingKnown).toBe(true);
  });

  it('cannot say anything against a server that does not send the field', async () => {
    const { result } = render(async () => room(undefined));

    await waitFor(() => expect(result.current.room).not.toBeNull());
    // The room landed and still says nothing about presence. Reading that as
    // "nobody" would be reading an old server's silence as a fact.
    expect(result.current.workingKnown).toBe(false);
    expect(result.current.working).toEqual([]);
  });

  it('lets the live stream override the snapshot the room read carried', async () => {
    const { result } = render(async () => room([{ authorId: ANA, since: WHEN }]));
    await waitFor(() => expect(result.current.working).toHaveLength(1));

    // The stream is now; the snapshot is whenever it was fetched. A second agent
    // starting work has to show up without re-reading the room.
    act(() => {
      useRoomPresenceStore.getState().observe(ROOM_ID, {
        type: 'signal',
        signal: 'progress',
        authorId: '01JZBO',
        at: WHEN,
        state: 'working',
        entryId: '01JZENTRY',
        since: WHEN,
      });
    });

    expect(result.current.working.map((agent) => agent.authorId)).toEqual(['01JZBO']);
  });

  describe('when the stream says an agent finished but never said it started', () => {
    // **The gap this whole fallback has to survive** (DOR-786 review). Signals
    // never replay and the dispatcher republishes only every ten seconds, so a
    // sheet opened mid-turn routinely never sees the `working` frame. The room
    // read DOES carry the claim. When the turn then ends, the release lands on a
    // store holding no matching key and — before this fix — was a silent no-op:
    // `live` stayed empty, the snapshot was still inside its window, and the
    // sheet went on showing the agent as working underneath the reply already on
    // screen. That is a false positive contradicting the visible transcript,
    // which is strictly worse than the under-reporting it replaced.

    /**
     * Comfortably after the room read landed.
     *
     * The rule is `finished > fetchedAt`, and both clocks are this client's, so
     * a release stamped in the same millisecond as the read would legitimately
     * lose. Tests must not sit on that boundary.
     */
    const afterTheRead = () => Date.now() + 5_000;

    it('drops the snapshot row when a done arrives for a claim it never saw', async () => {
      const { result } = render(async () => room([{ authorId: ANA, since: WHEN }]));
      await waitFor(() => expect(result.current.working).toHaveLength(1));
      // Precondition: the store is empty, so this is genuinely the unseen-start
      // case rather than an ordinary retire.
      expect(useRoomPresenceStore.getState().rooms[ROOM_ID]).toBeUndefined();

      act(() => {
        useRoomPresenceStore.getState().observe(
          ROOM_ID,
          {
            type: 'signal',
            signal: 'progress',
            authorId: ANA,
            at: WHEN,
            state: 'done',
            entryId: '01JZENTRY',
            since: WHEN,
          },
          afterTheRead()
        );
      });

      expect(result.current.working).toEqual([]);
      // Still an ANSWER: the stream told us it finished, which is knowledge
      // rather than absence, so the sheet may say nobody is working.
      expect(result.current.workingKnown).toBe(true);
    });

    it('drops the snapshot row when that agent own entry lands', async () => {
      // The other evidence path, and the commoner one: the reply itself. It
      // routes through `clearAuthor`, which had the same silent no-op.
      const { result } = render(async () => room([{ authorId: ANA, since: WHEN }]));
      await waitFor(() => expect(result.current.working).toHaveLength(1));

      act(() => {
        useRoomPresenceStore.getState().clearAuthor(ROOM_ID, ANA, afterTheRead());
      });

      expect(result.current.working).toEqual([]);
      expect(result.current.workingKnown).toBe(true);
    });

    it('keeps the other agents the snapshot listed', async () => {
      // The suppression is per author, not per room: one agent finishing says
      // nothing about the one still working beside it.
      const { result } = render(async () =>
        room([
          { authorId: ANA, since: WHEN },
          { authorId: '01JZBO', since: WHEN },
        ])
      );
      await waitFor(() => expect(result.current.working).toHaveLength(2));

      act(() => {
        useRoomPresenceStore.getState().clearAuthor(ROOM_ID, ANA, afterTheRead());
      });

      expect(result.current.working.map((agent) => agent.authorId)).toEqual(['01JZBO']);
    });

    it('does NOT suppress a row for a finish that predates the room read', async () => {
      // The guard that keeps this from becoming its own lie. An agent that
      // finished and was then claimed AGAIN is working, and the room read — taken
      // after that finish — is what says so. Suppressing on any finish ever seen
      // would hide a live turn.
      const before = Date.now() - 5_000;
      const { result } = render(async () => room([{ authorId: ANA, since: WHEN }]));
      await waitFor(() => expect(result.current.working).toHaveLength(1));

      act(() => {
        useRoomPresenceStore.getState().clearAuthor(ROOM_ID, ANA, before);
      });

      expect(result.current.working.map((agent) => agent.authorId)).toEqual([ANA]);
    });

    it('forgets its finishes when the room stream is lost', async () => {
      // A stream this client cannot read is presence it must not claim to know,
      // and that cuts both ways: a stale finish would go on suppressing a room
      // read long after this client stopped being able to hear a restart.
      const { result } = render(async () => room([{ authorId: ANA, since: WHEN }]));
      await waitFor(() => expect(result.current.working).toHaveLength(1));

      act(() => {
        useRoomPresenceStore.getState().clearAuthor(ROOM_ID, ANA, afterTheRead());
      });
      expect(result.current.working).toEqual([]);

      act(() => useRoomPresenceStore.getState().clearRoom(ROOM_ID));
      expect(useRoomPresenceStore.getState().finished[ROOM_ID]).toBeUndefined();
    });
  });

  it('stops claiming ANYTHING once the snapshot has aged past the presence window', async () => {
    const { result, rerender } = render(async () => room([{ authorId: ANA, since: WHEN }]));
    await waitFor(() => expect(result.current.working).toHaveLength(1));

    // A sheet left open on a room this client cannot hear must stop claiming a
    // turn that may have ended minutes ago — the same bound every other presence
    // reader uses, measured from when the read landed. The clock is moved rather
    // than faked wholesale, because the hook reads it at render and the test
    // still needs React's own timers to run.
    const later = Date.now() + PRESENCE_TTL_MS + 1_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    rerender();

    expect(result.current.working).toEqual([]);
    // **And the VERDICT ages out with the rows.** This is the assertion that
    // changed: dropping the rows while still reporting `workingKnown` would turn
    // a half-minute-old snapshot into a confident "nobody is working here" — a
    // worse lie than the silence this whole field replaced, and reachable because
    // `useRoom` does not refetch a sheet somebody is already looking at.
    expect(result.current.workingKnown).toBe(false);
    clock.mockRestore();
  });

  it('answers from the stream even when the room read says nothing at all', async () => {
    // The snapshot's age bound is a bound on the SNAPSHOT, never on the answer.
    // A client hearing the room's own stream knows who is working whatever the
    // room body did or did not carry — including against a server too old to
    // send the field — and must not be dragged down to "cannot say" by it.
    const { result } = render(async () => room(undefined));
    await waitFor(() => expect(result.current.room).not.toBeNull());
    expect(result.current.workingKnown).toBe(false);

    act(() => {
      useRoomPresenceStore.getState().observe(ROOM_ID, {
        type: 'signal',
        signal: 'progress',
        authorId: ANA,
        at: WHEN,
        state: 'working',
        entryId: '01JZENTRY',
        since: new Date().toISOString(),
      });
    });

    expect(result.current.working.map((agent) => agent.authorId)).toEqual([ANA]);
    expect(result.current.workingKnown).toBe(true);
  });
});
