/**
 * The beat runner end to end over a real database and audit trail, with a fake
 * clock, fake gatherers and a launcher that drives a `FakeAgentRuntime` (spec
 * `heartbeats` §10, PR 3 tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { auditEvents, heartbeatBeats, type Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { EndBeatInput } from '@dorkos/shared/heartbeat-schemas';
import { resolveWorkingHours } from '@dorkos/shared/working-hours';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { HeartbeatStore } from '../heartbeat-store.js';
import {
  BeatRunner,
  LAUNCH_CAP_RETRY_MS,
  type BeatAgent,
  type BeatOutboxPort,
  type BeatRunnerDeps,
} from '../beat-runner.js';
import type { BeatLaunchResult, BeatTurnLauncher } from '../beat-launch.js';
import { endBeatTurn, resetBeatTurns } from '../beat-turns.js';
import type { HeartbeatFileRead } from '../heartbeat-file.js';
import { parseHeartbeatText, hashFrontmatter } from '../heartbeat-file.js';
import type { Change } from '../gatherers/index.js';
import { createTodosGatherer } from '../gatherers/todo-promises.js';
import type { OpenWorkReader } from '../gatherers/open-work.js';
import { BEAT_INTERVALS } from '../beat-scheduler.js';

/** Monday 10:00 in New York: inside default working hours. */
const MONDAY_10AM = Date.parse('2026-10-12T14:00:00Z');
const HOURS = resolveWorkingHours({ timezone: 'America/New_York', workingHours: null });

const juno: BeatAgent = {
  id: 'agent-juno',
  name: 'Juno',
  runtime: 'claude-code',
  projectPath: '/agents/juno',
};

let db: Db;
let store: HeartbeatStore;
let changes: Change[];
let heartbeatFile: HeartbeatFileRead;
let runtime: FakeAgentRuntime;
let launchResults: Array<BeatLaunchResult['status'] | 'refused-at-start'>;
let launches: string[];
let launchRuntimes: string[];
let launchCeilings: unknown[];
let launchCarried: unknown[];
let accepted: Array<{ raises: number }>;
let failingRaises: number;
let failingErrors: Array<string | undefined>;
let lastError: string | null;
let openRaises: Array<{ key: string; text: string }>;
let ids = 0;

/** A fake outbox that records what it was handed. */
const outbox: BeatOutboxPort = {
  accept: async ({ raises }) => {
    accepted.push({ raises: raises.length });
    return raises.length;
  },
  resolve: () => undefined,
  openRaises: () => openRaises,
  raiseFailing: async (_agent, _beat, error) => {
    failingRaises += 1;
    failingErrors.push(error);
  },
  deliverReport: async () => undefined,
};

/** A launcher that runs the turn on the fake runtime, as the launch service would. */
function launcher(): BeatTurnLauncher {
  return {
    async launch(request) {
      launches.push(request.content);
      launchRuntimes.push(request.runtime);
      launchCeilings.push(request.permissionCeiling);
      launchCarried.push(request.carriedMarks);
      currentSession = request.sessionId;
      const status = launchResults.shift() ?? 'started';
      if (status === 'cap-full') return { status: 'cap-full' };
      if (status === 'refused') return { status: 'refused', message: 'no' };
      // Started, then refused before the agent saw it (DOR-2994).
      if (status === 'refused-at-start') {
        queueMicrotask(() => request.onSettled('failed', 'warm-ceiling'));
        return { status: 'started', sessionId: request.sessionId };
      }
      void (async () => {
        let failed = false;
        try {
          for await (const _event of runtime.sendMessage(request.sessionId, request.content)) {
            // Drain the turn.
          }
        } catch {
          failed = true;
        }
        request.onSettled(failed ? 'failed' : 'ok');
      })();
      return { status: 'started', sessionId: request.sessionId };
    },
    isBusy: () => false,
    lastError: () => lastError,
    rename: async () => undefined,
  };
}

/** A scenario where the agent ends the beat with this input. */
function endsWith(input: EndBeatInput, sessionOf: () => string) {
  return async function* (): AsyncGenerator<StreamEvent> {
    endBeatTurn(sessionOf(), input);
    yield { type: 'text_delta', data: { text: 'done' } } as StreamEvent;
  };
}

/** A scenario that throws, as a failed turn does. */
async function* failingTurn(): AsyncGenerator<StreamEvent> {
  yield* [];
  throw new Error('runtime fell over');
}

