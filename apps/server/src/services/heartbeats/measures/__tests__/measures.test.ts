/**
 * The measures (spec `heartbeats` §13, §10 PR 6 tests: "each measure from a
 * seeded record"): every number is computed from rows seeded into a real
 * database, the beat record, the outbox, the rooms its messages landed in,
 * promises and the audit trail, and each test names the row that moves it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  authors,
  commitments,
  heartbeatBeats,
  heartbeatOutbox,
  roomEntries,
  roomEntryReactions,
  roomMembers,
  rooms,
  type Db,
} from '@dorkos/db';
import { AuditLog } from '../../../audit/audit-log.js';
import { measureAgent } from '../measures.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const AGENT = 'agent-juno';
const AGENT_PATH = '/agents/juno';
const OWNER = 'acct-owner';

let db: Db;
let audit: AuditLog;
let seq = 0;

/** ISO for `NOW - ms`. */
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A finished beat. */
function beat(
  id: string,
  startedMsAgo: number,
  fields: Partial<typeof heartbeatBeats.$inferInsert> = {}
): void {
  db.insert(heartbeatBeats)
    .values({
      id,
      agentId: AGENT,
      startedAt: ago(startedMsAgo),
      endedAt: ago(startedMsAgo - 5 * 60 * 1000),
      kind: 'pulse',
      wake: 'timer',
      outcome: 'quiet',
      ...fields,
    })
    .run();
}

/** A room entry in a room, posted by an author. */
function entry(id: string, roomId: string, authorId: string, msAgo: number, parent?: string) {
  seq += 1;
  db.insert(roomEntries)
    .values({
      roomId,
      seq,
      id,
      authorId,
      kind: 'post',
      body: '{"text":"x"}',
      cascadeRoot: id,
      createdAt: ago(msAgo),
      ...(parent ? { parentEntryId: parent } : {}),
    })
    .run();
}

/** An outbox row. Delivered ones closed at `msAgo`. */
function outboxRow(
  id: string,
  beatId: string,
  msAgo: number,
  fields: Partial<typeof heartbeatOutbox.$inferInsert> = {}
): void {
  db.insert(heartbeatOutbox)
    .values({
      id,
      agentId: AGENT,
      beatId,
      toAccount: OWNER,
      rung: 'dm',
      text: 'x',
      key: id,
      deliverAfter: ago(msAgo),
      state: 'delivered',
      createdAt: ago(msAgo),
      closedAt: ago(msAgo),
      ...fields,
    })
    .run();
}

/** A reaction by an author. */
function react(entryId: string, roomId: string, authorId: string, emoji: string, msAgo: number) {
  db.insert(roomEntryReactions)
    .values({ roomId, entryId, authorId, emoji, createdAt: ago(msAgo) })
    .run();
}

/** An audit row by a person (or someone else). */
function recordBy(
  kind: 'person' | 'agent',
  action: string,
  msAgo: number,
  target: { type: string; id: string },
  change?: Array<{ field: string; before: unknown; after: unknown }>
): void {
  audit.record({
    at: ago(msAgo),
    actor: { accountId: kind === 'person' ? OWNER : 'agent-otto', kind, name: kind },
    source: { surface: 'http' },
    action,
    operation: 'modify',
    target,
    outcome: 'ok',
    summary: action,
    ...(change ? { change } : {}),
  });
}

/** The measures now, over the default window unless `days` says otherwise. */
function measure(days?: number) {
  return measureAgent(db, {
    agentId: AGENT,
    agentPath: AGENT_PATH,
    isAgent: (id) => id.startsWith('agent-'),
    now: NOW,
    ...(days !== undefined ? { days } : {}),
  });
}

beforeEach(() => {
  db = createTestDb();
  audit = new AuditLog(db);
  seq = 0;
  for (const [id, kind, naturalKey] of [
    ['author-person', 'human', 'acct-owner'],
    ['author-juno', 'agent', AGENT_PATH],
  ] as const) {
    db.insert(authors)
      .values({ id, kind, naturalKey, displayName: id, createdAt: '2026-10-01T00:00:00Z' })
      .run();
  }
  for (const [id, kind] of [
    ['room-dm', 'dm'],
    ['room-team', 'channel'],
  ] as const) {
    db.insert(rooms)
      .values({
        id,
        kind,
        title: id,
        createdAt: '2026-10-01T00:00:00Z',
        lastActivityAt: '2026-10-01T00:00:00Z',
      } as never)
      .run();
  }
  db.insert(roomMembers)
    .values({
      roomId: 'room-dm',
      authorId: 'author-juno',
      responseMode: 'always',
      joinedAt: '2026-10-01T00:00:00Z',
    })
    .run();
});

