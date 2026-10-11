/**
 * Manners (spec `heartbeats` §9, PR 3 items): rungs, hours, urgent, batching
 * per agent, agent recipients — over a real database with a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, heartbeatOutbox, type Db } from '@dorkos/db';
import { resolveWorkingHours } from '@dorkos/shared/working-hours';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { HeartbeatStore } from '../heartbeat-store.js';
import {
  BeatOutbox,
  DELIVERY_BACKOFF_MS,
  URGENT_PER_PERSON_PER_HOUR,
  deliveryTime,
  raiseKey,
  type OutboxDeps,
} from '../outbox.js';
import type { BeatAgent } from '../beat-runner.js';

/** Monday 23:00 in New York. */
const MONDAY_11PM = Date.parse('2026-10-13T03:00:00Z');
/** Tuesday 09:00 in New York. */
const TUESDAY_9AM = Date.parse('2026-10-13T13:00:00Z');
const HOURS = resolveWorkingHours({ timezone: 'America/New_York', workingHours: null });

const juno: BeatAgent = { id: 'agent-juno', name: 'Juno', runtime: 'doe', projectPath: '/a/juno' };
const otto: BeatAgent = { id: 'agent-otto', name: 'Otto', runtime: 'doe', projectPath: '/a/otto' };

let db: Db;
let store: HeartbeatStore;
let dms: Array<{ agent: string; text: string }>;
let notes: Array<{ agent: string; text: string }>;
let posts: Array<{ roomId: string; text: string }>;
let agentSends: Array<{ to: string; text: string }>;
let away: { until: string | null } | null;
let heartbeatsOn = true;
let ids = 0;

/** The outbox over fakes. */
function outbox(overrides: Partial<OutboxDeps> = {}): BeatOutbox {
  return new BeatOutbox({
    store,
    managerOf: () => 'acct-owner',
    chainPersonOf: () => 'acct-owner',
    isAgent: (id) => id.startsWith('agent-'),
    presenceOf: () => ({ hours: HOURS, away }),
    postToRoom: (_agent, roomId, text) => {
      posts.push({ roomId, text });
      return { ok: true, entryId: 'entry-room' };
    },
    deliverDm: async (agent, _to, text) => {
      dms.push({ agent: agent.id, text });
      return { ok: true, entryId: `dm-${dms.length}` };
    },
    deliverNote: async (agent, _to, text) => {
      notes.push({ agent: agent.id, text });
      return { ok: true };
    },
    sendToAgent: async (_agent, _chat, to, text) => {
      agentSends.push({ to, text });
      return { ok: true };
    },
    agentOf: (id) => [juno, otto].find((agent) => agent.id === id),
    roomReachesPerson: (roomId) => roomId.startsWith('dm-'),
    enabled: () => heartbeatsOn,
    mintId: () => `row-${++ids}`,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    ...overrides,
  });
}

/** Audit rows for one action. */
function rows(action: string) {
  return db
    .select()
    .from(auditEvents)
    .all()
    .filter((row) => row.action === action);
}

beforeEach(() => {
  vi.useFakeTimers({ now: MONDAY_11PM });
  db = createTestDb();
  store = new HeartbeatStore(db);
  dms = [];
  notes = [];
  posts = [];
  agentSends = [];
  away = null;
  heartbeatsOn = true;
  ids = 0;
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

describe('hours', () => {
  it('holds a non-urgent dm raised at 23:00 until 09:00 on the next working day', async () => {
    const box = outbox();
    box.start();
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'chat',
      raises: [{ text: 'Acme paid the invoice.', rung: 'dm' }],
    });
    expect(dms).toEqual([]);
    expect(rows('heartbeat.held')).toHaveLength(1);
    expect(store.heldFor(juno.id)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TUESDAY_9AM - MONDAY_11PM - 60_000);
    expect(dms).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(dms).toEqual([{ agent: juno.id, text: 'Acme paid the invoice.' }]);
    expect(rows('heartbeat.delivered')).toHaveLength(1);
    box.stop();
  });

  it('sends an urgent raise at once, and records its text', async () => {
    await outbox().accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'chat',
      raises: [{ text: 'Payments are failing for every customer.', rung: 'dm', urgent: true }],
    });
    expect(dms).toEqual([{ agent: juno.id, text: 'Payments are failing for every customer.' }]);
    expect(rows('heartbeat.raised')[0]!.reason).toBe('Payments are failing for every customer.');
  });

  it('holds while the person is away, until the start of their hours after they return', () => {
    away = { until: '2026-10-15T12:00:00Z' };
    const when = deliveryTime({ hours: HOURS, away }, MONDAY_11PM);
    expect(new Date(when).toISOString()).toBe('2026-10-15T13:00:00.000Z');
  });
});

