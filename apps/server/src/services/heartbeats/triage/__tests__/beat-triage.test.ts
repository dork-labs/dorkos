/**
 * Triage wired into the beat (spec `heartbeats` §6.2, §9.3, §10 PR 5): what a
 * decision does to a real beat over a real database — quiet ends it, "can wait"
 * queues the changes for the report with no turn, and a turn starts one. The
 * decision model is the real bridge over a fake server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { heartbeatBeats, heartbeatReportItems, heartbeatState, type Db } from '@dorkos/db';
import { resolveWorkingHours } from '@dorkos/shared/working-hours';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { triageBeatWith } from '../../../decisions/heartbeat-triage.js';
import {
  COMMITS,
  MONEY,
  fakeTriageDeps,
  type FakeAnswer,
} from '../../../decisions/__tests__/triage-fakes.js';
import { HeartbeatStore } from '../../heartbeat-store.js';
import { BeatRunner, type BeatAgent, type BeatOutboxPort } from '../../beat-runner.js';
import { resetBeatTurns } from '../../beat-turns.js';
import type { Change } from '../../gatherers/index.js';
import { RaiseStore } from '../../raises/raise-store.js';
import { createBeatTriagePort, decideBeat, type BeatTriagePort } from '../beat-triage.js';

const MONDAY_10AM = Date.parse('2026-10-12T14:00:00Z');
const HOURS = resolveWorkingHours({ timezone: 'America/New_York', workingHours: null });
const juno: BeatAgent = {
  id: 'agent-juno',
  name: 'Juno',
  runtime: 'claude-code',
  projectPath: '/agents/juno',
};

let db: Db;
let changes: Change[];
let launches: number;
let ids = 0;

const outbox: BeatOutboxPort = {
  accept: async () => 0,
  resolve: () => undefined,
  openRaises: () => [],
  raiseFailing: async () => undefined,
  deliverReport: async () => undefined,
};

/** A port whose decision model answers `answer` over a fake server. */
function modelPort(answer: FakeAnswer): BeatTriagePort {
  const deps = fakeTriageDeps(answer);
  return createBeatTriagePort(
    new RaiseStore(db),
    () => `item-${++ids}`,
    (c, ctx) => triageBeatWith(deps, c, ctx)
  );
}

/** One beat for Juno with this triage port. */
async function beat(triage: BeatTriagePort | undefined): Promise<void> {
  await runnerWith(triage).wake(juno.id, { wake: 'event:test' });
}