describe('no beats yet', () => {
  it('counts nothing and leaves every rate empty rather than zero', () => {
    const m = measure();
    expect(m.supporting.beats).toBe(0);
    expect(m.keptRate).toMatchObject({ value: null, part: 0, whole: 0, target: '95% or more' });
    expect(m.usefulRaiseRate.value).toBeNull();
    expect(m.interruptions.value).toBeNull();
    expect(m.surprises).toEqual({ measured: false, source: expect.any(String) });
    expect(m.windowDays).toBe(7);
    expect(m.since).toBe(ago(7 * DAY));
  });
});

describe('kept rate', () => {
  it('counts a worked beat as undone only for a person’s stop, a pause within an hour, or 👎', () => {
    beat('b-clean', 3 * HOUR, { outcome: 'worked', turnSessionId: 'chat-a' });
    beat('b-stopped', 4 * HOUR, { outcome: 'worked', turnSessionId: 'chat-b' });
    beat('b-paused', 6 * HOUR, { outcome: 'worked', turnSessionId: 'chat-c' });
    beat('b-disliked', 8 * HOUR, { outcome: 'worked', turnSessionId: 'chat-d', raises: 1 });
    beat('b-agent-stop', 10 * HOUR, { outcome: 'worked', turnSessionId: 'chat-e' });
    beat('b-late-pause', 30 * HOUR, { outcome: 'worked', turnSessionId: 'chat-f' });
    beat('b-quiet', 12 * HOUR); // never acted, so never in the rate
    // A person pressed stop on b-stopped while it ran.
    recordBy('person', 'chat.stopped', 4 * HOUR - 60_000, { type: 'session', id: 'chat-b' });
    // An agent stopping a beat chat is not a person undoing it.
    recordBy('agent', 'chat.stopped', 10 * HOUR - 60_000, { type: 'session', id: 'chat-e' });
    // Paused 30 minutes after b-paused ended; b-late-pause's pause came 3 hours after.
    recordBy('person', 'agent.paused', 6 * HOUR - 35 * 60_000, { type: 'agent', id: AGENT });
    recordBy('person', 'agent.paused', 27 * HOUR, { type: 'agent', id: AGENT });
    // A 👎 on the message b-disliked raised.
    entry('e-disliked', 'room-dm', 'author-juno', 7 * HOUR);
    outboxRow('o-disliked', 'b-disliked', 7 * HOUR, { deliveredEntryId: 'e-disliked' });
    react('e-disliked', 'room-dm', 'author-person', '👎', 6 * HOUR);

    const { keptRate } = measure();
    expect(keptRate.whole).toBe(6);
    // b-clean, b-agent-stop and b-late-pause.
    expect(keptRate.part).toBe(3);
    expect(keptRate.value).toBeCloseTo(0.5);
    expect(keptRate.source).toMatch(/Reverts are not seen yet/);
  });
});

