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
  FILE_SCAN_MS,
  LAUNCH_CAP_RETRY_MS,
  type BeatAgent,
  type BeatOutboxPort,
  type BeatRunnerDeps,
} from '../beat-runner.js';
import type { BeatLaunchResult, BeatTurnLauncher } from '../beat-launch.js';
import { endBeatTurn, liveBeatTurn, resetBeatTurns } from '../beat-turns.js';
import type { HeartbeatFileRead } from '../heartbeat-file.js';
import { parseHeartbeatText, hashFrontmatter } from '../heartbeat-file.js';
import type { Change } from '../gatherers/index.js';
import { BEAT_INTERVALS } from '../beat-scheduler.js';
import { GATHER_HOLD_MAX_MS } from '../beat-cycle.js';

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
    commitments: { list: () => [] },
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

// DOR-3036: the beat reads the agent's open promises, so one made in a marked turn marks the beat.
describe('a beat that reads a promise made in a marked turn', () => {
  it('carries the promise’s marks as its ceiling, and an unmarked agent’s beat carries none', async () => {
    changes = [LOCAL_MESSAGE];
    const marks = { outsider: true as const, teammate: [{ roomId: 'space', authorId: 'priya' }] };
    runtime.withScenarios([endsWith({ summary: 'Done.', raises: [] }, () => currentSession)]);
    const marked = runner({ commitments: { list: () => [], openMarks: () => marks } });
    const done = marked.wake(juno.id, { wake: 'event:room-mention', causedBy: 'entry-1' });
    await settle();
    await done;
    expect(launchCeilings).toEqual([
      ['runtime-default', { asks: 'always', reach: 'read', teammate: marks.teammate }],
    ]);
  });

  it('carries the marks of a gathered post a marked turn wrote', async () => {
    const teammate = [{ roomId: 'space', authorId: 'priya' }];
    changes = [{ ...LOCAL_MESSAGE, marks: { outsider: true, teammate } }];
    runtime.withScenarios([endsWith({ summary: 'Done.', raises: [] }, () => currentSession)]);
    const done = runner().wake(juno.id, { wake: 'event:room-mention', causedBy: 'entry-1' });
    await settle();
    await done;
    expect(launchCeilings).toEqual([
      ['runtime-default', { asks: 'always', reach: 'read', teammate }],
    ]);
  });

  it('runs without a ceiling when no open promise is marked', async () => {
    changes = [LOCAL_MESSAGE];
    runtime.withScenarios([endsWith({ summary: 'Done.', raises: [] }, () => currentSession)]);
    const plain = runner({ commitments: { list: () => [], openMarks: () => ({}) } });
    const done = plain.wake(juno.id, { wake: 'event:room-mention', causedBy: 'entry-1' });
    await settle();
    await done;
    expect(launchCeilings).toEqual([undefined]);
  });
});

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

  it('delivers nothing when the turn ends without end_beat', async () => {
    changes = [LOCAL_MESSAGE];
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'I think Dorian should know.' } } as StreamEvent;
      },
    ]);
    const done = runner().wake(juno.id, { wake: 'event:test' });
    await settle();
    await done;
    expect(accepted).toEqual([]);
    expect(beats()).toMatchObject([{ outcome: 'no-end-beat' }]);
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

  it('arms an agent again at the next scan once it is resumed', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    let paused = false;
    const r = runner({ isPaused: () => paused });
    await r.start();
    expect(r.nextBeatAt(juno.id)).not.toBeNull();
    paused = true;
    // Its armed beat comes due while paused and is dropped, not re-armed.
    await vi.advanceTimersByTimeAsync(13 * 60 * 60_000);
    const due = r.nextBeatAt(juno.id);
    expect(due === null || due.getTime() <= Date.now()).toBe(true);
    paused = false;
    await vi.advanceTimersByTimeAsync(FILE_SCAN_MS);
    const next = r.nextBeatAt(juno.id);
    expect(next !== null && next.getTime() > Date.now()).toBe(true);
    r.stop();
  });

  it('arms again after a pause shorter than the scan that ate a timed beat', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    let paused = false;
    const r = runner({ isPaused: () => paused });
    await r.start();
    const due = r.nextBeatAt(juno.id)!.getTime();
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1);
    paused = true;
    await vi.advanceTimersByTimeAsync(2);
    paused = false;
    await vi.advanceTimersByTimeAsync(FILE_SCAN_MS);
    const next = r.nextBeatAt(juno.id);
    expect(next !== null && next.getTime() > Date.now()).toBe(true);
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

  it('staggers the first beat after a restart, and waits out a recent last beat', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    store.patchState(juno.id, { lastBeatAt: new Date(MONDAY_10AM - 10 * 60_000).toISOString() });
    const r = runner();
    await r.start();
    // In hours: 30 minutes after the last beat, which beats the 3-minute stagger.
    expect(r.nextBeatAt(juno.id)?.getTime()).toBe(MONDAY_10AM + 20 * 60_000);
    r.stop();
  });

  it('arms nothing for an agent that wakes on events only', async () => {
    const r = runner();
    await r.start();
    expect(r.nextBeatAt(juno.id)).toBeNull();
    r.stop();
  });

  it('arms the next timed beat from the cadence table after a beat', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    const r = runner();
    await r.start();
    await r.wake(juno.id, { wake: 'timer' });
    expect(r.nextBeatAt(juno.id)?.getTime()).toBe(MONDAY_10AM + BEAT_INTERVALS.workingHours);
    r.stop();
  });

  it('records a beat a restart interrupted as failed and does not retry it', async () => {
    store.insertBeat({
      id: 'open-beat',
      agentId: juno.id,
      startedAt: new Date(MONDAY_10AM - 60_000).toISOString(),
      kind: 'pulse',
      wake: 'timer',
    });
    const r = runner();
    await r.start();
    expect(beats()).toMatchObject([{ id: 'open-beat', outcome: 'failed' }]);
    expect(rows('heartbeat.beat')[0]).toMatchObject({ outcome: 'failed' });
    r.stop();
  });
});

