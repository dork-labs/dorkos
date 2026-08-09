/**
 * What the presence strip will and will not claim (spec `team-room-home` D3.3).
 *
 * Every case here is a truthfulness case: the rows are only worth drawing if an
 * agent nobody can name is absent, work nobody can place says only who is doing
 * it, and one agent working in one place is one row.
 */
import { describe, it, expect } from 'vitest';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { AuthorRef, RoomSummary, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomPresenceClaim } from '@/layers/entities/room';
import { buildPresenceRows, type PresenceRowsInput } from '../lib/presence-rows';

const TANGERINES_PATH = '/code/tangerines';
const DORKBOT_PATH = '/code/dorkbot';

/** An author row as a room hands it out. */
function author(overrides: Partial<AuthorRef> & Pick<AuthorRef, 'id'>): AuthorRef {
  return {
    kind: 'agent',
    displayName: 'tangerines',
    handle: 'tangerines',
    ...overrides,
  } as AuthorRef;
}

/** A room with a roster, as `GET /api/rooms/:id` answers. */
function roomWithRoster(id: string, authors: AuthorRef[]): RoomWithRoster {
  return {
    id,
    kind: 'channel',
    slug: 'release-train',
    title: 'release-train',
    viewerAuthorId: 'human-1',
    members: authors.map((entry) => ({
      roomId: id,
      authorId: entry.id,
      responseMode: 'engaged',
      joinedAt: '2026-08-01T00:00:00.000Z',
      joinedSeq: 0,
      lastReadSeq: 0,
      author: entry,
      origin: { kind: 'local' },
    })),
  } as unknown as RoomWithRoster;
}

/** A room as the sidebar's list carries it. */
function roomSummary(overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id'>): RoomSummary {
  return {
    kind: 'channel',
    slug: 'release-train',
    title: 'release-train',
    unreadCount: 0,
    participants: null,
    lastActivityAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  } as unknown as RoomSummary;
}

/** A registered agent, as the fleet read resolves it. */
function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01JZAGENT0000000000000001',
    name: 'tangerines',
    displayName: 'tangerines',
    runtime: 'claude-code',
    color: '#6366f1',
    icon: '🍊',
    ...overrides,
  } as unknown as AgentManifest;
}

