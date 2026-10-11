/**
 * The PR 4 manners (spec `heartbeats` §9.2, §10 PR 4 tests): raise once then
 * track, away, de-duplication across agents, and how an open raise closes —
 * through the real outbox over a real database, with a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  auditEvents,
  authors,
  heartbeatOutbox,
  heartbeatReportItems,
  roomEntries,
  rooms,
  type Db,
} from '@dorkos/db';
import { resolveWorkingHours } from '@dorkos/shared/working-hours';
import type { EndBeatRaise } from '@dorkos/shared/heartbeat-schemas';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { HeartbeatStore } from '../../heartbeat-store.js';
import { BeatOutbox, type OutboxDeps } from '../../outbox.js';
import { OPEN_RAISE_MAX_MS, RaiseStore } from '../raise-store.js';
import type { BeatAgent } from '../../beat-runner.js';

/** Tuesday 10:00 in New York: inside default working hours. */
const TUESDAY_10AM = Date.parse('2026-10-13T14:00:00Z');
const HOURS = resolveWorkingHours({ timezone: 'America/New_York', workingHours: null });

const juno: BeatAgent = { id: 'agent-juno', name: 'Juno', runtime: 'doe', projectPath: '/a/juno' };
const otto: BeatAgent = { id: 'agent-otto', name: 'Otto', runtime: 'doe', projectPath: '/a/otto' };

let db: Db;
let store: HeartbeatStore;
let raises: RaiseStore;
let dms: Array<{ agent: string; to: string; text: string }>;
let awayPeople: Map<string, string | null>;
let ids = 0;

/** The outbox over fakes; DMs land as room entries `dm-<n>` in room `room-dm`. */
function outbox(overrides: Partial<OutboxDeps> = {}): BeatOutbox {
  return new BeatOutbox({
    store,
    raises,
    managerOf: () => 'acct-owner',
    chainPersonOf: () => 'acct-owner',
    isAgent: (id) => id.startsWith('agent-'),
    presenceOf: (person) => ({
      hours: HOURS,
      away: awayPeople.has(person) ? { until: awayPeople.get(person) ?? null } : null,
    }),
    postToRoom: () => ({ ok: true }),
    deliverDm: async (agent, to, text) => {
      dms.push({ agent: agent.id, to, text });
      const entryId = `dm-${dms.length}`;
      entry(entryId, dms.length, 'author-agent', Date.now());
      return { ok: true, entryId };
    },
    deliverNote: async () => ({ ok: true }),
    sendToAgent: async () => ({ ok: true }),
    agentOf: (id) => [juno, otto].find((agent) => agent.id === id),
    roomReachesPerson: () => false,
    enabled: () => true,
    mintId: () => `row-${++ids}`,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    ...overrides,
  });
}

/** A post in the DM room. */
function entry(id: string, seq: number, authorId: string, at: number): void {
  db.insert(roomEntries)
    .values({
      roomId: 'room-dm',
      seq,
      id,
      authorId,
      kind: 'post',
      body: JSON.stringify({ text: 'x' }),
      cascadeRoot: id,
      createdAt: new Date(at).toISOString(),
    })
    .run();
}

/** One beat handing over raises. */
function raise(box: BeatOutbox, agent: BeatAgent, ...list: EndBeatRaise[]) {
  return box.accept({ agent, beatId: `beat-${agent.id}`, chatSessionId: 'chat', raises: list });
}

/** Audit summaries for one action. */
function lines(action: string): string[] {
  return db
    .select()
    .from(auditEvents)
    .all()
    .filter((row) => row.action === action)
    .map((row) => row.summary ?? '');
}

beforeEach(() => {
  vi.useFakeTimers({ now: TUESDAY_10AM });
  db = createTestDb();
  store = new HeartbeatStore(db);
  // Dorian answers as `author-person` in the DM his raises land in.
  raises = new RaiseStore(db, {
    recipientAuthor: (to) => (to === 'acct-owner' ? 'author-person' : null),
  });
  dms = [];
  awayPeople = new Map();
  ids = 0;
  for (const [id, kind] of [
    ['author-agent', 'agent'],
    ['author-person', 'human'],
    ['author-stranger', 'human'],
  ] as const) {
    db.insert(authors)
      .values({ id, kind, naturalKey: id, displayName: id, createdAt: '2026-10-01T00:00:00Z' })
      .run();
  }
  db.insert(rooms)
    .values({
      id: 'room-dm',
      kind: 'dm',
      title: 'DM',
      createdAt: '2026-10-01T00:00:00Z',
      lastActivityAt: '2026-10-01T00:00:00Z',
    } as never)
    .run();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({
      db,
      installId: '1',
      readOwnerAccount: () => ({ id: 'acct-owner', name: 'Dorian' }),
    }),
  });
});

afterEach(() => {
  resetAuditTrail();
  vi.useRealTimers();
});

