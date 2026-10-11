/**
 * The report beat (spec `heartbeats` §3.4, §9.3, §10 PR 4 tests): the runner,
 * the real outbox and report queue over a real database, a fake clock, and a
 * launcher that drives a `FakeAgentRuntime`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { auditEvents, heartbeatBeats, heartbeatReportItems, type Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { EndBeatInput } from '@dorkos/shared/heartbeat-schemas';
import { resolveWorkingHours } from '@dorkos/shared/working-hours';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { HeartbeatStore } from '../../heartbeat-store.js';
import { RaiseStore } from '../raise-store.js';
import { BeatOutbox } from '../../outbox.js';
import { BeatRunner, type BeatAgent } from '../../beat-runner.js';
import type { BeatTurnLauncher } from '../../beat-launch.js';
import { endBeatTurn, registerBeatTurn, resetBeatTurns } from '../../beat-turns.js';
import { queueManagerChange } from '../report-beat.js';
import { nextReportSlot, reportBeatAt } from '../report-clock.js';
import { REPORT_TURNS_MAX, reportMaterial } from '../report-material.js';
import { DELIVERY_BACKOFF_MS } from '../../outbox.js';
import { createDeliveries } from '../../heartbeat-adapters.js';
import type { GathererRegistry } from '../../gatherers/index.js';

/** Monday 08:00 in New York, an hour before the working day starts. */
const MONDAY_8AM = Date.parse('2026-10-12T12:00:00Z');
/** Monday 09:00 in New York. */
const MONDAY_9AM = Date.parse('2026-10-12T13:00:00Z');
const HOURS = resolveWorkingHours({ timezone: 'America/New_York', workingHours: null });

const juno: BeatAgent = {
  id: 'agent-juno',
  name: 'Juno',
  runtime: 'claude-code',
  projectPath: '/a/juno',
};

let db: Db;
let store: HeartbeatStore;
let raises: RaiseStore;
let runtime: FakeAgentRuntime;
let launches: string[];
let dms: Array<{ to: string; text: string }>;
let agentSends: Array<{ to: string; text: string }>;
let manager: string;
let away: { until: string | null } | null;
let currentSession = '';
let dmFails = false;
let box: BeatOutbox;
let ids = 0;

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A launcher that runs the turn on the fake runtime. */
function launcher(): BeatTurnLauncher {
  return {
    async launch(request) {
      launches.push(request.content);
      currentSession = request.sessionId;
      void (async () => {
        for await (const _event of runtime.sendMessage(request.sessionId, request.content)) {
          // Drain the turn.
        }
        request.onSettled('ok');
      })();
      return { status: 'started', sessionId: request.sessionId };
    },
    isBusy: () => false,
    lastError: () => null,
    rename: async () => undefined,
  };
}

/** A turn that ends the beat with this input. */
function endsWith(input: EndBeatInput) {
  return async function* (): AsyncGenerator<StreamEvent> {
    endBeatTurn(currentSession, input);
    yield { type: 'text_delta', data: { text: 'done' } } as StreamEvent;
  };
}

/** The runner over the real outbox and report queue. */
function runner(gatherers: GathererRegistry = {}): BeatRunner {
  const presenceOf = () => ({ hours: HOURS, away });
  const isAgent = (id: string) => id.startsWith('agent-');
  const outbox = new BeatOutbox({
    store,
    raises,
    managerOf: () => manager,
    chainPersonOf: () => 'acct-owner',
    isAgent,
    presenceOf,
    postToRoom: () => ({ ok: true }),
    deliverDm: async (_agent, to, text) => {
      if (dmFails) return { ok: false, reason: 'down' };
      dms.push({ to, text });
      return { ok: true };
    },
    deliverNote: async () => ({ ok: true }),
    sendToAgent: async (_agent, _chat, to, text) => {
      agentSends.push({ to, text });
      return { ok: true };
    },
    agentOf: (id) => (id === juno.id ? juno : undefined),
    roomReachesPerson: () => false,
    enabled: () => true,
    clock,
  });
  box = outbox;
  return new BeatRunner({
    store,
    agents: { list: () => [juno], get: (id) => (id === juno.id ? juno : undefined) },
    runtimeRegistered: () => true,
    enabled: () => true,
    hoursFor: () => HOURS,
    gatherers,
    commitments: { list: () => [] },
    launcher: launcher(),
    outbox,
    readHeartbeat: async () => ({ kind: 'absent' }),
    random: () => 0.5,
    mintId: () => `id-${++ids}`,
    clock,
    reports: {
      raises,
      managerOf: () => manager,
      isAgent,
      presenceOf,
      nameOf: (id) => (id === 'agent-ana' ? 'Ana' : 'Dorian'),
    },
  });
}