/** The runner, over the fakes. */
function runner(overrides: Partial<BeatRunnerDeps> = {}): BeatRunner {
  return new BeatRunner({
    store,
    agents: { list: () => [juno], get: (id) => (id === juno.id ? juno : undefined) },
    runtimeRegistered: (rt) => rt === 'claude-code',
    enabled: () => true,
    hoursFor: () => HOURS,
    // Honours `since` like a real gatherer: a change at or before it is gone.
    gatherers: {
      addressed: async (ctx) =>
        changes.filter((change) => ctx.since === null || change.at > ctx.since),
    },
    todoPromises: { list: () => [] },
    launcher: launcher(),
    outbox,
    readHeartbeat: async () => heartbeatFile,
    random: () => 0.5,
    mintId: () => `id-${++ids}`,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    ...overrides,
  });
}

/** A valid HEARTBEAT.md read. */
function file(text: string): HeartbeatFileRead {
  const parsed = parseHeartbeatText(text);
  if (!parsed.ok) {
    return {
      kind: 'invalid',
      error: parsed.error,
      body: parsed.body,
      hash: hashFrontmatter(text),
      mtimeMs: 0,
    };
  }
  return {
    kind: 'valid',
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    hash: hashFrontmatter(parsed.frontmatter),
    mtimeMs: 0,
  };
}

/** One unanswered local message. */
const LOCAL_MESSAGE: Change = {
  gatherer: 'addressed',
  key: 'room-entry:e1',
  summary: 'Dorian wrote to you directly (room r1).',
  at: '2026-10-12T13:55:00Z',
  signal: 'unanswered',
};

/** The audit rows for one action. */
function rows(action: string) {
  return db
    .select()
    .from(auditEvents)
    .all()
    .filter((row) => row.action === action);
}

/** Every beat row. */
function beats() {
  return db.select().from(heartbeatBeats).all();
}

/** The chat the latest beat turn runs in. */
let currentSession = '';