describe('batching per agent', () => {
  it('delivers two raises from one agent that come due together as one message, one per agent', async () => {
    const box = outbox();
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'chat',
      raises: [
        { text: 'First thing.', rung: 'dm' },
        { text: 'Second thing.', rung: 'report' },
      ],
    });
    await box.accept({
      agent: otto,
      beatId: 'b2',
      chatSessionId: 'chat2',
      raises: [{ text: 'Otto thing.', rung: 'dm' }],
    });
    vi.setSystemTime(TUESDAY_9AM);
    await box.tick();
    expect(dms).toEqual([
      { agent: juno.id, text: 'First thing.\n\nSecond thing.' },
      { agent: otto.id, text: 'Otto thing.' },
    ]);
    expect(
      db
        .select()
        .from(heartbeatOutbox)
        .all()
        .every((row) => row.state === 'delivered')
    ).toBe(true);
  });
});

describe('rungs and readers', () => {
  it('posts a room raise now and sends a raise to an agent as a report at once, at any hour', async () => {
    await outbox().accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'chat',
      raises: [
        { text: 'Build is green again.', rung: 'room', roomId: 'r-eng' },
        { text: 'Can you take the Acme follow-up?', rung: 'dm', to: 'agent-otto' },
      ],
    });
    expect(posts).toEqual([{ roomId: 'r-eng', text: 'Build is green again.' }]);
    expect(agentSends).toEqual([{ to: 'agent-otto', text: 'Can you take the Acme follow-up?' }]);
    expect(dms).toEqual([]);
  });

  it('sends a note the way relay_notify_user does, and closes a raise the agent resolved', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    const box = outbox();
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'chat',
      raises: [{ text: 'Done with the report.', rung: 'note' }],
    });
    expect(notes).toEqual([{ agent: juno.id, text: 'Done with the report.' }]);

    vi.setSystemTime(MONDAY_11PM + 7 * 24 * 60 * 60_000);
    await box.accept({
      agent: juno,
      beatId: 'b2',
      chatSessionId: 'chat',
      raises: [{ text: 'Later news.', rung: 'dm', key: 'k-later' }],
    });
    box.resolve(juno.id, ['k-later']);
    expect(store.heldFor(juno.id)).toEqual([]);
  });

  it('keys a raise by its key, then its sorted about keys, then its text', () => {
    expect(raiseKey({ text: 'x', rung: 'dm', key: 'given' })).toBe('given');
    expect(raiseKey({ text: 'x', rung: 'dm', about: ['run:2', 'run:1'] })).toBe('run:1|run:2');
    expect(raiseKey({ text: 'x', rung: 'dm' })).toBe(raiseKey({ text: 'x', rung: 'note' }));
  });

  it("raises a failing agent's beats once to its chain person, not urgent", async () => {
    await outbox().raiseFailing(juno, 'b9');
    const [row] = db.select().from(heartbeatOutbox).all();
    expect(row).toMatchObject({
      key: 'beat-failing:agent-juno',
      urgent: 0,
      toAccount: 'acct-owner',
    });
  });
});

describe('the failing-beats raise', () => {
  it('says what the error was', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    await outbox().raiseFailing(juno, 'b9', 'Rate limited by the model provider.');
    expect(dms[0]!.text).toContain('Rate limited by the model provider.');
  });
});

describe('room raises that reach a person', () => {
  it('holds a non-urgent post into a DM room for their hours', async () => {
    const box = outbox();
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'chat',
      raises: [{ text: 'Invoice sent.', rung: 'room', roomId: 'dm-dorian' }],
    });
    expect(posts).toEqual([]);
    vi.setSystemTime(TUESDAY_9AM);
    await box.tick();
    expect(posts).toEqual([{ roomId: 'dm-dorian', text: 'Invoice sent.' }]);
  });

  it('sends a refused room post to the manager as a held DM, and records it', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    await outbox({ postToRoom: () => ({ ok: false, reason: 'not a member' }) }).accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'chat',
      raises: [{ text: 'Build is green.', rung: 'room', roomId: 'r-eng' }],
    });
    expect(dms).toEqual([{ agent: juno.id, text: 'Build is green.' }]);
    expect(rows('heartbeat.held').some((row) => row.reason === 'not a member')).toBe(true);
  });
});

describe('the urgent ceiling', () => {
  it('sends six urgent raises to one person an hour, and holds the seventh to the window end', async () => {
    const box = outbox();
    const urgent = (i: number) => ({
      text: `Urgent ${i}`,
      rung: 'dm' as const,
      urgent: true,
      key: `u${i}`,
    });
    for (let i = 0; i < URGENT_PER_PERSON_PER_HOUR + 1; i += 1) {
      await box.accept({
        agent: i % 2 ? juno : otto,
        beatId: `b${i}`,
        chatSessionId: 'c',
        raises: [urgent(i)],
      });
      vi.advanceTimersByTime(1000);
    }
    expect(dms).toHaveLength(URGENT_PER_PERSON_PER_HOUR);
    expect(rows('heartbeat.held').some((row) => row.reason === 'ceiling')).toBe(true);
    vi.setSystemTime(MONDAY_11PM + 60 * 60_000 + 10_000);
    await box.tick();
    expect(dms).toHaveLength(URGENT_PER_PERSON_PER_HOUR + 1);
  });
});

