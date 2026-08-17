/**
 * Stop is bounded (DOR-1244).
 *
 * After Stop, a turn ends within {@link STOP_ACK_TIMEOUT_MS} whatever the CLI is
 * doing. The case that motivated the bound is a turn winding down: DorkOS has
 * already closed the CLI's stdin at the `result` it took for the end of the
 * turn, the CLI kept going and reopened the window, and the SDK now drops every
 * write and waits on an ack that can never arrive. Before this, `interrupt()`
 * never settled, the `close()` escalation behind it was unreachable, and the
 * Stop request hung until the CLI ended on its own.
 *
 * These tests drive `SessionStore` against fake queries that answer the way the
 * SDK does in each case — including the one that answers not at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from '../session-store.js';
import { STOP_ACK_TIMEOUT_MS } from '../bounded-stop.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = 'session-under-stop';

/** How a fake query answers a control request. */
type Answer = 'acks' | 'rejects' | 'never-settles';

interface FakeQuery {
  query: Query;
  /** Every control call the store made on it, counted. */
  calls: { interrupt: number; close: number; stopTask: string[] };
}

/**
 * A fake SDK query. `never-settles` is the wind-down shape: the SDK drops the
 * write to an ended stdin and returns a promise nothing will ever resolve.
 */
function fakeQuery(answers: { interrupt?: Answer; stopTask?: Answer; closeThrows?: boolean }) {
  const calls = { interrupt: 0, close: 0, stopTask: [] as string[] };
  const forever = (): Promise<never> => new Promise<never>(() => {});
  const query = {
    interrupt: (): Promise<unknown> => {
      calls.interrupt++;
      if (answers.interrupt === 'rejects') return Promise.reject(new Error('interrupt refused'));
      if (answers.interrupt === 'never-settles') return forever();
      return Promise.resolve(undefined);
    },
    stopTask: (taskId: string): Promise<unknown> => {
      calls.stopTask.push(taskId);
      if (answers.stopTask === 'rejects') return Promise.reject(new Error('stop_task refused'));
      if (answers.stopTask === 'never-settles') return forever();
      return Promise.resolve(undefined);
    },
    close: (): void => {
      calls.close++;
      if (answers.closeThrows) throw new Error('close failed');
    },
  } as unknown as Query;
  return { query, calls } satisfies FakeQuery;
}

/** A store holding one live session whose turn is running on `query`. */
function storeWithLiveTurn(query: Query): SessionStore {
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  store.findSession(SESSION_ID)!.activeQuery = query;
  return store;
}

/** The phantom-cancellation stamp (DOR-1087) — set means "this stop was asked for". */
function stamp(store: SessionStore): number | undefined {
  return store.findSession(SESSION_ID)!.interruptRequestedAt;
}

describe('Stop is bounded (DOR-1244)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends a turn whose CLI never acknowledges the interrupt, by closing the process', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'never-settles' });
    const store = storeWithLiveTurn(query);

    const stopped = store.interruptQuery(SESSION_ID);
    await vi.advanceTimersByTimeAsync(STOP_ACK_TIMEOUT_MS);

    await expect(stopped).resolves.toBe(true);
    expect(calls.interrupt).toBe(1);
    expect(calls.close).toBe(1);
    // The close cancels every pending tool call, and the CLI writes its
    // interrupt sentinel for each. Those are deliberate, so the stamp the
    // phantom detector reads must survive the escalation.
    expect(stamp(store)).toBeDefined();
  });

  it('leaves a healthy turn to unwind itself: an acknowledged interrupt never closes the process', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'acks' });
    const store = storeWithLiveTurn(query);

    await expect(store.interruptQuery(SESSION_ID)).resolves.toBe(true);

    expect(calls.interrupt).toBe(1);
    expect(calls.close).toBe(0);
    expect(stamp(store)).toBeDefined();
    // No clock is left running behind an ack that already arrived.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the process when the interrupt is refused outright', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'rejects' });
    const store = storeWithLiveTurn(query);

    await expect(store.interruptQuery(SESSION_ID)).resolves.toBe(true);

    expect(calls.close).toBe(1);
    expect(stamp(store)).toBeDefined();
  });

  it('reports failure, and clears the stamp, when neither the interrupt nor the close takes', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'rejects', closeThrows: true });
    const store = storeWithLiveTurn(query);

    await expect(store.interruptQuery(SESSION_ID)).resolves.toBe(false);

    expect(calls.close).toBe(1);
    // Nothing was stopped, so a sentinel arriving now really is a phantom.
    expect(stamp(store)).toBeUndefined();
  });

  it('skips the graceful attempt entirely when DorkOS has already ended that query stdin', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'never-settles' });
    const store = storeWithLiveTurn(query);
    store.findSession(SESSION_ID)!.stdinEndedQuery = query;

    // No clock is advanced: the whole point is that this does not wait.
    await expect(store.interruptQuery(SESSION_ID)).resolves.toBe(true);

    expect(calls.interrupt).toBe(0);
    expect(calls.close).toBe(1);
    expect(stamp(store)).toBeDefined();
  });

  it('still asks politely when the ended stdin belonged to a different, older query', async () => {
    const { query, calls } = fakeQuery({ interrupt: 'acks' });
    const { query: retired } = fakeQuery({ interrupt: 'acks' });
    const store = storeWithLiveTurn(query);
    // An overlapping turn's close must not condemn its successor (DOR-1088).
    store.findSession(SESSION_ID)!.stdinEndedQuery = retired;

    await expect(store.interruptQuery(SESSION_ID)).resolves.toBe(true);

    expect(calls.interrupt).toBe(1);
    expect(calls.close).toBe(0);
  });

  it('gives up on a task stop that is never acknowledged, without killing the turn around it', async () => {
    const { query, calls } = fakeQuery({ stopTask: 'never-settles' });
    const store = storeWithLiveTurn(query);

    const stopped = store.stopTask(SESSION_ID, 'task-7');
    await vi.advanceTimersByTimeAsync(STOP_ACK_TIMEOUT_MS);

    await expect(stopped).resolves.toBe(false);
    expect(calls.stopTask).toEqual(['task-7']);
    // One task was asked to stop, not the whole session.
    expect(calls.close).toBe(0);
    // Nothing was stopped, so the phantom detector must stay unblinded.
    expect(stamp(store)).toBeUndefined();
  });

  it('reports a task stop the CLI acknowledged', async () => {
    const { query, calls } = fakeQuery({ stopTask: 'acks' });
    const store = storeWithLiveTurn(query);

    await expect(store.stopTask(SESSION_ID, 'task-7')).resolves.toBe(true);

    expect(calls.stopTask).toEqual(['task-7']);
    expect(stamp(store)).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