/** A live claim off the presence store. */
function claim(overrides: Partial<RoomPresenceClaim> = {}): RoomPresenceClaim {
  return {
    roomId: 'room-1',
    authorId: 'author-1',
    state: 'working',
    since: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

/** An empty world, so each test states only what it is about. */
function input(overrides: Partial<PresenceRowsInput> = {}): PresenceRowsInput {
  return { claims: [], rosters: {}, rooms: {}, sessions: [], agents: {}, ...overrides };
}

describe('buildPresenceRows — room claims', () => {
  it('names the agent and the room it is replying in', () => {
    const rows = buildPresenceRows(
      input({
        claims: [claim()],
        rosters: { 'room-1': roomWithRoster('room-1', [author({ id: 'author-1' })]) },
        rooms: { 'room-1': roomSummary({ id: 'room-1' }) },
      })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('tangerines');
    expect(rows[0]!.line).toBe('tangerines · replying in #release-train');
    expect(rows[0]!.follow).toEqual({ kind: 'room', roomId: 'room-1' });
  });

  it('says a long wait out loud, in the words every other surface uses', () => {
    const rows = buildPresenceRows(
      input({
        claims: [claim({ state: 'working_late' })],
        rosters: { 'room-1': roomWithRoster('room-1', [author({ id: 'author-1' })]) },
        rooms: { 'room-1': roomSummary({ id: 'room-1' }) },
      })
    );

    expect(rows[0]!.line).toBe(
      'tangerines · replying in #release-train · taking longer than usual'
    );
  });

  it('omits a claim no roster can put a name to', () => {
    // The strip is avatars and names. An agent this client cannot name has no
    // face to draw and no word to say about it, so it is absent — never a
    // placeholder disc, never "an agent".
    const rows = buildPresenceRows(
      input({
        claims: [claim({ authorId: 'stranger' })],
        rosters: { 'room-1': roomWithRoster('room-1', [author({ id: 'author-1' })]) },
        rooms: { 'room-1': roomSummary({ id: 'room-1' }) },
      })
    );

    expect(rows).toEqual([]);
  });

  it('keeps the name and drops the activity line for a room it cannot name', () => {
    // WHO and WHERE are two independent reads. The roster answered; the room
    // list has not caught up on a channel created moments ago. The honest row
    // is the name with nothing after it — never a guessed room.
    const rows = buildPresenceRows(
      input({
        claims: [claim()],
        rosters: { 'room-1': roomWithRoster('room-1', [author({ id: 'author-1' })]) },
        rooms: {},
      })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.binding).toBeNull();
    expect(rows[0]!.detail).toBeNull();
    expect(rows[0]!.line).toBe('tangerines');
  });

  it('names a direct message from the list alone, with no roster fetched', () => {
    // A DM carries its own roster on every list row, so it can be named without
    // ever having been opened.
    const rows = buildPresenceRows(
      input({
        claims: [claim({ roomId: 'dm-1' })],
        rooms: {
          'dm-1': roomSummary({
            id: 'dm-1',
            kind: 'dm',
            slug: undefined,
            title: 'tangerines',
            participants: [author({ id: 'author-1' })],
          }),
        },
      })
    );

    expect(rows[0]!.line).toBe('tangerines · replying in tangerines');
  });

  it('prefers the agent manifest over the author row for the face', () => {
    const rows = buildPresenceRows(
      input({
        claims: [claim()],
        rosters: {
          'room-1': roomWithRoster('room-1', [
            author({ id: 'author-1', agentRef: agentAuthorRef(TANGERINES_PATH), color: '#000000' }),
          ]),
        },
        rooms: { 'room-1': roomSummary({ id: 'room-1' }) },
        agents: { [TANGERINES_PATH]: manifest() },
      })
    );

    expect(rows[0]!.face.color).toBe('#6366f1');
    expect(rows[0]!.face.emoji).toBe('🍊');
    expect(rows[0]!.runtime).toBe('claude-code');
  });
});

describe('buildPresenceRows — running sessions', () => {
  it('names an agent working in a session it can attribute', () => {
    const rows = buildPresenceRows(
      input({
        sessions: [{ sessionId: 'sess-1', cwd: DORKBOT_PATH }],
        agents: { [DORKBOT_PATH]: manifest({ name: 'dorkbot', displayName: 'DorkBot' }) },
      })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.line).toBe('DorkBot · working in a session');
    expect(rows[0]!.follow).toEqual({ kind: 'session', sessionId: 'sess-1', cwd: DORKBOT_PATH });
  });

  it('omits a running session whose directory names no agent', () => {
    // The shape a runtime that reports a lifecycle without a working directory
    // leaves behind: something is running and nothing can say whose it is. A
    // nameless avatar would be the lie this rule exists to prevent.
    const rows = buildPresenceRows(
      input({
        sessions: [{ sessionId: 'sess-1', cwd: '/somewhere/unregistered' }],
        agents: { [DORKBOT_PATH]: manifest() },
      })
    );

    expect(rows).toEqual([]);
  });

  it('draws one row for an agent running two sessions at once', () => {
    const rows = buildPresenceRows(
      input({
        sessions: [
          { sessionId: 'sess-1', cwd: DORKBOT_PATH },
          { sessionId: 'sess-2', cwd: DORKBOT_PATH },
        ],
        agents: { [DORKBOT_PATH]: manifest({ displayName: 'DorkBot' }) },
      })
    );

    expect(rows).toHaveLength(1);
  });
});

describe('buildPresenceRows — the two halves overlapping', () => {
  it('draws one row for an agent whose room turn is also a running session', () => {
    // A room turn RUNS in a session in the agent's own directory, so both
    // halves see the same work. Without the join this is two rows for one
    // agent — one saying where, one saying nothing.
    const rows = buildPresenceRows(
      input({
        claims: [claim()],
        rosters: {
          'room-1': roomWithRoster('room-1', [
            author({ id: 'author-1', agentRef: agentAuthorRef(TANGERINES_PATH) }),
          ]),
        },
        rooms: { 'room-1': roomSummary({ id: 'room-1' }) },
        sessions: [{ sessionId: 'sess-1', cwd: TANGERINES_PATH }],
        agents: { [TANGERINES_PATH]: manifest() },
      })
    );

    expect(rows).toHaveLength(1);
    // The room row survives, because it is the one that can say where.
    expect(rows[0]!.line).toBe('tangerines · replying in #release-train');
  });

  it('draws one row per room for an agent working in two of them', () => {
    // The suppression is of the COARSER half only. Two claims are two specific
    // statements, and a person watching wants the one they care about.
    const rows = buildPresenceRows(
      input({
        claims: [claim(), claim({ roomId: 'room-2' })],
        rosters: {
          'room-1': roomWithRoster('room-1', [author({ id: 'author-1' })]),
          'room-2': roomWithRoster('room-2', [author({ id: 'author-1' })]),
        },
        rooms: {
          'room-1': roomSummary({ id: 'room-1' }),
          'room-2': roomSummary({ id: 'room-2', slug: 'team', title: 'team' }),
        },
      })
    );

    expect(rows.map((r) => r.line)).toEqual([
      'tangerines · replying in #release-train',
      'tangerines · replying in #team',
    ]);
  });

  it('keeps a second agent whose session is unrelated to the room turn', () => {
    const rows = buildPresenceRows(
      input({
        claims: [claim()],
        rosters: {
          'room-1': roomWithRoster('room-1', [
            author({ id: 'author-1', agentRef: agentAuthorRef(TANGERINES_PATH) }),
          ]),
        },
        rooms: { 'room-1': roomSummary({ id: 'room-1' }) },
        sessions: [{ sessionId: 'sess-2', cwd: DORKBOT_PATH }],
        agents: {
          [TANGERINES_PATH]: manifest(),
          [DORKBOT_PATH]: manifest({ id: '01JZAGENT0000000000000002', displayName: 'DorkBot' }),
        },
      })
    );

    expect(rows.map((row) => row.line)).toEqual([
      'tangerines · replying in #release-train',
      'DorkBot · working in a session',
    ]);
  });
});

describe('buildPresenceRows — a room that narrates its own presence', () => {
  /** The world where one agent is replying in the excluded room, and nothing else. */
  function excludedWorld(overrides: Partial<PresenceRowsInput> = {}): PresenceRowsInput {
    return input({
      claims: [claim()],
      rosters: {
        'room-1': roomWithRoster('room-1', [
          author({ id: 'author-1', agentRef: agentAuthorRef(TANGERINES_PATH) }),
        ]),
      },
      rooms: { 'room-1': roomSummary({ id: 'room-1' }) },
      agents: { [TANGERINES_PATH]: manifest() },
      excludeRoomIds: ['room-1'],
      ...overrides,
    });
  }

  it('draws no row for a claim in an excluded room', () => {
    expect(buildPresenceRows(excludedWorld())).toEqual([]);
  });

  it('does NOT let the excluded agent come back as a session row', () => {
    // The trap this seam exists to avoid. Filtering the claims on the way IN
    // would drop the room row and leave the agent's streaming session
    // unaccounted for — so the strip would redraw the same agent through its
    // coarser half, saying "working in a session" about the very work the room
    // below is already narrating. Excluding INSIDE the builder spends the
    // agent's directory first and only then declines to draw it.
    //
    // Red the moment the exclusion moves out of the builder.
    const rows = buildPresenceRows(
      excludedWorld({ sessions: [{ sessionId: 'sess-1', cwd: TANGERINES_PATH }] })
    );

    expect(rows).toEqual([]);
  });

  it('still draws everybody the exclusion is not about', () => {
    const rows = buildPresenceRows(
      excludedWorld({
        sessions: [{ sessionId: 'sess-2', cwd: DORKBOT_PATH }],
        agents: {
          [TANGERINES_PATH]: manifest(),
          [DORKBOT_PATH]: manifest({ id: '01JZAGENT0000000000000002', displayName: 'DorkBot' }),
        },
      })
    );

    expect(rows.map((row) => row.line)).toEqual(['DorkBot · working in a session']);
  });

  it('is a no-op when the excluded room has nothing to do with the claims', () => {
    const rows = buildPresenceRows(excludedWorld({ excludeRoomIds: ['some-other-room'] }));

    expect(rows.map((row) => row.line)).toEqual(['tangerines · replying in #release-train']);
  });
});