describe('delivery that fails', () => {
  it('tries again at 1, 5, 15 and 60 minutes, then drops it with a record line', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    let tries = 0;
    const box = outbox({
      deliverDm: async () => {
        tries += 1;
        return { ok: false, reason: 'room gone' };
      },
    });
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'c',
      raises: [{ text: 'x', rung: 'dm' }],
    });
    expect(tries).toBe(1);
    for (const delay of DELIVERY_BACKOFF_MS) {
      vi.setSystemTime(Date.now() + delay);
      await box.tick();
    }
    expect(tries).toBe(5);
    const [row] = db.select().from(heartbeatOutbox).all();
    expect(row!.state).toBe('dropped');
    expect(rows('heartbeat.raised').some((r) => r.outcome === 'failed')).toBe(true);
  });
});

describe('a raise re-sent while held', () => {
  it('replaces the held one rather than queueing a second', async () => {
    const box = outbox();
    for (const text of ['First draft.', 'Second draft.']) {
      await box.accept({
        agent: juno,
        beatId: 'b',
        chatSessionId: 'c',
        raises: [{ text, rung: 'dm', key: 'k' }],
      });
    }
    expect(store.heldFor(juno.id).map((row) => row.text)).toEqual(['Second draft.']);
  });
});

describe('heartbeats off', () => {
  it('delivers nothing while off, and everything once on again', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    heartbeatsOn = false;
    const box = outbox();
    await box.accept({
      agent: juno,
      beatId: 'b',
      chatSessionId: 'c',
      raises: [{ text: 'x', rung: 'dm' }],
    });
    expect(dms).toEqual([]);
    heartbeatsOn = true;
    await box.tick();
    expect(dms).toHaveLength(1);
  });
});

describe('the urgent ceiling, counted by when messages arrive', () => {
  const urgent = (i: number, rung: 'dm' | 'room' = 'dm') => ({
    text: `Urgent ${i}`,
    rung,
    urgent: true,
    key: `u${i}`,
    ...(rung === 'room' ? { roomId: 'r-eng' } : {}),
  });

  it('counts an urgent room post against the same hour, and holds it past the ceiling', async () => {
    const box = outbox();
    for (let i = 0; i < URGENT_PER_PERSON_PER_HOUR; i += 1) {
      await box.accept({ agent: juno, beatId: `b${i}`, chatSessionId: 'c', raises: [urgent(i)] });
    }
    await box.accept({
      agent: otto,
      beatId: 'b-room',
      chatSessionId: 'c',
      raises: [urgent(9, 'room')],
    });
    expect(posts).toEqual([]);
    vi.setSystemTime(MONDAY_11PM + 60 * 60_000);
    await box.tick();
    expect(posts).toEqual([{ roomId: 'r-eng', text: 'Urgent 9' }]);
  });

  it('counts urgent room posts that went out, so a DM after six of them waits', async () => {
    const box = outbox();
    for (let i = 0; i < URGENT_PER_PERSON_PER_HOUR; i += 1) {
      await box.accept({
        agent: juno,
        beatId: `b${i}`,
        chatSessionId: 'c',
        raises: [urgent(i, 'room')],
      });
    }
    expect(posts).toHaveLength(URGENT_PER_PERSON_PER_HOUR);
    await box.accept({ agent: otto, beatId: 'b-dm', chatSessionId: 'c', raises: [urgent(9)] });
    expect(dms).toEqual([]);
  });

  it('counts a raise held past the ceiling when it arrives, so the next hour gets no second burst', async () => {
    const box = outbox();
    for (let i = 0; i <= URGENT_PER_PERSON_PER_HOUR; i += 1) {
      await box.accept({ agent: juno, beatId: `b${i}`, chatSessionId: 'c', raises: [urgent(i)] });
    }
    expect(dms).toHaveLength(URGENT_PER_PERSON_PER_HOUR);
    // The seventh arrives as the first hour ends.
    vi.setSystemTime(MONDAY_11PM + 60 * 60_000);
    await box.tick();
    expect(dms).toHaveLength(URGENT_PER_PERSON_PER_HOUR + 1);
    // Six more right after it: only five fit beside it in this hour.
    for (let i = 10; i < 10 + URGENT_PER_PERSON_PER_HOUR; i += 1) {
      await box.accept({ agent: otto, beatId: `b${i}`, chatSessionId: 'c', raises: [urgent(i)] });
    }
    expect(dms).toHaveLength(URGENT_PER_PERSON_PER_HOUR * 2);
  });
});

