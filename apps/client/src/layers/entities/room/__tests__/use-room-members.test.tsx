// @vitest-environment jsdom
/**
 * What the roster cache holds while a mode change is in flight, and what it
 * holds once one has failed.
 *
 * Asserted at the cache rather than through a component, because the whole
 * behaviour IS the cache: the control reads it, so what it says is whatever is
 * in there. Through the REAL `createQueryClientConfig`, so the invalidation
 * policy under test is the one the app runs.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast as mockToast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  REACTION_FREQUENTS_DEFAULT,
  type RoomRosterEntry,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import { roomKeys } from '../api/query-keys';
import {
  useAddRoomMember,
  useRemoveRoomMember,
  useSetMemberResponseMode,
} from '../model/use-room-members';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ROOM_ID = 'room-1';

function member(authorId: string, responseMode: RoomRosterEntry['responseMode']): RoomRosterEntry {
  return {
    roomId: ROOM_ID,
    authorId,
    responseMode,
    joinedAt: '2026-07-26T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author: {
      id: authorId,
      kind: 'agent',
      displayName: authorId,
      handle: null,
      agentRef: `ref-${authorId}`,
    },
    origin: 'local',
  };
}

const ROSTER: RoomWithRoster = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'general',
  title: 'General',
  topic: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-26T10:00:00.000Z',
  lastActivityAt: '2026-07-26T10:00:00.000Z',
  members: [member('ana', 'mention-only'), member('bo', 'silent')],
  viewerAuthorId: 'me',
  reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
};

/**
 * A client holding the roster the sheet would have read, with the room's
 * history beside it — the neighbour a `roomKeys.all` invalidation would sweep
 * up, and the reason these hooks never use it.
 */
function seededClient(): QueryClient {
  const client = new QueryClient(createQueryClientConfig());
  client.setQueryData(roomKeys.detail(ROOM_ID), ROSTER);
  client.setQueryData(roomKeys.entries(ROOM_ID), []);
  // Seeded too, purely so `getQueryState(roomKeys.lists())` has a query to
  // report on below — `invalidateQueries` marks nothing observable on a key
  // that was never asked for.
  client.setQueryData(roomKeys.lists(), []);
  return client;
}

function wrapperFor(transport: Transport, client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** The mode the cache currently says one member holds. */
function cachedMode(client: QueryClient, authorId: string): string | undefined {
  return client
    .getQueryData<RoomWithRoster>(roomKeys.detail(ROOM_ID))
    ?.members.find((entry) => entry.authorId === authorId)?.responseMode;
}

afterEach(cleanup);
afterEach(() => vi.clearAllMocks());

describe('useSetMemberResponseMode', () => {
  it('moves the member to the new mode before the server has answered', async () => {
    // The control is a meter that moves, so a value arriving a round trip late
    // reads as a control that did not respond. Red the moment `onMutate` goes:
    // this write never settles, so nothing else can put the value there.
    const client = seededClient();
    const transport = createMockTransport({
      updateRoomMember: vi.fn().mockReturnValue(new Promise<never>(() => {})),
    });
    const { result } = renderHook(() => useSetMemberResponseMode(), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'ana', responseMode: 'always' });

    await waitFor(() => expect(cachedMode(client, 'ana')).toBe('always'));
    // The optimistic write is a patch, not a replacement: everyone else on the
    // roster is left exactly where they were.
    expect(cachedMode(client, 'bo')).toBe('silent');
  });

  it('puts the true mode back when the server refuses', async () => {
    // The refetch must NOT be what restores it — that would make this green
    // with the rollback deleted. So the room is readable exactly once, and the
    // read `onSettled` fires never lands: the only thing that can undo the
    // optimistic write is `onError`.
    const client = seededClient();
    const transport = createMockTransport({
      updateRoomMember: vi.fn().mockRejectedValue(new Error('Only you can change that')),
      getRoom: vi.fn().mockReturnValue(new Promise<never>(() => {})),
    });
    const { result } = renderHook(() => useSetMemberResponseMode(), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'ana', responseMode: 'always' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => expect(cachedMode(client, 'ana')).toBe('mention-only'));
  });

  it('leaves a second member alone when the first one is rolled back', async () => {
    // The rollback restores ONE member's mode rather than a snapshot of the
    // whole room. Red if it goes back to `setQueryData(previousRoom)`: Bo's
    // change, written after the snapshot was taken, would be taken back with
    // Ana's failure and the reader would watch a setting they never touched
    // move on its own.
    const client = seededClient();
    // Ana's refusal is held back deliberately: it has to arrive AFTER Bo's
    // optimistic write, which is the ordering the bug needs. Rejecting straight
    // away would roll Ana back before Bo ever wrote, and the test would prove
    // nothing about the two together.
    let refuseAna!: (reason: Error) => void;
    const transport = createMockTransport({
      updateRoomMember: vi.fn().mockImplementation((_roomId: string, authorId: string) =>
        authorId === 'ana'
          ? new Promise<never>((_resolve, reject) => {
              refuseAna = reject;
            })
          : new Promise<never>(() => {})
      ),
      getRoom: vi.fn().mockReturnValue(new Promise<never>(() => {})),
    });
    const { result } = renderHook(() => useSetMemberResponseMode(), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'ana', responseMode: 'always' });
    await waitFor(() => expect(cachedMode(client, 'ana')).toBe('always'));
    result.current.mutate({ roomId: ROOM_ID, authorId: 'bo', responseMode: 'engaged' });
    await waitFor(() => expect(cachedMode(client, 'bo')).toBe('engaged'));

    refuseAna(new Error('nope'));

    await waitFor(() => expect(cachedMode(client, 'ana')).toBe('mention-only'));
    expect(cachedMode(client, 'bo')).toBe('engaged');
  });

  it('never invalidates the room’s history along with its roster', async () => {
    // `roomKeys.all` prefix-matches `['rooms','entries',id]`, so invalidating it
    // would put the open room's history back on the wire and let a GET that
    // predates a streamed entry land on top of it. Red if either of the two
    // invalidations here is widened to the root key.
    const client = seededClient();
    const transport = createMockTransport({
      updateRoomMember: vi.fn().mockResolvedValue(member('ana', 'always')),
      getRoom: vi.fn().mockResolvedValue(ROSTER),
    });
    const { result } = renderHook(() => useSetMemberResponseMode(), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'ana', responseMode: 'always' });

    await waitFor(() =>
      expect(client.getQueryState(roomKeys.detail(ROOM_ID))?.isInvalidated).toBe(true)
    );
    expect(client.getQueryState(roomKeys.entries(ROOM_ID))?.isInvalidated).toBe(false);
  });
});