describe('HEARTBEAT.md', () => {
  it('applies an edit at the next beat', async () => {
    const r = runner();
    heartbeatFile = file('---\nwake: events\n---\n');
    await r.start();
    expect(r.nextBeatAt(juno.id)).toBeNull();
    heartbeatFile = file('---\nwake: timed\n---\n');
    await r.wake(juno.id, { wake: 'event:test' });
    expect(r.nextBeatAt(juno.id)).not.toBeNull();
    r.stop();
  });

  it('keeps the last good frontmatter when the file turns invalid, and records it once', async () => {
    const r = runner();
    heartbeatFile = file('---\nwake: timed\n---\n');
    await r.wake(juno.id, { wake: 'event:test' });
    heartbeatFile = file('---\nwake: hourly\n---\n');
    expect(heartbeatFile.kind).toBe('invalid');
    await r.start();
    await r.wake(juno.id, { wake: 'event:test' });
    await r.wake(juno.id, { wake: 'event:test' });
    // Still timed: the last good header is in force.
    expect(r.nextBeatAt(juno.id)).not.toBeNull();
    expect(rows('heartbeat.config_invalid')).toHaveLength(1);
    r.stop();
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

describe('standing conditions', () => {
  it('runs a turn for a lost connection once, not every beat it stays lost', async () => {
    changes = [
      {
        gatherer: 'health',
        key: 'connection:c1:expired',
        summary: 'Gmail lost access.',
        at: '2026-10-12T00:00:00Z',
        signal: 'connection-lost',
      },
    ];
    const r = runner({ gatherers: { health: async () => changes } });
    runtime.withScenarios([
      endsWith({ summary: 'Asked for a new sign-in.' }, () => currentSession),
    ]);
    const first = r.wake(juno.id, { wake: 'event:test' });
    await settle();
    await first;
    vi.setSystemTime(MONDAY_10AM + 30 * 60_000);
    await r.wake(juno.id, { wake: 'event:test' });
    expect(launches).toHaveLength(1);
    expect(beats().at(-1)?.outcome).toBe('quiet');
  });
});

describe('a beat that throws', () => {
  it('records the beat failed and still arms the next timed beat', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    changes = [LOCAL_MESSAGE];
    const r = runner({
      launcher: {
        ...launcher(),
        launch: async () => {
          throw new Error('dispatcher fell over');
        },
      },
    });
    await r.start();
    await r.wake(juno.id, { wake: 'timer' });
    expect(beats().at(-1)).toMatchObject({ outcome: 'failed' });
    expect(r.nextBeatAt(juno.id)).not.toBeNull();
    r.stop();
  });
});

describe('failure storms', () => {
  it('names the error in the raise', async () => {
    changes = [LOCAL_MESSAGE];
    lastError = 'The model provider refused the request.';
    runtime.withScenarios([failingTurn, failingTurn, failingTurn]);
    const r = runner();
    for (let i = 0; i < 3; i += 1) {
      const done = r.wake(juno.id, { wake: 'event:test' });
      await settle();
      await done;
    }
    expect(failingErrors).toEqual(['The model provider refused the request.']);
  });
});

describe('an asked-for pace', () => {
  it('is clamped to twelve hours when stored', async () => {
    changes = [LOCAL_MESSAGE];
    const r = runner();
    runtime.withScenarios([
      endsWith(
        {
          summary: 'Watching the launch.',
          pace: {
            everyMinutes: 5,
            // Within the schema's minute of slack, beyond twelve hours.
            untilIso: new Date(MONDAY_10AM + 12 * 60 * 60_000 + 30_000).toISOString(),
            why: 'launch',
          },
        },
        () => currentSession
      ),
    ]);
    const done = r.wake(juno.id, { wake: 'event:test' });
    await settle();
    await done;
    const pace = JSON.parse(store.getState(juno.id)!.pace!) as { untilIso: string };
    expect(Date.parse(pace.untilIso)).toBe(MONDAY_10AM + 12 * 60 * 60_000);
  });
});

describe('wake: off and new agents', () => {
  it('records once that an agent is off', async () => {
    heartbeatFile = file('---\nwake: off\n---\n');
    const r = runner();
    await r.wake(juno.id, { wake: 'event:test' });
    await r.wake(juno.id, { wake: 'event:test' });
    expect(rows('heartbeat.skipped').filter((row) => row.reason === 'wake: off')).toHaveLength(1);
  });

  it('arms an agent that appears after start, at the next scan', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    let list: BeatAgent[] = [];
    const r = runner({ agents: { list: () => list, get: (id) => list.find((a) => a.id === id) } });
    await r.start();
    expect(r.nextBeatAt(juno.id)).toBeNull();
    list = [juno];
    await vi.advanceTimersByTimeAsync(FILE_SCAN_MS);
    expect(r.nextBeatAt(juno.id)).not.toBeNull();
    r.stop();
  });
});

/** A promise and the function that settles it. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('a beat that throws after its turn was registered', () => {
  it('settles the beat-turn entry, so end_beat refuses there afterwards', async () => {
    changes = [LOCAL_MESSAGE];
    let session = '';
    const r = runner({
      launcher: {
        ...launcher(),
        launch: async (request) => {
          session = request.sessionId;
          throw new Error('dispatcher fell over');
        },
      },
    });
    await r.wake(juno.id, { wake: 'event:test' });
    expect(session).not.toBe('');
    expect(liveBeatTurn(session)).toBeUndefined();
  });
});

describe('starting and stopping', () => {
  it('arms nothing when stopped while the files are read', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    const read = deferred<HeartbeatFileRead>();
    const r = runner({ readHeartbeat: () => read.promise });
    const started = r.start();
    r.stop();
    read.resolve(heartbeatFile);
    await started;
    expect(r.nextBeatAt(juno.id)).toBeNull();
    expect(r.armedTimers).toBe(0);
  });

  it('leaves one set of timers after a stop and start while the files are read', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    const firstRead = deferred<HeartbeatFileRead>();
    let reads = 0;
    const r = runner({
      readHeartbeat: async () => ((reads += 1) === 1 ? firstRead.promise : heartbeatFile),
    });
    const first = r.start();
    r.stop();
    await r.start();
    firstRead.resolve(heartbeatFile);
    await first;
    r.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves one scan chain after a stop and start during a scan', async () => {
    // Events only, so no timed beat reads the file before the scan does.
    heartbeatFile = file('---\nwake: events\n---\n');
    let gate: ReturnType<typeof deferred<HeartbeatFileRead>> | null = null;
    const r = runner({
      readHeartbeat: async () => {
        const held = gate;
        gate = null;
        return held ? held.promise : heartbeatFile;
      },
    });
    await r.start();
    const scanRead = deferred<HeartbeatFileRead>();
    gate = scanRead;
    await vi.advanceTimersByTimeAsync(FILE_SCAN_MS);
    r.stop();
    await r.start();
    scanRead.resolve(heartbeatFile);
    await settle();
    r.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('recovering interrupted beats', () => {
  it('leaves alone a beat this process is running', async () => {
    changes = [LOCAL_MESSAGE];
    // A turn that never settles: the beat stays running.
    const r = runner({
      launcher: {
        ...launcher(),
        launch: async (request) => ({ status: 'started', sessionId: request.sessionId }),
      },
    });
    void r.wake(juno.id, { wake: 'event:test' });
    await settle();
    await r.start();
    expect(beats()).toMatchObject([{ outcome: null }]);
    r.stop();
  });

  it('runs once per process, so a later start never fails a beat it opened', async () => {
    const r = runner();
    await r.start();
    r.stop();
    store.insertBeat({
      id: 'later-beat',
      agentId: juno.id,
      startedAt: new Date(MONDAY_10AM).toISOString(),
      kind: 'pulse',
      wake: 'timer',
    });
    await r.start();
    expect(beats()).toMatchObject([{ id: 'later-beat', outcome: null }]);
    r.stop();
  });
});

describe('arming the next beat', () => {
  it('disarms an agent whose runtime this server stopped running', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    let registered = true;
    const r = runner({ runtimeRegistered: () => registered });
    await r.start();
    expect(r.nextBeatAt(juno.id)).not.toBeNull();
    registered = false;
    await r.refreshAgent(juno.id);
    expect(r.nextBeatAt(juno.id)).toBeNull();
    r.stop();
  });

  it('beats every ten minutes while a turn of its own is still running', async () => {
    heartbeatFile = file('---\nwake: timed\n---\n');
    const r = runner({ ownTurnRunning: () => true });
    await r.start();
    await r.wake(juno.id, { wake: 'timer' });
    expect(r.nextBeatAt(juno.id)?.getTime()).toBe(MONDAY_10AM + BEAT_INTERVALS.inFlight);
    r.stop();
  });
});

describe('launch-cap retries', () => {
  it('starts the retries over after a beat that was not refused', async () => {
    changes = [LOCAL_MESSAGE];
    launchResults = ['cap-full', 'started', 'cap-full', 'cap-full'];
    runtime.withScenarios([endsWith({ summary: 'Answered.' }, () => currentSession)]);
    const r = runner();
    await r.start();
    await r.wake(juno.id, { wake: 'event:test' });
    await vi.advanceTimersByTimeAsync(LAUNCH_CAP_RETRY_MS[0]);
    await settle();
    expect(beats().map((b) => b.outcome)).toEqual(['refused', 'worked']);
    changes = [
      { ...LOCAL_MESSAGE, key: 'room-entry:e2', at: new Date(Date.now() + 500).toISOString() },
    ];
    vi.setSystemTime(Date.now() + 1000);
    await r.wake(juno.id, { wake: 'event:test' });
    expect(launches).toHaveLength(3);
    // The first retry again, at one minute, not the second at two.
    await vi.advanceTimersByTimeAsync(LAUNCH_CAP_RETRY_MS[0]);
    expect(launches).toHaveLength(4);
    r.stop();
  });

  it('keeps a cap retry and a wake-again apart, so neither replaces the other', async () => {
    changes = [LOCAL_MESSAGE];
    launchResults = ['cap-full', 'cap-full'];
    const base = launcher();
    const r = runner({
      launcher: {
        ...base,
        launch: async (request) => {
          // A wake arrived while this beat ran.
          store.patchState(juno.id, { wakeAgain: 1 });
          return base.launch(request);
        },
      },
    });
    await r.start();
    await r.wake(juno.id, { wake: 'event:test' });
    await vi.advanceTimersByTimeAsync(LAUNCH_CAP_RETRY_MS[0]);
    expect(launches).toHaveLength(2);
    r.stop();
  });
});

describe('the busy check', () => {
  it('looks again right before the turn starts, and skips when a person started typing', async () => {
    changes = [LOCAL_MESSAGE];
    store.patchState(juno.id, { beatChatId: 'beat-chat', beatChatDate: '2026-10-12' });
    let asked = 0;
    const r = runner({ launcher: { ...launcher(), isBusy: () => (asked += 1) > 1 } });
    await r.wake(juno.id, { wake: 'event:test' });
    expect(asked).toBe(2);
    expect(launches).toHaveLength(0);
    expect(beats()[0]!.outcome).toBe('skipped');
  });
});

describe('what a beat turn is given', () => {
  it("runs on the agent's own runtime and lists the raises it is still waiting on", async () => {
    changes = [LOCAL_MESSAGE];
    openRaises = [{ key: 'acme-unpaid', text: 'Acme has not paid.' }];
    runtime.withScenarios([endsWith({ summary: 'Checked.' }, () => currentSession)]);
    const done = runner().wake(juno.id, { wake: 'event:test' });
    await settle();
    await done;
    expect(launchRuntimes).toEqual(['claude-code']);
    expect(launches[0]).toContain('acme-unpaid');
  });
});

describe('a gatherer that fails', () => {
  const failing = { health: async () => Promise.reject(new Error('database locked')) };

  it('keeps gathered_through where it was, so its window is looked at again', async () => {
    const earlier = new Date(MONDAY_10AM - 60 * 60_000).toISOString();
    store.patchState(juno.id, { gatheredThrough: earlier });
    await runner({ gatherers: { addressed: async () => [], ...failing } }).wake(juno.id, {
      wake: 'event:test',
    });
    expect(beats()[0]!.outcome).toBe('quiet');
    expect(store.getState(juno.id)?.gatheredThrough).toBe(earlier);
  });

  it('holds it back at most a day, so one broken check cannot hold every window open', async () => {
    store.patchState(juno.id, { gatheredThrough: '2026-10-01T00:00:00.000Z' });
    await runner({ gatherers: { addressed: async () => [], ...failing } }).wake(juno.id, {
      wake: 'event:test',
    });
    expect(store.getState(juno.id)?.gatheredThrough).toBe(
      new Date(MONDAY_10AM - GATHER_HOLD_MAX_MS).toISOString()
    );
  });
});

describe('a beat whose account is out of usage', () => {
  /** A turn that ends without `end_beat`, as one cut off by a usage limit does. */
  async function* cutOff(): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: "You've hit your weekly limit" } } as StreamEvent;
  }

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

  it('stays in its chat, naming no account, while its account has room', async () => {
    const { launcher: l, sent } = recording();
    const r = runner({
      launcher: l,
      seats: { seatFor: async () => ({ kind: 'stay' }), hitLimit: () => false },
    });
    runtime.withScenarios([endsWith({ summary: 'Answered.' }, () => currentSession)]);
    const done = r.wake(juno.id, { wake: 'event:test' });
    await settle();
    await done;
    expect(sent).toEqual([{ sessionId: 'beat-chat' }]);
  });

  it('waits instead of burning the beat when no account can take it, and loses nothing', async () => {
    const { launcher: l, sent } = recording();
    let seat: 'wait' | 'stay' = 'wait';
    const r = runner({
      launcher: l,
      seats: {
        seatFor: async () =>
          seat === 'wait' ? { kind: 'wait', until: '2026-10-13T01:00:00.000Z' } : { kind: 'stay' },
        hitLimit: () => false,
      },
    });
    await r.wake(juno.id, { wake: 'event:test' });
    expect(sent).toHaveLength(0);
    expect(beats().at(-1)).toMatchObject({ outcome: 'skipped' });
    expect(beats().at(-1)?.summary).toContain('out of usage until 2026-10-13T01:00:00.000Z');
    expect(store.getState(juno.id)?.consecutiveFailures ?? 0).toBe(0);

    seat = 'stay';
    runtime.withScenarios([endsWith({ summary: 'Answered.' }, () => currentSession)]);
    vi.setSystemTime(MONDAY_10AM + 60_000);
    const done = r.wake(juno.id, { wake: 'event:test' });
    await settle();
    await done;
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('room-entry:e1');
  });

  it('runs the beat once more on another account when its turn hits a limit', async () => {
    const { launcher: l, sent } = recording();
    const asked: boolean[] = [];
    const r = runner({
      launcher: l,
      seats: {
        seatFor: async (_agent, _sessionId, opts) => {
          asked.push(opts.afterLimit);
          return opts.afterLimit ? { kind: 'move', accountId: 'claude2' } : { kind: 'stay' };
        },
        hitLimit: (sessionId) => sessionId === 'beat-chat',
      },
    });
    runtime.withScenarios([cutOff, endsWith({ summary: 'Answered.' }, () => currentSession)]);
    const done = r.wake(juno.id, { wake: 'event:test' });
    for (let i = 0; i < 4; i += 1) await settle();
    await done;
    expect(asked).toEqual([false, true]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ sessionId: 'beat-chat' });
    expect(sent[1]!.account).toBe('claude2');
    expect(sent[1]!.sessionId).not.toBe('beat-chat');
    // One beat, recorded once, as the re-run ended it.
    expect(beats()).toHaveLength(1);
    expect(beats()[0]).toMatchObject({ outcome: 'worked', turnSessionId: sent[1]!.sessionId });
  });

  it('re-runs at most once, so a second limit ends the beat', async () => {
    const { launcher: l, sent } = recording();
    const r = runner({
      launcher: l,
      seats: {
        seatFor: async (_agent, _sessionId, opts) =>
          opts.afterLimit ? { kind: 'move', accountId: 'claude2' } : { kind: 'stay' },
        hitLimit: () => true,
      },
    });
    runtime.withScenarios([cutOff, cutOff]);
    const done = r.wake(juno.id, { wake: 'event:test' });
    for (let i = 0; i < 4; i += 1) await settle();
    await done;
    expect(sent).toHaveLength(2);
    expect(beats()).toHaveLength(1);
    expect(beats()[0]).toMatchObject({ outcome: 'no-end-beat' });
  });

  it('skips the re-run and waits when no other account can take it', async () => {
    const { launcher: l, sent } = recording();
    const r = runner({
      launcher: l,
      seats: {
        seatFor: async (_agent, _sessionId, opts) =>
          opts.afterLimit ? { kind: 'wait', until: null } : { kind: 'stay' },
        hitLimit: () => true,
      },
    });
    runtime.withScenarios([cutOff]);
    const done = r.wake(juno.id, { wake: 'event:test' });
    for (let i = 0; i < 4; i += 1) await settle();
    await done;
    expect(sent).toHaveLength(1);
    expect(beats()[0]).toMatchObject({ outcome: 'skipped' });
    expect(beats()[0]?.summary).toBe('Every account it may use is out of usage; it waits.');
  });
});