describe('de-duplication across agents', () => {
  it('delivers overlapping about keys from two agents once, and records who raised it first', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'The nightly run failed.', rung: 'dm', about: ['run:42'] });
    await raise2(box);
    expect(dms.map((dm) => dm.text)).toEqual(['The nightly run failed.']);
    expect(lines('heartbeat.deduplicated')).toEqual(['Already raised by Juno.']);
  });

  it('still delivers a raise about something else, and one to a different reader', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Run 42 failed.', rung: 'dm', about: ['run:42'] });
    await raise(box, otto, { text: 'Run 43 failed.', rung: 'dm', about: ['run:43'] });
    await raise(box, otto, {
      text: 'Run 42, for Ana.',
      rung: 'dm',
      about: ['run:42'],
      to: 'acct-ana',
    });
    expect(dms.map((dm) => dm.text)).toEqual([
      'Run 42 failed.',
      'Run 43 failed.',
      'Run 42, for Ana.',
    ]);
  });

  it('compares against a raise still held for their hours, and forgets after seven days', async () => {
    const box = outbox();
    vi.setSystemTime(Date.parse('2026-10-14T03:00:00Z')); // 23:00, outside hours
    await raise(box, juno, { text: 'Held.', rung: 'dm', about: ['commitment:7'] });
    await raise(box, otto, { text: 'Also held.', rung: 'dm', about: ['commitment:7'] });
    expect(store.heldFor(otto.id)).toHaveLength(0);

    vi.setSystemTime(Date.parse('2026-10-22T14:00:00Z'));
    await raise(box, otto, { text: 'A week on.', rung: 'dm', about: ['commitment:7'] });
    expect(dms.map((dm) => dm.text)).toContain('A week on.');
  });
});

/** Otto raising the same failed run Juno already raised. */
async function raise2(box: BeatOutbox): Promise<void> {
  await raise(box, otto, { text: 'Nightly run 42 failed again.', rung: 'dm', about: ['run:42'] });
}

describe('raise once, then track', () => {
  it('moves a re-raise of an open key to the next report, marked still open', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Acme is 14 days late.', rung: 'dm', key: 'invoice:acme' });
    await raise(box, juno, { text: 'Acme is 15 days late.', rung: 'dm', key: 'invoice:acme' });
    expect(dms.map((dm) => dm.text)).toEqual(['Acme is 14 days late.']);
    expect(raises.queuedItems(juno.id)).toMatchObject([
      { kind: 'still-open', key: 'invoice:acme', text: 'Still open: Acme is 15 days late.' },
    ]);
    expect(lines('heartbeat.deduplicated')).toEqual([
      'Already raised and still open, so it goes in the next report.',
    ]);
  });

  it('sends it again once the person replied in that DM', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Acme is late.', rung: 'dm', key: 'invoice:acme' });
    entry('reply-1', 100, 'author-person', Date.now() + 60_000);
    vi.advanceTimersByTime(120_000);
    await raise(box, juno, { text: 'Acme is late again.', rung: 'dm', key: 'invoice:acme' });
    expect(dms.map((dm) => dm.text)).toEqual(['Acme is late.', 'Acme is late again.']);
    expect(
      db
        .select()
        .from(heartbeatOutbox)
        .all()
        .map((row) => row.state)
    ).toEqual(['resolved', 'delivered']);
  });

  it('is not closed by the agent posting again in the same DM', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Acme is late.', rung: 'dm', key: 'invoice:acme' });
    entry('agent-again', 100, 'author-agent', Date.now() + 60_000);
    expect(raises.closeAnswered(juno.id)).toBe(0);
    expect(raises.openRaises(juno.id)).toHaveLength(1);
  });

  it('closes on end_beat.resolved, and after fourteen days with no answer', async () => {
    const box = outbox();
    await raise(
      box,
      juno,
      { text: 'A.', rung: 'dm', key: 'a' },
      { text: 'B.', rung: 'dm', key: 'b' }
    );
    box.resolve(juno.id, ['a']);
    expect(raises.openRaises(juno.id).map((row) => row.key)).toEqual(['b']);

    vi.setSystemTime(TUESDAY_10AM + OPEN_RAISE_MAX_MS + 60_000);
    await box.tick();
    expect(raises.openRaises(juno.id)).toEqual([]);
  });

  it('lets an urgent raise of something first raised as routine go now', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Card declined.', rung: 'dm', key: 'billing' });
    await raise(box, juno, {
      text: 'Card declined; site goes down at noon.',
      rung: 'dm',
      key: 'billing',
      urgent: true,
    });
    expect(dms).toHaveLength(2);
  });
});