describe('a re-sent raise on another rung', () => {
  it('never moves a DM’s words into a room raise with the same key, or the reverse', async () => {
    const box = outbox();
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'c',
      raises: [{ text: 'Private: the Acme contract fell through.', rung: 'dm', key: 'acme' }],
    });
    await box.accept({
      agent: juno,
      beatId: 'b2',
      chatSessionId: 'c',
      raises: [
        { text: 'Acme update for the team.', rung: 'room', roomId: 'dm-team', key: 'acme' },
        { text: 'Acme update for the board.', rung: 'room', roomId: 'dm-board', key: 'acme' },
        { text: 'Acme, by note.', rung: 'note', key: 'acme' },
      ],
    });
    const held = store.heldFor(juno.id).map((row) => [row.rung, row.roomId, row.text]);
    expect(held).toEqual([
      ['dm', null, 'Private: the Acme contract fell through.'],
      ['room', 'dm-team', 'Acme update for the team.'],
      ['room', 'dm-board', 'Acme update for the board.'],
      ['note', null, 'Acme, by note.'],
    ]);
  });
});

describe('a report to another agent that fails', () => {
  it('is held and tried again, not dropped', async () => {
    let fail = true;
    const box = outbox({
      sendToAgent: async (_agent, chat, to, text) => {
        if (fail) return { ok: false, reason: 'chat messages are not running' };
        agentSends.push({ to, text: `${text} (from ${chat})` });
        return { ok: true };
      },
    });
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'beat-chat',
      raises: [{ text: 'Can you take Acme?', rung: 'dm', to: 'agent-otto' }],
    });
    expect(agentSends).toEqual([]);
    fail = false;
    vi.setSystemTime(MONDAY_11PM + DELIVERY_BACKOFF_MS[0]!);
    await box.tick();
    expect(agentSends).toEqual([{ to: 'agent-otto', text: 'Can you take Acme? (from beat-chat)' }]);
  });
});

describe('open raises', () => {
  it('lists what was delivered to people and not resolved, and drops it once resolved', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    const box = outbox();
    await box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'c',
      raises: [
        { text: 'Acme has not paid.', rung: 'dm', key: 'acme-unpaid' },
        { text: 'Build is red.', rung: 'room', roomId: 'r-eng', key: 'build-red' },
        { text: 'Can you take Acme?', rung: 'dm', to: 'agent-otto', key: 'otto-acme' },
      ],
    });
    expect(agentSends).toHaveLength(1);
    expect(
      box
        .openRaises(juno.id)
        .map((raise) => raise.key)
        .sort()
    ).toEqual(['acme-unpaid', 'build-red']);
    box.resolve(juno.id, ['acme-unpaid']);
    expect(box.openRaises(juno.id).map((raise) => raise.key)).toEqual(['build-red']);
  });
});

describe('an urgent raise accepted mid-tick', () => {
  it('goes out before accept resolves, not at the next tick', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const box = outbox({
      deliverDm: async (agent, _to, text) => {
        if (first) {
          first = false;
          await gate;
        }
        dms.push({ agent: agent.id, text });
        return { ok: true };
      },
    });
    const slow = box.accept({
      agent: juno,
      beatId: 'b1',
      chatSessionId: 'c',
      raises: [{ text: 'Weekly numbers.', rung: 'dm', key: 'weekly' }],
    });
    await Promise.resolve();
    const urgentOne = box.accept({
      agent: otto,
      beatId: 'b2',
      chatSessionId: 'c',
      raises: [{ text: 'The site is down.', rung: 'dm', urgent: true, key: 'down' }],
    });
    release();
    await Promise.all([slow, urgentOne]);
    expect(dms.map((dm) => dm.text)).toEqual(['Weekly numbers.', 'The site is down.']);
  });
});

describe('stopping and starting the outbox mid-tick', () => {
  it('leaves one tick chain, not two', async () => {
    vi.setSystemTime(TUESDAY_9AM);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const box = outbox({
      deliverDm: async () => {
        await gate;
        return { ok: true };
      },
    });
    store.insertOutbox({
      id: 'due',
      agentId: juno.id,
      beatId: 'b',
      toAccount: 'acct-owner',
      rung: 'dm',
      text: 'x',
      key: 'k',
      about: null,
      urgent: 0,
      roomId: null,
      deliverAfter: new Date(TUESDAY_9AM).toISOString(),
      state: 'held',
      createdAt: new Date(TUESDAY_9AM).toISOString(),
    });
    box.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // The tick is stuck mid-delivery; heartbeats go off and on again.
    box.stop();
    box.start();
    release();
    await vi.advanceTimersByTimeAsync(0);
    box.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