describe('useRemoveRoomMember', () => {
  it('takes the default label when the caller names none — for removing an agent', async () => {
    const client = seededClient();
    const transport = createMockTransport({
      removeRoomMember: vi
        .fn()
        .mockRejectedValue(new Error('Only you can change who is in a room')),
    });
    const { result } = renderHook(() => useRemoveRoomMember(), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'ana' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToast.error).toHaveBeenCalledWith(
      "Couldn't remove that agent",
      expect.objectContaining({ description: 'Only you can change who is in a room' })
    );
  });

  it('leaves a room — same wire route as removing a member, naming the caller as the target', async () => {
    // "Leaving" is not a second mutation: `DELETE /:id/members/:authorId`
    // neither knows nor cares whether the target is an agent or the caller's
    // own id. Only the `errorLabel` a caller passes differs (DOR-1233).
    const client = seededClient();
    const transport = createMockTransport({
      removeRoomMember: vi.fn().mockResolvedValue(undefined),
    });
    const { result } = renderHook(() => useRemoveRoomMember({ errorLabel: "Couldn't leave" }), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'me' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.removeRoomMember).toHaveBeenCalledWith(ROOM_ID, 'me');
  });

  it('refreshes the room list and the room detail on success, never the history', async () => {
    const client = seededClient();
    const transport = createMockTransport({
      removeRoomMember: vi.fn().mockResolvedValue(undefined),
    });
    const { result } = renderHook(() => useRemoveRoomMember({ errorLabel: "Couldn't leave" }), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'me' });

    await waitFor(() =>
      expect(client.getQueryState(roomKeys.detail(ROOM_ID))?.isInvalidated).toBe(true)
    );
    expect(client.getQueryState(roomKeys.lists())?.isInvalidated).toBe(true);
    expect(client.getQueryState(roomKeys.entries(ROOM_ID))?.isInvalidated).toBe(false);
  });

  it('shows the server’s own reason a leave was refused, not a generic failure', async () => {
    // Through the REAL mutation cache (`createQueryClientConfig`), which is
    // what actually composes the caller's `errorLabel` with the server's
    // sentence — proof this reads the wire message, not an assumption that
    // it would.
    const client = seededClient();
    const transport = createMockTransport({
      removeRoomMember: vi
        .fn()
        .mockRejectedValue(
          new Error('Two agents share this room — take one of them out before you leave it')
        ),
    });
    const { result } = renderHook(() => useRemoveRoomMember({ errorLabel: "Couldn't leave" }), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'me' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToast.error).toHaveBeenCalledWith(
      "Couldn't leave",
      expect.objectContaining({
        description: 'Two agents share this room — take one of them out before you leave it',
      })
    );
  });

  it('shows #team’s own refusal too — leaving a system room, not just a two-agent one', async () => {
    const client = seededClient();
    const transport = createMockTransport({
      removeRoomMember: vi
        .fn()
        .mockRejectedValue(new Error("You can't leave #team — it's your home channel")),
    });
    const { result } = renderHook(() => useRemoveRoomMember({ errorLabel: "Couldn't leave" }), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'me' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToast.error).toHaveBeenCalledWith(
      "Couldn't leave",
      expect.objectContaining({ description: "You can't leave #team — it's your home channel" })
    );
  });
});

describe('useAddRoomMember', () => {
  it('adds a person by their own author id — the wire call Undo and Join both make', async () => {
    // `AddRoomMemberRequestSchema` and `RoomService.addMember` never
    // restricted this to agents; only this hook's input type used to
    // (DOR-1233 follow-up).
    const client = seededClient();
    const transport = createMockTransport({
      addRoomMember: vi.fn().mockResolvedValue(member('me', 'silent')),
    });
    const { result } = renderHook(() => useAddRoomMember(), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, authorId: 'me' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.addRoomMember).toHaveBeenCalledWith(ROOM_ID, { authorId: 'me' });
  });

  it('still adds an agent by its directory, unaffected by the authorId path existing', async () => {
    const client = seededClient();
    const transport = createMockTransport({
      addRoomMember: vi.fn().mockResolvedValue(member('ana', 'engaged')),
    });
    const { result } = renderHook(() => useAddRoomMember(), {
      wrapper: wrapperFor(transport, client),
    });

    result.current.mutate({ roomId: ROOM_ID, agentPath: '/repo/ana' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.addRoomMember).toHaveBeenCalledWith(ROOM_ID, { agentPath: '/repo/ana' });
  });
});
