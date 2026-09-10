/**
 * Where a room says one agent's work lives (DOR-1974).
 *
 * The join is the part worth pinning: a binding is keyed by the author ULID the
 * room minted, a caller holds a DIRECTORY, and matching the two on anything but
 * `agentRef` — a display name, say — is how a link opens the wrong agent's
 * conversation without anything looking wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  agentAuthorRef,
  type RoomSessionBinding,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { roomBoundSessionId } from '../lib/room-bound-session';
import { resolveRoomBoundSession } from '../model/use-room-bound-session';
import { roomKeys } from '../api/query-keys';

const ROOM_ID = 'room-general';
const ANA_PATH = '/work/agents/ana';
const BO_PATH = '/work/agents/bo';

/** A roster row for an agent, keyed the way the server keys one. */
function agentMember(authorId: string, agentPath: string, displayName: string) {
  return {
    roomId: ROOM_ID,
    authorId,
    responseMode: 'engaged' as const,
    joinedAt: '2026-09-01T00:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local' as const,
    author: {
      id: authorId,
      kind: 'agent' as const,
      displayName,
      agentRef: agentAuthorRef(agentPath),
      handle: displayName.toLowerCase(),
    },
  };
}

const ROOM = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'general',
  title: 'General',
  members: [
    agentMember('author-ana', ANA_PATH, 'Ana'),
    agentMember('author-bo', BO_PATH, 'Bo'),
    {
      roomId: ROOM_ID,
      authorId: 'author-dorian',
      responseMode: 'engaged' as const,
      joinedAt: '2026-09-01T00:00:00.000Z',
      joinedSeq: 0,
      lastReadSeq: 0,
      origin: 'local' as const,
      author: { id: 'author-dorian', kind: 'human' as const, displayName: 'Dorian', handle: null },
    },
  ],
  viewerAuthorId: 'author-dorian',
  reactionFrequents: [],
} as unknown as RoomWithRoster;

const BINDINGS: RoomSessionBinding[] = [
  { authorId: 'author-ana', sessionId: 'ana-in-general' },
  { authorId: 'author-bo', sessionId: 'bo-in-general' },
];

describe('roomBoundSessionId', () => {
  it('answers the session this room bound for the agent at that directory', () => {
    expect(roomBoundSessionId(ROOM, BINDINGS, ANA_PATH)).toBe('ana-in-general');
  });

  it('keeps two agents in one room apart', () => {
    // The assertion that fails if the join ever stops keying on `agentRef`:
    // taking `bindings[0]` for whoever asked would answer Ana's session here.
    expect(roomBoundSessionId(ROOM, BINDINGS, BO_PATH)).toBe('bo-in-general');
  });

  it('answers null for an agent on the roster that has never answered here', () => {
    // A room binds a session on the first TURN, not at join, so a member with no
    // binding is the ordinary state of a freshly added agent.
    expect(roomBoundSessionId(ROOM, [BINDINGS[1]!], ANA_PATH)).toBeNull();
  });

  it('answers null for an agent that is not in this room at all', () => {
    expect(roomBoundSessionId(ROOM, BINDINGS, '/work/agents/stranger')).toBeNull();
  });

  it('answers null while either read is still out', () => {
    expect(roomBoundSessionId(undefined, BINDINGS, ANA_PATH)).toBeNull();
    expect(roomBoundSessionId(ROOM, undefined, ANA_PATH)).toBeNull();
  });
});

describe('resolveRoomBoundSession', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  it('asks the server for both halves and joins them', async () => {
    const transport = createMockTransport({
      getRoom: vi.fn().mockResolvedValue(ROOM),
      listRoomSessions: vi.fn().mockResolvedValue({ bindings: BINDINGS }),
    });

    await expect(
      resolveRoomBoundSession({ queryClient, transport }, ROOM_ID, ANA_PATH)
    ).resolves.toBe('ana-in-general');
    expect(transport.listRoomSessions).toHaveBeenCalledWith(ROOM_ID);
  });

  it('reads a cached answer without asking again', async () => {
    queryClient.setQueryData(roomKeys.detail(ROOM_ID), ROOM);
    queryClient.setQueryData(roomKeys.sessions(ROOM_ID), { bindings: BINDINGS });
    const transport = createMockTransport({
      getRoom: vi.fn(),
      listRoomSessions: vi.fn(),
    });

    await expect(
      resolveRoomBoundSession({ queryClient, transport }, ROOM_ID, BO_PATH)
    ).resolves.toBe('bo-in-general');
    expect(transport.getRoom).not.toHaveBeenCalled();
    expect(transport.listRoomSessions).not.toHaveBeenCalled();
  });

  it('answers null rather than throwing when the room refuses the read', async () => {
    // `GET /rooms/:id/sessions` answers 403 for an agent caller and 404 for a
    // room the caller cannot see. Neither is worth interrupting anybody over —
    // the caller still has a working destination — so this must not reject.
    const transport = createMockTransport({
      getRoom: vi.fn().mockResolvedValue(ROOM),
      listRoomSessions: vi.fn().mockRejectedValue(new Error('Only a person can see that.')),
      reportError: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      resolveRoomBoundSession({ queryClient, transport }, ROOM_ID, ANA_PATH)
    ).resolves.toBeNull();
    expect(transport.reportError).toHaveBeenCalled();
  });
});