/** A runner for Juno with this triage port. */
function runnerWith(triage: BeatTriagePort | undefined, launchThrows = false): BeatRunner {
  return new BeatRunner({
    store: new HeartbeatStore(db),
    agents: { list: () => [juno], get: (id) => (id === juno.id ? juno : undefined) },
    runtimeRegistered: () => true,
    enabled: () => true,
    hoursFor: () => HOURS,
    gatherers: { addressed: async () => changes },
    commitments: { list: () => [] },
    launcher: {
      launch: async () => {
        launches += 1;
        if (launchThrows) throw new Error('the turn fell over');
        return { status: 'refused', message: 'not in this test' };
      },
      isBusy: () => false,
      lastError: () => null,
      rename: async () => undefined,
    },
    outbox,
    readHeartbeat: async () => ({ kind: 'absent' }),
    random: () => 0.5,
    mintId: () => `id-${++ids}`,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    ...(triage ? { triage } : {}),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: MONDAY_10AM });
  db = createTestDb();
  changes = [];
  launches = 0;
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

describe('a beat triaged by a decision model', () => {
  it('ends quiet on a confident "nothing needs it", with no turn', async () => {
    changes = [COMMITS];
    await beat(modelPort({ label: 'a1', probability: 0.97 }));
    expect(launches).toBe(0);
    expect(db.select().from(heartbeatBeats).all()).toMatchObject([{ outcome: 'quiet' }]);
  });

  it('queues "can wait" for the report, starts no turn, and moves past what it saw', async () => {
    changes = [COMMITS];
    await beat(modelPort({ label: 'c3', probability: 0.97 }));
    expect(launches).toBe(0);
    const [row] = db.select().from(heartbeatBeats).all();
    expect(row).toMatchObject({
      outcome: 'queued',
      summary: 'Checked 4 things. Saved for its next report.',
    });
    expect(JSON.parse(row!.triage!)).toMatchObject({
      rung: 'model',
      verdict: 'queue',
      source: 'credits',
      steps: [
        { rung: 0, answer: null },
        { rung: 1, model: 'small-1', answer: 'c3', usage: { inputTokens: 120, outputTokens: 6 } },
      ],
    });
    expect(db.select().from(heartbeatReportItems).all()).toMatchObject([
      {
        agentId: juno.id,
        kind: 'triage',
        text: '3 new commits on main by Ana.',
        key: 'triage:commits:main',
        state: 'queued',
      },
    ]);
    // Dealt with: the next beat gathers from here.
    const [state] = db.select().from(heartbeatState).all();
    expect(state!.gatheredThrough).toBe(new Date(MONDAY_10AM).toISOString());
  });

  it('starts a turn on "work on it now"', async () => {
    changes = [COMMITS];
    await beat(modelPort({ label: 'b2', probability: 0.97 }));
    expect(launches).toBe(1);
  });

  it('starts a turn when money is dismissed without probabilities', async () => {
    changes = [MONEY];
    await beat(modelPort({ label: 'a1' }));
    expect(launches).toBe(1);
    expect(db.select().from(heartbeatReportItems).all()).toEqual([]);
  });

  it('without a triage port, what the rules cannot settle is a turn, as before', async () => {
    changes = [COMMITS];
    await beat(undefined);
    expect(launches).toBe(1);
  });
});

describe('decideBeat', () => {
  const never: BeatTriagePort = {
    triage: async () => {
      throw new Error('a sweep or a quiet beat never asks a model');
    },
    queue: () => undefined,
  };

  it('a sweep always turns, and quiet by the rules stays quiet, without asking', async () => {
    const base = { considered: [COMMITS], agentName: 'Juno', checklist: null };
    expect(
      (await decideBeat(never, { ...base, kind: 'sweep', verdict: 'undecided' })).decision
    ).toBe('turn');
    expect((await decideBeat(never, { ...base, kind: 'sweep', verdict: 'quiet' })).decision).toBe(
      'turn'
    );
    expect((await decideBeat(never, { ...base, kind: 'pulse', verdict: 'quiet' })).decision).toBe(
      'quiet'
    );
  });

  it('hands the port the beat’s abort signal, which the runner fires when it stops', async () => {
    let seen: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const waiting: BeatTriagePort = {
      triage: async (_changes, context) => {
        seen = context.signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { decision: 'quiet', why: 'test', record: '{}' };
      },
      queue: () => undefined,
    };
    changes = [COMMITS];
    const runner = runnerWith(waiting);
    const done = runner.wake(juno.id, { wake: 'event:test' });
    for (let i = 0; i < 50 && !seen; i += 1) await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    runner.stop();
    expect(seen?.aborted).toBe(true);
    release();
    await done;
  });

  it('starts no turn when it is stopped mid-check, even on "work on it now"', async () => {
    let release: () => void = () => undefined;
    let asked = false;
    const waiting: BeatTriagePort = {
      triage: async () => {
        asked = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { decision: 'turn', why: 'test', record: '{"requests":1}' };
      },
      queue: () => undefined,
    };
    changes = [COMMITS];
    const runner = runnerWith(waiting);
    const done = runner.wake(juno.id, { wake: 'event:test' });
    for (let i = 0; i < 50 && !asked; i += 1) await Promise.resolve();
    runner.stop();
    release();
    await done;
    expect(launches).toBe(0);
    const [row] = db.select().from(heartbeatBeats).all();
    expect(row!.outcome).toBe('skipped');
    const [state] = db.select().from(heartbeatState).all();
    expect(state!.gatheredThrough).toBeNull();
  });

  it('keeps what its check spent on the beat row when the turn throws', async () => {
    const spent: BeatTriagePort = {
      triage: async () => ({ decision: 'turn', why: 'test', record: '{"requests":2}' }),
      queue: () => undefined,
    };
    changes = [COMMITS];
    await runnerWith(spent, true).wake(juno.id, { wake: 'event:test' });
    const [row] = db.select().from(heartbeatBeats).all();
    expect(launches).toBe(1);
    expect(row!.triage).toBe('{"requests":2}');
  });
});
