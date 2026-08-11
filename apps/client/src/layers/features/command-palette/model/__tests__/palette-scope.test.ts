import { describe, it, expect } from 'vitest';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import {
  roomIdsByOriginLabel,
  roomOriginLabel,
  scopeEmptyMessage,
  scopeHeading,
  scopeKey,
  scopeLabel,
  scopesOfSession,
  type PaletteScope,
} from '../palette-scope';

const agent: AgentPathEntry = {
  id: 'agent-orbit',
  name: 'orbit',
  displayName: 'Orbit',
  projectPath: '/projects/orbit',
};

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-shipping',
    kind: 'channel',
    slug: 'shipping',
    title: 'Shipping',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-01T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const agentScope: PaletteScope = { kind: 'agent', agent };
const roomScope: PaletteScope = { kind: 'room', room: makeRoom() };
const dmScope: PaletteScope = {
  kind: 'room',
  room: makeRoom({ kind: 'dm', slug: null, title: 'Ana' }),
};

describe('what a scope is called', () => {
  it('keys an agent by its directory, which is what a conversation carries', () => {
    // The mesh id would key nothing: a session knows its `cwd`, never an id.
    expect(scopeKey(agentScope)).toBe('agent:/projects/orbit');
  });

  it('keys a room by its id', () => {
    expect(scopeKey(roomScope)).toBe('room:room-shipping');
  });

  it('says the subject and nothing else — no prefix, no type word', () => {
    expect(scopeLabel(agentScope)).toBe('Orbit');
    expect(scopeLabel(roomScope)).toBe('#shipping');
    expect(scopeLabel(dmScope)).toBe('Ana');
  });

  it('heads a scoped list with the relation, which is different for each kind', () => {
    expect(scopeHeading(agentScope)).toBe('Conversations with Orbit');
    expect(scopeHeading(roomScope)).toBe('Conversations in #shipping');
  });

  it('says why an empty scope is empty, in the subject’s own terms', () => {
    expect(scopeEmptyMessage(agentScope)).toBe('No conversations with Orbit yet.');
    expect(scopeEmptyMessage(roomScope)).toBe('No conversations came from #shipping.');
  });
});

describe('roomOriginLabel mirrors what the server stamps', () => {
  it('names a channel by its slug, with the hash', () => {
    expect(roomOriginLabel(makeRoom())).toBe('#shipping');
  });

  it('names a direct message by its title', () => {
    expect(roomOriginLabel(makeRoom({ kind: 'dm', slug: null, title: 'Ana' }))).toBe('Ana');
  });

  it('falls back to the title for a channel with no slug', () => {
    // `RoomStore.resolveRoomOrigins` has the same guard, and the two have to
    // agree or the join silently finds nothing.
    expect(roomOriginLabel(makeRoom({ slug: null }))).toBe('Shipping');
  });
});

describe('roomIdsByOriginLabel picks one room per label, deterministically', () => {
  it('keys each room by the label the server would stamp', () => {
    const map = roomIdsByOriginLabel([
      makeRoom(),
      makeRoom({ id: 'room-ana', kind: 'dm', slug: null, title: 'Ana' }),
    ]);
    expect([...map]).toEqual([
      ['#shipping', 'room-shipping'],
      ['Ana', 'room-ana'],
    ]);
  });

  it('gives a live channel the label over an archived one with the same slug', () => {
    // `rooms_channel_slug_unique` is PARTIAL (`archived = 0`), so both of these
    // are legal at once and both are in the palette (archived rooms are
    // findable, DOR-1051).
    //
    // Seeded ARCHIVED-first on purpose: the map is first-write-wins, so plain
    // iteration would hand the label to the archived room — only the
    // precedence sort can produce this answer.
    const map = roomIdsByOriginLabel([
      makeRoom({ id: 'room-shipping-old', archived: true }),
      makeRoom({ id: 'room-shipping-live' }),
    ]);
    expect(map.get('#shipping')).toBe('room-shipping-live');
  });

  it('never lets a direct message take a channel’s label', () => {
    // Nothing stops a DM being titled `#general`. Seeded DM-first, for the
    // same reason: first-write-wins iteration would hand the label to the DM —
    // only the precedence sort keeps it with the channel.
    const map = roomIdsByOriginLabel([
      makeRoom({ id: 'room-dm', kind: 'dm', slug: null, title: '#general' }),
      makeRoom({ id: 'room-general', slug: 'general', title: 'General' }),
    ]);
    expect(map.get('#general')).toBe('room-general');
  });

  it('is stable whatever order the rooms arrive in', () => {
    const rooms = [
      makeRoom({ id: 'room-shipping-old', archived: true }),
      makeRoom({ id: 'room-shipping-live' }),
      makeRoom({ id: 'room-dm', kind: 'dm', slug: null, title: '#shipping' }),
    ];
    const forwards = roomIdsByOriginLabel(rooms);
    const backwards = roomIdsByOriginLabel([...rooms].reverse());
    expect([...forwards]).toEqual([...backwards]);
  });

  it('leaves the losing room with no conversations at all — the cost, asserted', () => {
    // Not a bug being hidden: with only a label on the wire, one of the two
    // rooms has to lose, and this is what losing looks like. The fix is an
    // origin room id on the session, which is the server's to add.
    const map = roomIdsByOriginLabel([
      makeRoom({ id: 'room-shipping-live' }),
      makeRoom({ id: 'room-shipping-old', archived: true }),
    ]);
    const turn = { cwd: null, origin: 'room', originLabel: '#shipping' };
    expect(scopesOfSession(turn, map)).toEqual(['room:room-shipping-live']);
    expect(scopesOfSession(turn, map)).not.toContain('room:room-shipping-old');
  });
});

describe('which scopes a conversation belongs to', () => {
  const rooms = new Map([['#shipping', 'room-shipping']]);

  it('belongs to the agent whose directory it runs in', () => {
    expect(scopesOfSession({ cwd: '/projects/orbit' }, rooms)).toEqual(['agent:/projects/orbit']);
  });

  it('belongs to both when a room started it', () => {
    expect(
      scopesOfSession({ cwd: '/projects/orbit', origin: 'room', originLabel: '#shipping' }, rooms)
    ).toEqual(['agent:/projects/orbit', 'room:room-shipping']);
  });

  it('belongs to nothing when it has no directory and no origin', () => {
    expect(scopesOfSession({ cwd: null }, rooms)).toEqual([]);
  });

  it('ignores an origin label no room this cockpit can see answers to', () => {
    // A room this reader is not in, or one deleted since the turn ran. (NOT a
    // rename: `resolveRoomOrigins` recomputes the label from the live `rooms`
    // row on every request, so a renamed channel's stamp moves with this map.)
    // Inventing a room would file the conversation somewhere it never was.
    expect(scopesOfSession({ cwd: null, origin: 'room', originLabel: '#renamed' }, rooms)).toEqual(
      []
    );
  });

  it('ignores a label on an origin that is not a room', () => {
    // A scheduled task's `originLabel` is "Scheduled task · nightly", and the
    // Pulse overlay runs last, so a room-started task reads as a task. Matching
    // on the label alone would file it in a channel anyway.
    expect(scopesOfSession({ cwd: null, origin: 'task', originLabel: '#shipping' }, rooms)).toEqual(
      []
    );
  });
});
