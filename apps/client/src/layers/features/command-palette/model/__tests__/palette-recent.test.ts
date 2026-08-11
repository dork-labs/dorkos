/**
 * The two zero-query lists: which conversations are live, and what a person was
 * last in.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import {
  MAX_PALETTE_RECENT,
  buildPaletteRecent,
  selectContinueEntries,
  type PaletteRecentEntry,
} from '../palette-recent';
import type { PaletteSessionItem } from '../palette-sessions';

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return { lifecycle: 'streaming', ...overrides } as SessionStatus;
}

/** One session record, as the palette's two sources hand it over. */
function makeSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: 'A conversation',
    cwd: '/projects/dorkos',
    createdAt: '2026-08-09T09:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

function makeSessionItem(overrides: Partial<PaletteSessionItem> = {}): PaletteSessionItem {
  return {
    id: 'session-1',
    who: 'DorkOS',
    title: 'Dashboard overhaul',
    cwd: '/projects/dorkos',
    agent: null,
    lastActivityAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: 'General',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-09T09:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const agent: AgentPathEntry = { id: 'a', name: 'Warden', projectPath: '/projects/warden' };

describe('selectContinueEntries', () => {
  it('takes streaming and blocked conversations, and nothing else', () => {
    const entries = selectContinueEntries(
      {
        live: status({ lifecycle: 'streaming' }),
        waiting: status({ lifecycle: 'blocked' }),
        done: status({ lifecycle: 'idle' }),
        stopped: status({ lifecycle: 'interrupted' }),
        broken: status({ lifecycle: 'error' }),
      },
      []
    );

    expect(entries.map((e) => e.sessionId).sort()).toEqual(['live', 'waiting']);
  });

  it('puts what is waiting on a person above what is merely working', () => {
    const entries = selectContinueEntries(
      {
        // Named so the id tie-break would sort them the other way if lifecycle
        // were not consulted first.
        aaa: status({ lifecycle: 'streaming' }),
        zzz: status({ lifecycle: 'blocked' }),
      },
      []
    );

    expect(entries.map((e) => e.sessionId)).toEqual(['zzz', 'aaa']);
  });

  it('orders identically for the same input, whatever order the keys arrive in', () => {
    const first = selectContinueEntries({ b: status(), a: status(), c: status() }, []);
    const second = selectContinueEntries({ c: status(), b: status(), a: status() }, []);
    expect(first.map((e) => e.sessionId)).toEqual(['a', 'b', 'c']);
    expect(second.map((e) => e.sessionId)).toEqual(first.map((e) => e.sessionId));
  });

  it('carries the tool a conversation is on, so the row can name it', () => {
    const [entry] = selectContinueEntries(
      { live: status({ activity: { toolName: 'Edit', target: 'strip-state.ts' } }) },
      []
    );
    expect(entry.activity).toEqual({ toolName: 'Edit', target: 'strip-state.ts' });
  });

  it('reports no activity rather than undefined when the server sent none', () => {
    const [entry] = selectContinueEntries({ live: status() }, []);
    expect(entry.activity).toBeNull();
  });

  describe('§18 — automated runs are not "live"', () => {
    it('offers nothing to continue when the only live session is automated', () => {
      // The reported defect (DOR-1137, audit D4): a `#team` message triggers a
      // room turn, the store reports it streaming, and ⌘K promoted it to a
      // first-class Continue row with a verb — while the sidebar, correctly,
      // showed nothing, and Recent in the SAME dialog suppressed it.
      const entries = selectContinueEntries({ 'ses-room': status({ lifecycle: 'streaming' }) }, [
        makeSession({ id: 'ses-room', origin: 'room' }),
      ]);
      expect(entries).toEqual([]);
    });

    it('offers the human one in the same breath, so the empty answer means something', () => {
      // The sibling case, in one call: identical statuses, and only the origin
      // separates them. Without this half, the assertion above passes just as
      // happily against a function that returns nothing at all.
      const entries = selectContinueEntries(
        {
          'ses-room': status({ lifecycle: 'streaming' }),
          'ses-human': status({ lifecycle: 'streaming' }),
        },
        [
          makeSession({ id: 'ses-room', origin: 'room' }),
          makeSession({ id: 'ses-human', origin: 'user' }),
        ]
      );
      expect(entries.map((e) => e.sessionId)).toEqual(['ses-human']);
    });

    it('drops an automated run that is BLOCKED too — Heads up is where that surfaces', () => {
      // The carve-out in §18 ("blocking states go to Heads up like the rest") is
      // a rule about Heads up, and it reads no origin at all. ⌘K's Continue is a
      // liveness listing, so it takes the liveness definition whole.
      const entries = selectContinueEntries({ 'ses-task': status({ lifecycle: 'blocked' }) }, [
        makeSession({ id: 'ses-task', origin: 'task' }),
      ]);
      expect(entries).toEqual([]);
    });

    it('keeps a live session no record covers — unknown is not automated', () => {
      // The same asymmetry the sidebar's working rollup is documented to have,
      // and it has to be the same one or the two surfaces disagree again in the
      // other direction. A session that started after the last fetch has a
      // status before it has a record.
      const entries = selectContinueEntries({ 'ses-new': status({ lifecycle: 'streaming' }) }, [
        makeSession({ id: 'ses-other' }),
      ]);
      expect(entries.map((e) => e.sessionId)).toEqual(['ses-new']);
    });

    it('reads a session with no origin field as the human default', () => {
      // Codex and opencode do not stamp an origin. Treating absent as automated
      // would empty Continue on two of the three runtimes.
      const entries = selectContinueEntries({ 'ses-codex': status() }, [
        makeSession({ id: 'ses-codex' }),
      ]);
      expect(entries.map((e) => e.sessionId)).toEqual(['ses-codex']);
    });
  });
});

describe('buildPaletteRecent', () => {
  const base = {
    sessions: [] as PaletteSessionItem[],
    rooms: [] as RoomSummary[],
    unreadRoomIds: new Set<string>(),
    agents: [] as AgentPathEntry[],
    agentActivity: {} as Record<string, string>,
  };

  const keys = (entries: PaletteRecentEntry[]) => entries.map((e) => e.key);

  it('orders across types by recency', () => {
    const entries = buildPaletteRecent({
      ...base,
      sessions: [makeSessionItem({ id: 's', lastActivityAt: '2026-08-09T08:00:00.000Z' })],
      rooms: [makeRoom({ id: 'r', lastActivityAt: '2026-08-09T11:00:00.000Z' })],
      agents: [agent],
      agentActivity: { '/projects/warden': '2026-08-09T09:30:00.000Z' },
    });

    expect(keys(entries)).toEqual(['room:r', 'agent:/projects/warden', 'session:s']);
  });

  it('leads with a room that has something waiting, however old it is', () => {
    const entries = buildPaletteRecent({
      ...base,
      sessions: [makeSessionItem({ id: 's', lastActivityAt: '2026-08-09T23:00:00.000Z' })],
      rooms: [makeRoom({ id: 'r', lastActivityAt: '2026-07-01T00:00:00.000Z', unreadCount: 3 })],
      unreadRoomIds: new Set(['r']),
    });

    // Recency alone would invert this by nearly six weeks.
    expect(keys(entries)).toEqual(['room:r', 'session:s']);
  });

  it('leaves out a room the reader never joined', () => {
    const entries = buildPaletteRecent({
      ...base,
      rooms: [makeRoom({ id: 'r', unreadCount: null })],
    });
    expect(entries).toEqual([]);
  });

  it('leaves out a room nobody has ever spoken in', () => {
    const entries = buildPaletteRecent({
      ...base,
      rooms: [
        makeRoom({
          id: 'r',
          createdAt: '2026-08-01T10:00:00.000Z',
          lastActivityAt: '2026-08-01T10:00:00.000Z',
        }),
      ],
    });
    expect(entries).toEqual([]);
  });

  it('leaves out an archived room, which cannot yet say it is archived here', () => {
    const entries = buildPaletteRecent({
      ...base,
      rooms: [makeRoom({ id: 'r', archived: true })],
    });
    expect(entries).toEqual([]);
  });

  it('drops an agent whose own conversation is already in the list', () => {
    const entries = buildPaletteRecent({
      ...base,
      sessions: [makeSessionItem({ id: 's', cwd: '/projects/warden' })],
      agents: [agent],
      agentActivity: { '/projects/warden': '2026-08-09T09:30:00.000Z' },
    });

    expect(keys(entries)).toEqual(['session:s']);
  });

  it('drops an agent whose ONLY conversation is the live one Continue is showing', () => {
    // The common case, not an edge one: an agent with a single conversation
    // that is running right now. Continue draws it, so it is excluded from
    // Recent's session rows — and if the "is this agent already listed?" set is
    // built from what SURVIVED that exclusion, the agent walks straight back in
    // and the operator reads the same thing twice, one row apart.
    //
    // Being live is the strongest possible reason to suppress the agent row,
    // not a reason to forget about it.
    const entries = buildPaletteRecent({
      ...base,
      sessions: [makeSessionItem({ id: 'live', cwd: '/projects/warden' })],
      agents: [agent],
      agentActivity: { '/projects/warden': '2026-08-09T09:30:00.000Z' },
      excludeSessionIds: new Set(['live']),
    });

    expect(keys(entries)).toEqual([]);
  });

  it('still drops the agent when one of its several conversations is live', () => {
    // The same rule with the masking removed the other way round: here a second,
    // idle conversation shares the cwd. That alone keeps the agent suppressed,
    // which is exactly why a fixture carrying one cannot prove the case above.
    const entries = buildPaletteRecent({
      ...base,
      sessions: [
        makeSessionItem({ id: 'live', cwd: '/projects/warden' }),
        makeSessionItem({ id: 'idle', cwd: '/projects/warden' }),
      ],
      agents: [agent],
      agentActivity: { '/projects/warden': '2026-08-09T09:30:00.000Z' },
      excludeSessionIds: new Set(['live']),
    });

    expect(keys(entries)).toEqual(['session:idle']);
  });

  it('leaves out an agent that has never run anything the window can see', () => {
    const entries = buildPaletteRecent({ ...base, agents: [agent], agentActivity: {} });
    expect(entries).toEqual([]);
  });

  it('never lists a conversation Continue is already showing', () => {
    const entries = buildPaletteRecent({
      ...base,
      sessions: [makeSessionItem({ id: 'live' }), makeSessionItem({ id: 'quiet' })],
      excludeSessionIds: new Set(['live']),
    });
    expect(keys(entries)).toEqual(['session:quiet']);
  });

  it('caps the list, because it is a shortcut and not a directory', () => {
    const entries = buildPaletteRecent({
      ...base,
      sessions: Array.from({ length: MAX_PALETTE_RECENT + 4 }, (_, i) =>
        makeSessionItem({ id: `s${i}`, lastActivityAt: `2026-08-0${(i % 9) + 1}T10:00:00.000Z` })
      ),
    });
    expect(entries).toHaveLength(MAX_PALETTE_RECENT);
  });

  it('breaks a recency tie the same way every time', () => {
    const tied = ['b', 'a', 'c'].map((id) =>
      makeSessionItem({ id, lastActivityAt: '2026-08-09T10:00:00.000Z' })
    );
    const first = keys(buildPaletteRecent({ ...base, sessions: tied }));
    const second = keys(buildPaletteRecent({ ...base, sessions: [...tied].reverse() }));
    expect(first).toEqual(second);
  });

  it('sorts an unreadable timestamp last instead of emptying the list', () => {
    const entries = buildPaletteRecent({
      ...base,
      sessions: [
        makeSessionItem({ id: 'broken', lastActivityAt: 'not a date' }),
        makeSessionItem({ id: 'fine', lastActivityAt: '2026-08-09T10:00:00.000Z' }),
      ],
    });
    expect(keys(entries)).toEqual(['session:fine', 'session:broken']);
  });
});