describe('useful-raise rate', () => {
  it('counts raises in the app answered or reacted to (not 👎) within 48 hours', () => {
    beat('b1', 4 * DAY, { outcome: 'worked', turnSessionId: 'chat-1', raises: 7 });
    // Answered in the DM within the hour.
    entry('e-replied', 'room-dm', 'author-juno', 3 * DAY);
    entry('e-reply', 'room-dm', 'author-person', 3 * DAY - HOUR);
    outboxRow('o-replied', 'b1', 3 * DAY, { deliveredEntryId: 'e-replied', state: 'resolved' });
    // A 👍 in a shared room.
    entry('e-liked', 'room-team', 'author-juno', 2 * DAY + 10 * HOUR);
    outboxRow('o-liked', 'b1', 2 * DAY + 10 * HOUR, {
      rung: 'room',
      roomId: 'room-team',
      deliveredEntryId: 'e-liked',
    });
    react('e-liked', 'room-team', 'author-person', '👍', 2 * DAY);
    // A 👎 is not useful.
    entry('e-disliked', 'room-team', 'author-juno', 2 * DAY + 5 * HOUR);
    outboxRow('o-disliked', 'b1', 2 * DAY + 5 * HOUR, {
      rung: 'room',
      roomId: 'room-team',
      deliveredEntryId: 'e-disliked',
    });
    react('e-disliked', 'room-team', 'author-person', '👎', 2 * DAY);
    // Answered, but after 48 hours.
    entry('e-slow', 'room-dm', 'author-juno', 3 * DAY + 2 * HOUR);
    outboxRow('o-slow', 'b1', 3 * DAY + 2 * HOUR, { deliveredEntryId: 'e-slow' });
    // A post in a shared room that is not a reply in its thread answers nothing.
    entry('e-room-noise', 'room-team', 'author-juno', 2 * DAY + 3 * HOUR);
    entry('e-unrelated', 'room-team', 'author-person', 2 * DAY + 2 * HOUR);
    outboxRow('o-room-noise', 'b1', 2 * DAY + 3 * HOUR, {
      rung: 'room',
      roomId: 'room-team',
      deliveredEntryId: 'e-room-noise',
    });
    // Not counted either way: a note that left the app, a report, a message to an agent.
    outboxRow('o-note', 'b1', 2 * DAY, { rung: 'note' });
    entry('e-report', 'room-dm', 'author-juno', 2 * DAY - HOUR);
    outboxRow('o-report', 'b1', 2 * DAY - HOUR, {
      key: 'report:b0',
      deliveredEntryId: 'e-report',
    });
    outboxRow('o-agent', 'b1', 2 * DAY, { rung: 'report', toAccount: 'agent-otto' });

    const { usefulRaiseRate } = measure();
    expect(usefulRaiseRate).toMatchObject({ part: 2, whole: 5, target: '60% or more' });
  });
});

describe('interruptions per useful outcome', () => {
  it('divides messages that reached a person by kept actions plus useful raises', () => {
    beat('b1', 2 * DAY, { outcome: 'worked', turnSessionId: 'chat-1', raises: 3 });
    beat('b2', 1 * DAY, { outcome: 'worked', turnSessionId: 'chat-2' });
    // Two raises batched into one DM: one interruption, two raises.
    entry('e-batch', 'room-dm', 'author-juno', 30 * HOUR);
    entry('e-answer', 'room-dm', 'author-person', 29 * HOUR);
    outboxRow('o-a', 'b1', 30 * HOUR, { deliveredEntryId: 'e-batch' });
    outboxRow('o-b', 'b1', 30 * HOUR, { deliveredEntryId: 'e-batch' });
    // A note outside the app and a report reach a person too.
    outboxRow('o-note', 'b1', 20 * HOUR, { rung: 'note' });
    outboxRow('o-report', 'b2', 10 * HOUR, { key: 'report:b2', rung: 'dm' });
    // Still held, and a message to an agent: neither reached a person.
    outboxRow('o-held', 'b2', 0, { state: 'held', closedAt: null, deliverAfter: ago(-HOUR) });
    outboxRow('o-agent', 'b2', 5 * HOUR, { rung: 'report', toAccount: 'agent-otto' });

    const { interruptions, usefulRaiseRate, keptRate } = measure();
    expect(interruptions.messages).toBe(3);
    // 2 kept beats + 2 answered raises (the batch shares its answer).
    expect(keptRate.part).toBe(2);
    expect(usefulRaiseRate.part).toBe(2);
    expect(interruptions.usefulOutcomes).toBe(4);
    expect(interruptions.value).toBeCloseTo(0.75);
    expect(interruptions.target).toBe('1 or less');
  });
});