beforeEach(() => {
  vi.useFakeTimers({ now: MONDAY_10AM });
  db = createTestDb();
  store = new HeartbeatStore(db);
  changes = [];
  heartbeatFile = { kind: 'absent' };
  runtime = new FakeAgentRuntime('claude-code');
  launchResults = [];
  launches = [];
  launchRuntimes = [];
  launchCeilings = [];
  launchCarried = [];
  accepted = [];
  failingRaises = 0;
  failingErrors = [];
  lastError = null;
  openRaises = [];
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

/** Let the turn's async drain and settle run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('a quiet beat', () => {
  it('runs no model and writes one record row', async () => {
    await runner().wake(juno.id, { wake: 'event:test' });
    expect(launches).toHaveLength(0);
    expect(rows('heartbeat.beat')).toHaveLength(1);
    expect(rows('heartbeat.beat')[0]!.summary).toBe('Checked 4 things. Nothing new.');
    expect(beats()).toMatchObject([{ outcome: 'quiet', kind: 'pulse' }]);
  });
});

describe('a beat with work', () => {
  it('runs a turn on the runtime, and end_beat hands its raises to the outbox', async () => {
    changes = [LOCAL_MESSAGE];
    const r = runner();
    runtime.withScenarios([
      endsWith(
        { summary: 'Answered Dorian.', raises: [{ text: 'Acme paid.', rung: 'dm' }] },
        () => currentSession
      ),
    ]);
    const done = r.wake(juno.id, { wake: 'event:room-mention', causedBy: 'entry-1' });
    await settle();
    await done;
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('room-entry:e1');
    expect(launches[0]).toContain('end_beat');
    expect(accepted).toEqual([{ raises: 1 }]);
    const [record] = rows('heartbeat.beat');
    expect(record).toMatchObject({ summary: 'Answered Dorian.', outcome: 'ok' });
    expect(JSON.parse(record!.links ?? '{}')).toEqual({ causedBy: 'entry-1' });
    expect(beats()).toMatchObject([{ outcome: 'worked', raises: 1 }]);
  });
});

describe('who beats', () => {
  it('never beats an agent on a runtime this server does not run, and records it once', async () => {
    const cursor: BeatAgent = { ...juno, id: 'agent-cursor', runtime: 'cursor' };
    const r = runner({
      agents: { list: () => [cursor], get: (id) => (id === cursor.id ? cursor : undefined) },
    });
    heartbeatFile = file('---\nwake: timed\n---\n');
    await r.start();
    changes = [LOCAL_MESSAGE];
    await r.wake(cursor.id, { wake: 'event:test' });
    expect(launches).toHaveLength(0);
    expect(beats()).toHaveLength(0);
    expect(r.nextBeatAt(cursor.id)).toBeNull();
    expect(rows('heartbeat.skipped')).toHaveLength(1);
    r.stop();
  });

  it('beats nothing while the pause seam says paused', async () => {
    changes = [LOCAL_MESSAGE];
    heartbeatFile = file('---\nwake: timed\n---\n');
    const r = runner({ isPaused: () => true });
    await r.start();
    await r.wake(juno.id, { wake: 'event:test' });
    expect(beats()).toHaveLength(0);
    expect(r.nextBeatAt(juno.id)).toBeNull();
    r.stop();
  });

  it('beats nothing with `wake: off`, event wakes included', async () => {
    changes = [LOCAL_MESSAGE];
    heartbeatFile = file('---\nwake: off\n---\n');
    await runner().wake(juno.id, { wake: 'event:test' });
    expect(beats()).toHaveLength(0);
  });
});

describe('timers', () => {
  it('leaves no timer at all once heartbeats are turned off', async () => {
    let enabled = true;
    heartbeatFile = file('---\nwake: timed\n---\n');
    const r = runner({ enabled: () => enabled });
    await r.start();
    expect(r.armedTimers).toBeGreaterThan(0);
    enabled = false;
    await r.refreshEnabled();
    expect(r.armedTimers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('failures and refusals', () => {
  it('slows to two hours and raises once after three failed beat turns', async () => {
    changes = [LOCAL_MESSAGE];
    heartbeatFile = file('---\nwake: timed\n---\n');
    runtime.withScenarios([failingTurn, failingTurn, failingTurn, failingTurn]);
    const r = runner();
    await r.start();
    for (let i = 0; i < 4; i += 1) {
      const done = r.wake(juno.id, { wake: 'event:test' });
      await settle();
      await done;
    }
    expect(beats().filter((b) => b.outcome === 'failed')).toHaveLength(4);
    expect(failingRaises).toBe(1);
    expect(store.getState(juno.id)?.consecutiveFailures).toBe(4);
    expect(r.nextBeatAt(juno.id)?.getTime()).toBe(MONDAY_10AM + BEAT_INTERVALS.failing);
    r.stop();
  });

  it('records a full launch cap as refused and retries at 1, 2 and 5 minutes, then drops it', async () => {
    changes = [LOCAL_MESSAGE];
    launchResults = ['cap-full', 'cap-full', 'cap-full', 'cap-full'];
    const r = runner();
    await r.start();
    await r.wake(juno.id, { wake: 'event:test' });
    expect(launches).toHaveLength(1);
    for (const delay of LAUNCH_CAP_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(launches).toHaveLength(4);
    // Every retry still carries the message: a refused beat loses nothing.
    expect(launches.every((prompt) => prompt.includes('room-entry:e1'))).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(launches).toHaveLength(4);
    expect(beats().every((b) => b.outcome === 'refused')).toBe(true);
    expect(rows('heartbeat.beat').every((row) => row.outcome === 'refused')).toBe(true);
    r.stop();
  });

  it('records a turn the runtime refused before the agent saw it as refused, never as the agent failing (DOR-2994)', async () => {
    changes = [LOCAL_MESSAGE];
    launchResults = ['refused-at-start', 'refused-at-start', 'refused-at-start'];
    const r = runner();
    await r.start();
    for (let i = 0; i < 3; i += 1) {
      await r.wake(juno.id, { wake: 'event:test' });
      await settle();
    }
    expect(beats().length).toBeGreaterThan(0);
    expect(beats().every((b) => b.outcome === 'refused')).toBe(true);
    expect(store.getState(juno.id)?.consecutiveFailures ?? 0).toBe(0);
    expect(failingRaises).toBe(0);
    r.stop();
  });
});

describe('nothing gathered is lost', () => {
  it('keeps a change a busy beat saw for the next beat, and drops it once a beat dealt with it', async () => {
    changes = [LOCAL_MESSAGE];
    let busyChat = true;
    store.patchState(juno.id, { beatChatId: 'beat-chat', beatChatDate: '2026-10-12' });
    const r = runner({ launcher: { ...launcher(), isBusy: () => busyChat } });
    await r.wake(juno.id, { wake: 'event:test' });
    expect(beats()[0]!.outcome).toBe('skipped');
    busyChat = false;
    runtime.withScenarios([endsWith({ summary: 'Answered.' }, () => currentSession)]);
    vi.setSystemTime(MONDAY_10AM + 60_000);
    const done = r.wake(juno.id, { wake: 'event:test' });
    await settle();
    await done;
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('room-entry:e1');
    vi.setSystemTime(MONDAY_10AM + 2 * 60_000);
    await r.wake(juno.id, { wake: 'event:test' });
    expect(launches).toHaveLength(1);
    expect(beats().at(-1)?.outcome).toBe('quiet');
  });
});

describe('a beat’s chat on its row (DOR-3703, MD)', () => {
  it('is there before the turn starts, so a restart mid-beat leaves it a beat', async () => {
    changes = [LOCAL_MESSAGE];
    let atLaunch: string | null | undefined;
    const r = runner({
      launcher: {
        ...launcher(),
        launch: async (request) => {
          atLaunch = beats()[0]?.turnSessionId;
          return { status: 'started', sessionId: request.sessionId };
        },
      },
    });
    void r.wake(juno.id, { wake: 'event:test' });
    await settle();
    expect(atLaunch).toEqual(expect.any(String));
    r.stop();
  });
});

describe('a beat whose account is out of usage', () => {
  /** The launcher, recording which chat and account each launch named. */
  function recording(): {
    launcher: BeatTurnLauncher;
    sent: Array<{ sessionId: string; account?: string }>;
  } {
    const base = launcher();
    const sent: Array<{ sessionId: string; account?: string }> = [];
    return {
      sent,
      launcher: {
        ...base,
        launch: (request) => {
          sent.push({
            sessionId: request.sessionId,
            ...(request.account ? { account: request.account } : {}),
          });
          return base.launch(request);
        },
      },
    };
  }

  beforeEach(() => {
    changes = [LOCAL_MESSAGE];
    store.patchState(juno.id, { beatChatId: 'beat-chat', beatChatDate: '2026-10-12' });
  });

  it('runs in a fresh chat on the account that can take it', async () => {
    const { launcher: l, sent } = recording();
    const asked: Array<{ sessionId: string; afterLimit: boolean }> = [];
    const r = runner({
      launcher: l,
      seats: {
        seatFor: async (_agent, sessionId, opts) => {
          asked.push({ sessionId, afterLimit: opts.afterLimit });
          return { kind: 'move', accountId: 'claude5' };
        },
        hitLimit: () => false,
      },
    });
    runtime.withScenarios([endsWith({ summary: 'Answered.' }, () => currentSession)]);
    const done = r.wake(juno.id, { wake: 'event:test' });
    await settle();
    await done;
    expect(asked).toEqual([{ sessionId: 'beat-chat', afterLimit: false }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).not.toBe('beat-chat');
    expect(sent[0]!.account).toBe('claude5');
    // The fresh chat is today's beat chat from now on.
    expect(store.getState(juno.id)?.beatChatId).toBe(sent[0]!.sessionId);
    expect(beats().at(-1)?.outcome).toBe('worked');
  });
});

// DOR-3674: overnight 11-01→11-02 every lane went quiet and the beats said "Nothing needs it"
// 30 times. Through the real runner and the real to-dos gatherer: a stalled lane, or an
// open promise with no chat running, wakes a real turn that names it; fresh work does not.
describe('a beat over open work gone quiet', () => {
  const HOUR = 60 * 60 * 1000;
  const LANE = {
    sessionId: 'lane-3280',
    startedAt: '2026-10-11T00:00:00Z',
  };

  /** The real to-dos gatherer, over these promises and this lane activity. */
  function openWorkRunner(opts: {
    lastActive?: number;
    agent?: 'running' | number;
    promises?: { id: string; what: string }[];
    isPaused?: () => boolean;
  }) {
    const todoPromises = { list: () => (opts.promises ?? []) as never[] };
    const reader: OpenWorkReader = {
      lanesOf: async () => [LANE],
      isRunning: () => false,
      lastActiveAt: () => opts.lastActive,
      agentActivity: () => opts.agent ?? 'running',
      watchingSince: () => Date.now() - 48 * HOUR,
    };
    return runner({
      gatherers: { todos: createTodosGatherer(todoPromises, reader) },
      todoPromises,
      ...(opts.isPaused ? { isPaused: opts.isPaused } : {}),
    });
  }

  it('never wakes a paused agent, however long its lane has been quiet', async () => {
    const r = openWorkRunner({ lastActive: Date.now() - 10 * HOUR, isPaused: () => true });
    await r.wake(juno.id, { wake: 'event:test' });
    expect(launches).toHaveLength(0);
    expect(beats()).toHaveLength(0);
  });

  it('never wakes an agent whose beats a person switched off', async () => {
    heartbeatFile = file('---\nwake: off\n---\n');
    const r = openWorkRunner({ lastActive: Date.now() - 10 * HOUR });
    await r.wake(juno.id, { wake: 'event:test' });
    expect(launches).toHaveLength(0);
  });
});
