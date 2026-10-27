/**
 * A Stop ends the work its turn started (DOR-3285).
 *
 * Measured on Claude Code 2.1.304 (SDK 0.3.304), open input: `interrupt()`
 * stops a FOREGROUND shell, but a shell already in the background (started with
 * `run_in_background`, or moved there past its 120 s timeout) runs on to the end
 * and wakes the agent. On 2026-10-26 that is how a stopped turn still filed two
 * tickets. `stopTask(taskId)` after the interrupt does end it, so the store
 * stops every shell the stopped turn started, by its task id, and records a
 * lasting line on the session's stream when one will not stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from '../session-store.js';
import { endTurnTasks } from '../../sdk/turn-work-stop.js';
import { STOP_ACK_TIMEOUT_MS } from '../bounded-control.js';
import type { AgentSession } from '../../agent-types.js';

/** What the stop path ingested into the session's projector. */
const ingested = vi.hoisted(() => [] as Array<{ sessionId: string; event: unknown }>);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../session/session-state-projector.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  peekProjector: (sessionId: string) => ({
    ingest: (event: unknown) => ingested.push({ sessionId, event }),
  }),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = 'session-stopping-its-work';

type Answer = 'acks' | 'rejects' | 'never-settles';

/** A fake SDK query that records the control calls the store makes. */
function fakeQuery(answers: { interrupt?: Answer; stopTask?: (taskId: string) => Answer }) {
  const calls = { interrupt: 0, close: 0, stopTask: [] as string[] };
  const answer = (a: Answer | undefined, what: string): Promise<unknown> => {
    if (a === 'rejects') return Promise.reject(new Error(`${what} refused`));
    if (a === 'never-settles') return new Promise<never>(() => {});
    return Promise.resolve(undefined);
  };
  const query = {
    interrupt: () => {
      calls.interrupt++;
      return answer(answers.interrupt, 'interrupt');
    },
    stopTask: (taskId: string) => {
      calls.stopTask.push(taskId);
      return answer(answers.stopTask?.(taskId), 'stop_task');
    },
    close: () => {
      calls.close++;
    },
  } as unknown as Query;
  return { query, calls };
}

/** A store whose live turn runs on `query` and started these background tasks. */
function storeWithTurnWork(query: Query, taskIds: string[]): SessionStore {
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  const session = store.findSession(SESSION_ID)!;
  session.activeQuery = query;
  session.turnTaskIds = new Map(taskIds.map((taskId) => [taskId, `run ${taskId}`]));
  return store;
}

/** The `work_left_running` events the stop recorded, by their task ids. */
const leftRunning = () =>
  ingested
    .map(({ event }) => event as { type: string; tasks?: { taskId: string }[] })
    .filter((event) => event.type === 'work_left_running')
    .map((event) => event.tasks!.map((task) => task.taskId));