describe('the report rung', () => {
  it('queues a report raise for the next report instead of sending it', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Sent the second reminder.', rung: 'report', about: ['run:9'] });
    expect(dms).toEqual([]);
    expect(raises.queuedItems(juno.id)).toMatchObject([
      { kind: 'raise', text: 'Sent the second reminder.', toAccount: null },
    ]);
    // A queued line cancels another report line, never a message of its own.
    await raise(box, otto, { text: 'Run 9 failed.', rung: 'dm', about: ['run:9'] });
    expect(dms.map((dm) => dm.text)).toEqual(['Run 9 failed.']);
    await raise(box, otto, {
      text: 'Run 9, for the report.',
      rung: 'report',
      about: ['run:9'],
      key: 'run-9-report',
    });
    expect(raises.queuedItems(otto.id)).toEqual([]);
    expect(lines('heartbeat.deduplicated')).toEqual(['Already raised by Juno.']);
  });

  it('drops a queued line on end_beat.resolved', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Waiting on legal.', rung: 'report', key: 'legal' });
    box.resolve(juno.id, ['legal']);
    expect(raises.queuedItems(juno.id)).toEqual([]);
    expect(db.select().from(heartbeatReportItems).all()[0]!.state).toBe('resolved');
  });
});

describe('away', () => {
  it('sends a raise to an away manager one step up when someone is above them', async () => {
    awayPeople.set('acct-owner', null);
    const box = outbox({ personAbove: (id) => (id === 'acct-owner' ? 'acct-boss' : null) });
    await raise(box, juno, { text: 'Acme is late.', rung: 'dm' });
    expect(dms).toEqual([{ agent: juno.id, to: 'acct-boss', text: 'Acme is late.' }]);
    expect(lines('heartbeat.raised')).toContain('Its reader is away, so it went one step up.');
  });

  it('at the top of the chain, sends an urgent raise now and holds a routine one for their return', async () => {
    const back = '2026-10-16T13:00:00Z';
    awayPeople.set('acct-owner', back);
    const box = outbox();
    await raise(box, juno, { text: 'The site is down.', rung: 'dm', urgent: true });
    await raise(box, juno, { text: 'Acme paid.', rung: 'dm' });
    expect(dms.map((dm) => dm.text)).toEqual(['The site is down.']);
    expect(store.heldFor(juno.id)).toMatchObject([
      { text: 'Acme paid.', deliverAfter: new Date(back).toISOString() },
    ]);
    expect(lines('heartbeat.raised')).toContain(
      'Its reader is away; urgent, so it was not held for their return.'
    );
    expect(lines('heartbeat.held')).toContain('Its reader is away; it waits for their return.');
  });

  it('never sends a report line up past an away manager', async () => {
    awayPeople.set('acct-owner', null);
    const box = outbox({ personAbove: () => 'acct-boss' });
    await raise(box, juno, { text: 'Weekly numbers are in.', rung: 'report' });
    expect(dms).toEqual([]);
    expect(raises.queuedItems(juno.id)).toHaveLength(1);
  });
});

describe('review round 1', () => {
  it('is not closed by someone other than its reader, nor by a reply in a channel', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Acme is late.', rung: 'dm', key: 'invoice:acme' });
    entry('stranger', 100, 'author-stranger', Date.now() + 60_000);
    expect(raises.closeAnswered()).toBe(0);
    // The same reader, but the raise's message sits in a channel.
    db.insert(rooms)
      .values({
        id: 'room-channel',
        kind: 'channel',
        title: 'general',
        createdAt: '2026-10-01T00:00:00Z',
        lastActivityAt: '2026-10-01T00:00:00Z',
      } as never)
      .run();
    db.update(roomEntries).set({ roomId: 'room-channel' }).run();
    entry('reply-in-channel', 101, 'author-person', Date.now() + 60_000);
    db.update(roomEntries).set({ roomId: 'room-channel' }).run();
    expect(raises.closeAnswered()).toBe(0);
    expect(raises.openRaises(juno.id)).toHaveLength(1);
  });

  it('drops an urgent raise only for another urgent one, and never for a settled one', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Card declined.', rung: 'dm', about: ['billing'] });
    await raise(box, otto, {
      text: 'Card declined; site down at noon.',
      rung: 'dm',
      about: ['billing'],
      urgent: true,
    });
    expect(dms).toHaveLength(2);
    await raise(box, juno, { text: 'Disk full.', rung: 'dm', about: ['disk'], key: 'disk' });
    box.resolve(juno.id, ['disk']);
    await raise(box, otto, { text: 'Disk full again.', rung: 'dm', about: ['disk'] });
    expect(dms.map((dm) => dm.text)).toContain('Disk full again.');
  });

  it('never treats the agent’s own earlier raise as another agent’s', async () => {
    const box = outbox();
    await raise(box, juno, { text: 'Run 1 failed.', rung: 'dm', about: ['run:1'], key: 'a' });
    await raise(box, juno, { text: 'Run 1 fixed itself.', rung: 'dm', about: ['run:1'], key: 'b' });
    expect(dms).toHaveLength(2);
    expect(lines('heartbeat.deduplicated')).toEqual([]);
  });
});
