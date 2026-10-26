/**
 * A Stop ends the work its turn started (DOR-3285).
 *
 * Measured on Claude Code 2.1.304 (SDK 0.3.304), open input: `interrupt()`
 * stops a FOREGROUND shell, but a shell already in the background (started with
 * `run_in_background`, or moved there past its 120 s timeout) runs on to the end
 * and wakes the agent. On 2026-10-26 that is how a stopped turn still filed two
 * tickets. `stopTask(taskId)` after the interrupt does end it, so the store
 * stops every shell the stopped turn started, by its task id, and says so in
 * the chat when one will not stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from '../session-store.js';
import { STILL_RUNNING_NOTICE } from '../../sdk/turn-work-stop.js';
import { STOP_ACK_TIMEOUT_MS } from '../bounded-control.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
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
  session.turnTaskIds = new Set(taskIds);
  return store;
}

const notices = (store: SessionStore) =>
  store
    .findSession(SESSION_ID)!
    .eventQueue.filter((e) => e.type === 'system_status')
    .map((e) => (e.data as { message?: string }).message);

describe('a Stop ends the work its turn started (DOR-3285)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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
    expect(notices(store)).toEqual([]);
  });

  it('stops nothing when the turn started no background work', async () => {
    const { query, calls } = fakeQuery({});
    const store = storeWithTurnWork(query, []);
    await store.interruptQuery(SESSION_ID);
    expect(calls.stopTask).toEqual([]);
  });

  it('says plainly in the chat when a command it started will not stop', async () => {
    const { query, calls } = fakeQuery({
      stopTask: (taskId) => (taskId === 'stubborn' ? 'rejects' : 'acks'),
    });
    const store = storeWithTurnWork(query, ['stubborn', 'stops-fine']);

    await store.interruptQuery(SESSION_ID);

    expect(calls.stopTask).toEqual(['stubborn', 'stops-fine']);
    expect([...store.findSession(SESSION_ID)!.turnTaskIds!]).toEqual(['stubborn']);
    expect(notices(store)).toEqual([STILL_RUNNING_NOTICE]);
  });

  it('treats a stop the CLI never answers as still running, inside the stop bound', async () => {
    const { query } = fakeQuery({ stopTask: () => 'never-settles' });
    const store = storeWithTurnWork(query, ['silent']);

    const stopping = store.interruptQuery(SESSION_ID);
    await vi.advanceTimersByTimeAsync(STOP_ACK_TIMEOUT_MS + 1);
    await expect(stopping).resolves.toMatchObject({ outcome: 'acked' });
    expect(notices(store)).toEqual([STILL_RUNNING_NOTICE]);
  });

  it('asks nothing more of a process it had to close: its work ends with it', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'rejects' });
    const store = storeWithTurnWork(query, ['bg-filing']);

    await expect(store.interruptQuery(SESSION_ID)).resolves.toMatchObject({ outcome: 'closed' });
    expect(calls.close).toBe(1);
    expect(calls.stopTask).toEqual([]);
  });
});