describe('a Stop ends the work its turn started (DOR-3285)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    ingested.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops every background shell the stopped turn started, by its task id', async () => {
    const { query, calls } = fakeQuery({});
    const store = storeWithTurnWork(query, ['bg-filing', 'bg-moved-past-timeout']);

    await expect(store.interruptQuery(SESSION_ID)).resolves.toMatchObject({ outcome: 'acked' });

    expect(calls.stopTask).toEqual(['bg-filing', 'bg-moved-past-timeout']);
    expect(store.findSession(SESSION_ID)!.turnTaskIds?.size).toBe(0);
    expect(leftRunning()).toEqual([]);
    expect(store.findSession(SESSION_ID)!.leftRunningTasks).toBeUndefined();
  });

  it('stops nothing when the turn started no background work', async () => {
    const { query, calls } = fakeQuery({});
    const store = storeWithTurnWork(query, []);
    await store.interruptQuery(SESSION_ID);
    expect(calls.stopTask).toEqual([]);
  });

  it('records a lasting line on the stream when a command it started will not stop', async () => {
    const { query, calls } = fakeQuery({
      stopTask: (taskId) => (taskId === 'stubborn' ? 'rejects' : 'acks'),
    });
    const store = storeWithTurnWork(query, ['stubborn', 'stops-fine']);

    await store.interruptQuery(SESSION_ID);

    expect(calls.stopTask).toEqual(['stubborn', 'stops-fine']);
    const session = store.findSession(SESSION_ID)!;
    expect([...session.turnTaskIds!.keys()]).toEqual(['stubborn']);
    expect(ingested).toEqual([
      {
        sessionId: SESSION_ID,
        event: {
          type: 'work_left_running',
          tasks: [{ taskId: 'stubborn', command: 'run stubborn' }],
        },
      },
    ]);
    // Remembered past the turn, so its later end can reach the line.
    expect([...session.leftRunningTasks!]).toEqual([['stubborn', 'run stubborn']]);
    // Never the turn's queue: that closed with the turn, and the next one clears it.
    expect(session.eventQueue).toEqual([]);
  });

  it('treats a stop the CLI never answers as still running, inside the stop bound', async () => {
    const { query } = fakeQuery({ stopTask: () => 'never-settles' });
    const store = storeWithTurnWork(query, ['silent']);

    const stopping = store.interruptQuery(SESSION_ID);
    await vi.advanceTimersByTimeAsync(STOP_ACK_TIMEOUT_MS + 1);
    await expect(stopping).resolves.toMatchObject({ outcome: 'acked' });
    expect(leftRunning()).toEqual([['silent']]);
  });

  // #3200 review, M1: Stop, a room halt and a pause stay bounded however many
  // shells the turn started.
  it('stops twenty silent tasks inside ONE stop bound, not one bound each', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `silent-${i}`);
    const { query, calls } = fakeQuery({ stopTask: () => 'never-settles' });
    const store = storeWithTurnWork(query, ids);

    let settled = false;
    const stopping = store.interruptQuery(SESSION_ID).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(STOP_ACK_TIMEOUT_MS + 1);
    expect(settled).toBe(true);
    await expect(stopping).resolves.toMatchObject({ outcome: 'acked' });
    expect(calls.stopTask).toEqual(ids);
    // One line for the whole stop, naming every command, not one line each.
    expect(leftRunning()).toEqual([ids]);
  });

  it('asks nothing more of a process it had to close: its work ends with it', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'rejects' });
    const store = storeWithTurnWork(query, ['bg-filing']);

    await expect(store.interruptQuery(SESSION_ID)).resolves.toMatchObject({ outcome: 'closed' });
    expect(calls.close).toBe(1);
    expect(calls.stopTask).toEqual([]);
  });
});

describe('endTurnTasks (DOR-3285)', () => {
  /** A session whose turn started these tasks, each with its command. */
  const sessionWith = (tasks: Array<[string, string]>) =>
    ({ turnTaskIds: new Map(tasks), eventQueue: [] }) as unknown as AgentSession;

  it('emits one work_left_running naming each command that did not stop', async () => {
    const { query } = fakeQuery({ stopTask: (id) => (id === 'stops' ? 'acks' : 'rejects') });
    const emit = vi.fn();
    const session = sessionWith([
      ['stops', 'ls'],
      ['tail', 'tail -f server.log'],
      ['unknown', ''],
    ]);

    await endTurnTasks('s-1', session, query, emit);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('s-1', {
      type: 'work_left_running',
      tasks: [
        { taskId: 'tail', command: 'tail -f server.log' },
        { taskId: 'unknown', command: '' },
      ],
    });
    expect([...session.leftRunningTasks!.keys()]).toEqual(['tail', 'unknown']);
  });

  it('emits nothing when every command stopped', async () => {
    const { query } = fakeQuery({});
    const emit = vi.fn();
    const session = sessionWith([['a', 'sleep 5']]);

    await endTurnTasks('s-1', session, query, emit);

    expect(emit).not.toHaveBeenCalled();
    expect(session.leftRunningTasks).toBeUndefined();
  });
});