/** Every report beat row. */
function reportBeats() {
  return db
    .select()
    .from(heartbeatBeats)
    .all()
    .filter((row) => row.kind === 'report');
}

/** Queue one line for Juno's report. */
function queue(text: string): void {
  raises.queueItem(
    `item-${++ids}`,
    { agentId: juno.id, kind: 'raise', text },
    new Date().toISOString()
  );
}

/** Let async work settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ now: MONDAY_8AM });
  db = createTestDb();
  store = new HeartbeatStore(db);
  raises = new RaiseStore(db);
  runtime = new FakeAgentRuntime('claude-code');
  launches = [];
  dms = [];
  agentSends = [];
  manager = 'acct-owner';
  away = null;
  dmFails = false;
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
  resetBeatTurns();
  vi.useRealTimers();
});

describe('when a report beat runs', () => {
  it('arms an agent that wakes only on events for the start of its person’s day', async () => {
    const r = runner();
    await r.start();
    expect(r.nextReportAt(juno.id)?.getTime()).toBe(MONDAY_9AM);
    r.stop();
  });

  it('skips the turn when the queue is empty and no beat turn ran, with a quiet record line', async () => {
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(launches).toEqual([]);
    expect(reportBeats()).toMatchObject([
      { outcome: 'quiet', summary: 'Nothing new to report.', wake: 'event:report-due' },
    ]);
    // The next one is Tuesday's start, not a retry.
    expect(r.nextReportAt(juno.id)?.toISOString()).toBe('2026-10-13T13:00:00.000Z');
    r.stop();
  });
});

describe('delivering a report', () => {
  it('reaches a person at the start of their hours, and clears what went into it', async () => {
    queue('Sent Acme the second reminder.');
    runtime.withScenarios([endsWith({ summary: 'Reported.', report: 'Finished: Acme reminder.' })]);
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM - 60_000);
    expect(dms).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('This is your report beat. Write one short report for Dorian.');
    expect(launches[0]).toContain('Sent Acme the second reminder.');
    expect(dms).toEqual([{ to: 'acct-owner', text: 'Finished: Acme reminder.' }]);
    expect(raises.queuedItems(juno.id)).toEqual([]);
    expect(store.getState(juno.id)?.lastReportAt).toBe(new Date(MONDAY_9AM).toISOString());
    expect(reportBeats()).toMatchObject([{ outcome: 'worked', summary: 'Reported.' }]);
    r.stop();
  });

  it('reaches an agent manager at once as a report-kind chat message', async () => {
    manager = 'agent-ana';
    queue('Two invoices are overdue.');
    runtime.withScenarios([endsWith({ summary: 'Reported.', report: 'At risk: two invoices.' })]);
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(launches[0]).toContain('Write one short report for Ana.');
    expect(agentSends).toEqual([{ to: 'agent-ana', text: 'At risk: two invoices.' }]);
    expect(dms).toEqual([]);
    r.stop();
  });

  it('carries everything over when the turn passes report: null', async () => {
    queue('A small thing.');
    runtime.withScenarios([endsWith({ summary: 'Nothing worth it.', report: null })]);
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(launches).toHaveLength(1);
    expect(dms).toEqual([]);
    expect(raises.queuedItems(juno.id)).toHaveLength(1);
    expect(store.getState(juno.id)?.lastReportAt ?? null).toBeNull();
    r.stop();
  });

  it('waits for an away manager instead of sending the report up the chain', async () => {
    queue('A small thing.');
    const r = runner();
    await r.start();
    expect(r.nextReportAt(juno.id)?.getTime()).toBe(MONDAY_9AM);
    // They say they are away after the report was armed.
    away = { until: '2026-10-14T13:00:00Z' };
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(launches).toEqual([]);
    expect(reportBeats()).toMatchObject([
      { outcome: 'skipped', summary: 'Its manager is away; the report waits for their return.' },
    ]);
    // Owed, so it runs when they are back.
    expect(r.nextReportAt(juno.id)?.toISOString()).toBe('2026-10-14T13:00:00.000Z');
    r.stop();
  });
});

describe('end_beat.report', () => {
  it('is refused outside a report beat', () => {
    registerBeatTurn('chat', { agentId: juno.id, beatId: 'b1', messageId: 'm1', kind: 'pulse' });
    expect(endBeatTurn('chat', { summary: 'x', report: 'A report.' })).toEqual({
      ok: false,
      code: 'NOT_A_REPORT_BEAT',
    });
    // Leaving it out, or skipping, is fine anywhere.
    expect(endBeatTurn('chat', { summary: 'x', report: null })).toMatchObject({ ok: true });
  });
});

describe('reports-to changes', () => {
  it('queue a line for the new manager and one for the old', () => {
    queueManagerChange(
      {
        raises,
        managerOf: () => 'agent-ana',
        nameOf: () => 'Ana',
        exists: () => true,
        canonical: (id: string) => id,
      },
      {
        agentId: juno.id,
        before: 'agent-otto',
        id: 'i1',
        oldLineId: 'i2',
        at: '2026-10-12T12:00:00Z',
      }
    );
    expect(db.select().from(heartbeatReportItems).all()).toMatchObject([
      { kind: 'reports-to', text: 'Now reports to Ana.', toAccount: null },
      { kind: 'reports-to', text: 'Now reports to Ana.', toAccount: 'agent-otto' },
    ]);
  });

  it('send the old manager’s line when the report goes', async () => {
    manager = 'acct-owner';
    queueManagerChange(
      {
        raises,
        managerOf: () => 'acct-owner',
        nameOf: () => 'you',
        exists: () => true,
        canonical: (id: string) => id,
      },
      {
        agentId: juno.id,
        before: 'agent-otto',
        id: 'i1',
        oldLineId: 'i2',
        at: new Date().toISOString(),
      }
    );
    runtime.withScenarios([endsWith({ summary: 'Reported.', report: 'I report to you now.' })]);
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(dms).toEqual([{ to: 'acct-owner', text: 'I report to you now.' }]);
    expect(agentSends).toEqual([{ to: 'agent-otto', text: 'From Juno:\nNow reports to you.' }]);
    expect(
      db
        .select()
        .from(auditEvents)
        .all()
        .some((row) => row.action === 'heartbeat.beat')
    ).toBe(true);
    r.stop();
  });
});

describe('open raises in the beat prompt', () => {
  it('lists every raise still open, and leaves out a delivered report', async () => {
    const row = {
      agentId: juno.id,
      beatId: 'b0',
      toAccount: 'acct-owner',
      rung: 'dm' as const,
      about: null,
      urgent: 0,
      roomId: null,
      deliverAfter: '2026-10-12T11:00:00Z',
      state: 'held' as const,
      createdAt: '2026-10-12T11:00:00Z',
    };
    store.insertOutbox({ ...row, id: 'o1', text: 'Acme is late.', key: 'invoice:acme' });
    store.insertOutbox({ ...row, id: 'o2', text: 'Yesterday’s report.', key: 'report:b0' });
    store.closeOutbox(['o1', 'o2'], 'delivered', '2026-10-12T11:00:00Z');
    runtime.withScenarios([endsWith({ summary: 'Answered.' })]);
    const r = runner({
      addressed: async () => [
        {
          gatherer: 'addressed',
          key: 'room-entry:e1',
          summary: 'Dorian wrote to you directly (room r1).',
          at: '2026-10-12T11:55:00Z',
          signal: 'unanswered',
        },
      ],
    });
    const done = r.wake(juno.id, { wake: 'event:room-mention' });
    await settle();
    await done;
    expect(launches[0]).toContain('Acme is late. [invoice:acme]');
    expect(launches[0]).not.toContain('Yesterday’s report.');
  });
});

describe('the report clock', () => {
  it('runs a weekly report at the start of Monday', () => {
    const friday = Date.parse('2026-10-16T14:00:00Z');
    expect(new Date(nextReportSlot('weekly', HOURS, friday)!).toISOString()).toBe(
      '2026-10-19T13:00:00.000Z'
    );
  });

  it('runs an owed report a few minutes from now, and never before its reader is back', () => {
    const tuesdayNoon = Date.parse('2026-10-13T16:00:00Z');
    const facts = {
      cadence: 'daily' as const,
      hours: HOURS,
      lastAttemptAt: new Date(MONDAY_9AM).toISOString(),
      now: tuesdayNoon,
      random: () => 0,
    };
    expect(reportBeatAt({ ...facts, readerAvailableAt: tuesdayNoon })).toEqual({
      at: tuesdayNoon + 60_000,
      owed: true,
    });
    const back = Date.parse('2026-10-15T13:00:00Z');
    expect(reportBeatAt({ ...facts, readerAvailableAt: back })).toEqual({ at: back, owed: true });
    expect(reportBeatAt({ ...facts, cadence: 'off', readerAvailableAt: tuesdayNoon })).toBeNull();
  });
});

describe('review round 1', () => {
  it('keeps the lines queued until the report arrives, and puts them back if it is dropped', async () => {
    dmFails = true;
    queue('Sent Acme the second reminder.');
    runtime.withScenarios([endsWith({ summary: 'Reported.', report: 'Finished: Acme.' })]);
    const r = runner();
    await r.start();
    box.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(launches).toHaveLength(1);
    // On its way: out of the queue, not reported, and the report time has not moved.
    expect(raises.queuedItems(juno.id)).toEqual([]);
    expect(db.select().from(heartbeatReportItems).all()[0]!.state).toBe('queued');
    expect(store.getState(juno.id)?.lastReportAt ?? null).toBeNull();
    for (const wait of DELIVERY_BACKOFF_MS) await vi.advanceTimersByTimeAsync(wait + 60_000);
    expect(raises.queuedItems(juno.id).map((item) => item.text)).toEqual([
      'Sent Acme the second reminder.',
    ]);
    box.stop();
    r.stop();
  });

  it('marks the lines reported and the report time once it is delivered', async () => {
    queue('Sent Acme the second reminder.');
    runtime.withScenarios([endsWith({ summary: 'Reported.', report: 'Finished: Acme.' })]);
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(db.select().from(heartbeatReportItems).all()[0]!.state).toBe('reported');
    // Covered up to the moment its report beat began.
    expect(store.getState(juno.id)?.lastReportAt).toBe(reportBeats()[0]!.startedAt);
    r.stop();
  });

  it('counts a first report from one report period ago, and caps its beat lines', () => {
    const now = MONDAY_9AM;
    const beat = (id: string, hoursAgo: number) => {
      store.insertBeat({
        id,
        agentId: juno.id,
        startedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
        kind: 'pulse',
        wake: 'timer',
      });
      store.finishBeat(id, { outcome: 'worked', summary: `Beat ${id}.`, turnSessionId: 'chat' });
    };
    beat('old', 72);
    for (let i = 0; i < REPORT_TURNS_MAX + 5; i++) beat(`b${i}`, 1 + i / 100);
    const material = reportMaterial(raises, {
      agentId: juno.id,
      reader: 'acct-owner',
      lastReportAt: null,
      cadence: 'daily',
      now,
    });
    expect(material.turns).toHaveLength(REPORT_TURNS_MAX + 1);
    expect(material.turns.at(-1)).toBe('And 5 earlier beats.');
    expect(material.turns).not.toContain('Beat old.');
    expect(material.count).toBe(REPORT_TURNS_MAX);
  });

  it('arms the next regular start for a manager away with no return date, not an hourly retry', () => {
    const tuesdayNoon = Date.parse('2026-10-13T16:00:00Z');
    expect(
      reportBeatAt({
        cadence: 'daily',
        hours: HOURS,
        lastAttemptAt: '2026-10-12T13:00:00Z',
        readerAvailableAt: null,
        now: tuesdayNoon,
      })
    ).toEqual({ at: Date.parse('2026-10-14T13:00:00Z'), owed: false });
  });

  it('keeps an owed report where it was armed when the agent is re-armed', async () => {
    // Monday's report beat ran; Tuesday's start passed with the server off.
    store.insertBeat({
      id: 'r0',
      agentId: juno.id,
      startedAt: new Date(MONDAY_9AM).toISOString(),
      kind: 'report',
      wake: 'event:report-due',
    });
    store.finishBeat('r0', { outcome: 'quiet', endedAt: new Date(MONDAY_9AM).toISOString() });
    vi.setSystemTime(Date.parse('2026-10-13T16:00:00Z'));
    const r = runner();
    await r.start();
    const armed = r.nextReportAt(juno.id)!.getTime();
    vi.setSystemTime(Date.now() + 60_000);
    await r.refreshAgent(juno.id);
    expect(r.nextReportAt(juno.id)!.getTime()).toBe(armed);
    r.stop();
  });

  it('leaves the pace of timed beats alone', async () => {
    store.patchState(juno.id, { lastBeatAt: '2026-10-12T11:00:00.000Z' });
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(reportBeats()).toHaveLength(1);
    expect(store.getState(juno.id)?.lastBeatAt).toBe('2026-10-12T11:00:00.000Z');
    r.stop();
  });

  it('hands a report over once even when the delivery tick throws', async () => {
    runner();
    vi.spyOn(raises, 'closeAnswered').mockImplementation(() => {
      throw new Error('tick fell over');
    });
    await expect(
      box.deliverReport({
        agent: juno,
        beatId: 'r1',
        chatSessionId: 'chat',
        to: 'acct-owner',
        text: 'Finished: Acme.',
        lineIds: [],
      })
    ).resolves.toBeUndefined();
    expect(store.heldFor(juno.id)).toHaveLength(1);
  });

  it('never lets an agent close its own report by naming its key as resolved', async () => {
    runner();
    vi.spyOn(raises, 'closeAnswered').mockImplementation(() => {
      throw new Error('keep the report held');
    });
    await box.deliverReport({
      agent: juno,
      beatId: 'r1',
      chatSessionId: 'chat',
      to: 'acct-owner',
      text: 'Finished: Acme.',
      lineIds: [],
    });
    box.resolve(juno.id, ['report:r1']);
    expect(store.heldFor(juno.id).map((row) => row.state)).toEqual(['held']);
  });

  it('gives no line to an old manager who no longer exists', () => {
    queueManagerChange(
      {
        raises,
        managerOf: () => 'acct-owner',
        nameOf: () => 'you',
        exists: () => false,
        canonical: (id: string) => id,
      },
      {
        agentId: juno.id,
        before: 'agent-gone',
        id: 'i1',
        oldLineId: 'i2',
        at: new Date().toISOString(),
      }
    );
    expect(db.select().from(heartbeatReportItems).all()).toHaveLength(1);
  });

  it('delivers a DM only to the person it is for', async () => {
    const { deliverDm } = createDeliveries(
      { notifyDm: undefined } as never,
      (id) => id === 'acct-owner'
    );
    expect(await deliverDm(juno, 'agent-gone', 'Hello.')).toEqual({
      ok: false,
      reason:
        'Only the owner can get messages from agents here yet; this person has no DM to land in.',
    });
  });
});

describe('review round 2', () => {
  it('runs an owed report within minutes once an away-with-no-date manager is back', async () => {
    // Its last report beat ran Friday; Monday's start finds the manager away with no date.
    store.insertBeat({
      id: 'r0',
      agentId: juno.id,
      startedAt: '2026-10-09T13:00:00.000Z',
      kind: 'report',
      wake: 'event:report-due',
    });
    store.finishBeat('r0', { outcome: 'quiet', endedAt: '2026-10-09T13:00:00.000Z' });
    away = { until: null };
    queue('A small thing.');
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(reportBeats().at(-1)).toMatchObject({ outcome: 'skipped' });
    vi.setSystemTime(Date.parse('2026-10-12T16:00:00Z')); // noon, back
    away = null;
    await r.refreshReport(juno.id);
    expect(r.nextReportAt(juno.id)!.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    r.stop();
  });

  it('sets the report time to when its report beat began, not when it finally arrived', async () => {
    dmFails = true;
    queue('Sent Acme the second reminder.');
    runtime.withScenarios([endsWith({ summary: 'Reported.', report: 'Finished: Acme.' })]);
    const r = runner();
    await r.start();
    box.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    dmFails = false;
    await vi.advanceTimersByTimeAsync(DELIVERY_BACKOFF_MS[0]! + 60_000);
    expect(dms).toEqual([{ to: 'acct-owner', text: 'Finished: Acme.' }]);
    expect(store.getState(juno.id)?.lastReportAt).toBe(new Date(MONDAY_9AM).toISOString());
    box.stop();
    r.stop();
  });

  it('gives no second line to an old manager named by another of the same person’s ids', () => {
    queueManagerChange(
      {
        raises,
        managerOf: () => 'acct-owner',
        nameOf: () => 'you',
        exists: () => true,
        canonical: (id) => (id === 'install:1' ? 'acct-owner' : id),
      },
      {
        agentId: juno.id,
        before: 'install:1',
        id: 'i1',
        oldLineId: 'i2',
        at: new Date().toISOString(),
      }
    );
    expect(db.select().from(heartbeatReportItems).all()).toHaveLength(1);
  });

  it('sends an old manager their line even when the reader has nothing new', async () => {
    raises.queueItem(
      'i2',
      {
        agentId: juno.id,
        kind: 'reports-to',
        text: 'Now reports to you.',
        toAccount: 'agent-otto',
        key: 'reports-to:agent-otto',
      },
      new Date().toISOString()
    );
    store.patchState(juno.id, { beatChatId: 'chat-today' });
    const r = runner();
    await r.start();
    await vi.advanceTimersByTimeAsync(MONDAY_9AM - MONDAY_8AM);
    await settle();
    expect(launches).toEqual([]);
    expect(agentSends).toEqual([{ to: 'agent-otto', text: 'From Juno:\nNow reports to you.' }]);
    r.stop();
  });
});