describe('mutes and pauses', () => {
  it('counts a person’s pause, wake switched off, and a mute of the agent or its DM', () => {
    beat('b1', DAY);
    recordBy('person', 'agent.paused', 2 * DAY, { type: 'agent', id: AGENT });
    recordBy('agent', 'agent.paused', 2 * DAY, { type: 'agent', id: AGENT });
    recordBy('person', 'agent.paused', 2 * DAY, { type: 'agent', id: 'agent-otto' });
    recordBy('person', 'heartbeat.config_changed', DAY, { type: 'agent', id: AGENT }, [
      { field: 'wake', before: 'timed', after: 'off' },
    ]);
    recordBy('person', 'heartbeat.config_changed', DAY, { type: 'agent', id: AGENT }, [
      { field: 'every', before: 30, after: 60 },
    ]);
    recordBy('person', 'config.changed', DAY, { type: 'config', id: 'config.json' }, [
      { field: 'ui.sidebar.muted', before: [], after: [{ kind: 'agent', path: AGENT_PATH }] },
    ]);
    recordBy('person', 'config.changed', HOUR, { type: 'config', id: 'config.json' }, [
      {
        field: 'ui.sidebar.muted',
        before: [{ kind: 'agent', path: AGENT_PATH }],
        after: [
          { kind: 'agent', path: AGENT_PATH },
          { kind: 'room', roomId: 'room-dm' },
        ],
      },
    ]);
    recordBy('person', 'config.changed', HOUR, { type: 'config', id: 'config.json' }, [
      { field: 'ui.sidebar.muted', before: [], after: [{ kind: 'room', roomId: 'room-team' }] },
    ]);
    // Before the window: not counted.
    recordBy('person', 'agent.paused', 9 * DAY, { type: 'agent', id: AGENT });

    expect(measure().mutesAndPauses).toMatchObject({ total: 4, pauses: 1, wakeOff: 1, mutes: 2 });
  });
});

describe('supporting measures', () => {
  it('reads quiet beats, promises on time, missing end_beat, checks, runs, bypass and held', () => {
    const triage = JSON.stringify({
      steps: [{ rung: 1, requests: 1, usage: { inputTokens: 300, outputTokens: 20 } }],
    });
    beat('b-quiet', 5 * HOUR, { triage });
    beat('b-quiet-2', 6 * HOUR, { triage });
    beat('b-worked', 7 * HOUR, {
      outcome: 'worked',
      turnSessionId: 'chat-w',
      raises: 1,
      bypass: 2,
      turnUsage: JSON.stringify({ inputTokens: 1500, outputTokens: 500 }),
    });
    beat('b-no-end', 8 * HOUR, { outcome: 'no-end-beat', turnSessionId: 'chat-n' });
    beat('b-skipped', 9 * HOUR, { outcome: 'skipped' });
    outboxRow('o-held', 'b-worked', 0, {
      state: 'held',
      closedAt: null,
      deliverAfter: ago(-HOUR),
    });
    const promise = (id: string, state: string, dueMsAgo: number, closedMsAgo: number | null) =>
      db
        .insert(commitments)
        .values({
          id,
          agentId: AGENT,
          what: id,
          dueAt: ago(dueMsAgo),
          state: state as 'open',
          createdAt: ago(5 * DAY),
          closedAt: closedMsAgo === null ? null : ago(closedMsAgo),
        })
        .run();
    promise('kept-early', 'kept', DAY, 2 * DAY);
    promise('kept-late', 'kept', 2 * DAY, DAY);
    promise('missed', 'missed', 3 * DAY, 3 * DAY - HOUR);
    promise('dropped', 'dropped', 3 * DAY, 4 * DAY);
    promise('not-due-yet', 'open', -DAY, null);

    const { supporting } = measure();
    expect(supporting.beats).toBe(4);
    expect(supporting.quietBeats).toMatchObject({ part: 3, whole: 4 });
    expect(supporting.commitmentsOnTime).toMatchObject({ part: 1, whole: 3 });
    expect(supporting.noEndBeat).toBe(1);
    expect(supporting.triage).toEqual({ checks: 2, tokens: 640 });
    expect(supporting.turns).toEqual({ count: 2, tokensPerTurn: 2000 });
    expect(supporting.bypass).toBe(2);
    expect(supporting.held).toBe(1);
  });
});

describe('the window', () => {
  it('leaves out beats older than the window, and a wider window takes them in', () => {
    beat('b-old', 10 * DAY, { outcome: 'worked', turnSessionId: 'chat-old' });
    beat('b-new', DAY);
    expect(measure().supporting.beats).toBe(1);
    const wide = measure(30);
    expect(wide.windowDays).toBe(30);
    expect(wide.supporting.beats).toBe(2);
    expect(wide.keptRate.whole).toBe(1);
  });

  it('clamps a window to 1 to 90 days', () => {
    expect(measure(0).windowDays).toBe(1);
    expect(measure(400).windowDays).toBe(90);
  });
});
