/**
 * The wake rules for work Codex keeps running after a turn (spec
 * `codex-app-server-transport` §12): one coalesced wake per burst, a model
 * turn only after a turn that ended normally, nothing on a clock, a bounded
 * pending gate, and a ceiling that stops without waking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_CEILING_COPY,
  BACKGROUND_WORK_LOST_COPY,
  CodexBackgroundWork,
  SEGMENT_PENDING_BOUND_MS,
  WAKE_COALESCE_MS,
  buildBackgroundUpdate,
  type BackgroundTask,
  type BackgroundWake,
} from '../background-work.js';

const task = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: 'cmd-1',
  kind: 'bash',
  sessionId: 's1',
  threadId: 't1',
  processKey: 'p1',
  processId: '4242',
  label: 'sleep 3; echo done',
  turnStatus: 'completed',
  ...overrides,
});

/** The late `item/completed` the binary sends for a background command. */
const commandDone = (id: string, exitCode = 0, output = 'done\n') => ({
  method: 'item/completed',
  params: {
    threadId: 't1',
    turnId: 'old-turn',
    item: {
      type: 'commandExecution',
      id,
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      aggregatedOutput: output,
    },
  },
});

let wakes: BackgroundWake[];
let gateChanges: string[];
let terminated: string[];
let now: number;

function tracker(onWake: (wake: BackgroundWake) => boolean = () => true) {
  return new CodexBackgroundWork({
    onWake: (wake) => {
      wakes.push(wake);
      return onWake(wake);
    },
    terminate: async (t) => {
      terminated.push(t.taskId);
    },
    onGateChange: (sessionId) => gateChanges.push(sessionId),
    now: () => now,
  });
}

/** Feed a late notification the way the transport does. */
function late(work: CodexBackgroundWork, notification: { method: string; params: unknown }) {
  const done = work.completionOf(notification);
  if (!done) return false;
  work.finish(done.task.taskId);
  work.queue(done.task.sessionId, done.completion);
  return true;
}

beforeEach(() => {
  vi.useFakeTimers();
  wakes = [];
  gateChanges = [];
  terminated = [];
  now = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a background command finishing after its turn', () => {
  it('wakes the chat once, with a model turn, after a burst coalesces', () => {
    const work = tracker();
    work.track([task(), task({ taskId: 'cmd-2', processId: '4243', label: 'make' })]);
    expect(work.holds('s1')).toBe(true);

    expect(late(work, commandDone('cmd-1'))).toBe(true);
    vi.advanceTimersByTime(WAKE_COALESCE_MS / 2);
    expect(late(work, commandDone('cmd-2', 2, 'boom\n'))).toBe(true);
    expect(wakes).toHaveLength(0);

    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ sessionId: 's1', startTurn: true, notices: [] });
    expect(wakes[0]!.completions.map((c) => [c.taskId, c.status])).toEqual([
      ['cmd-1', 'completed'],
      ['cmd-2', 'failed'],
    ]);
    expect(wakes[0]!.completions[1]!.summary).toBe('Exit code 2.\nboom\n');
    expect(work.holds('s1')).toBe(false);

    // Nothing more, ever: a wake follows a completion and nothing else.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(wakes).toHaveLength(1);
  });

  it('shows a completion but starts no model turn when its turn was stopped or failed', () => {
    const work = tracker();
    work.track([task({ turnStatus: 'interrupted' })]);
    expect(work.holds('s1')).toBe(false);
    late(work, commandDone('cmd-1'));
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ startTurn: false });
    expect(wakes[0]!.completions[0]).toMatchObject({ status: 'completed', wakes: false });
  });

  it('ignores notifications about anything it does not track', () => {
    const work = tracker();
    work.track([task()]);
    expect(late(work, commandDone('someone-else'))).toBe(false);
    expect(late(work, { method: 'item/agentMessage/delta', params: {} })).toBe(false);
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(wakes).toHaveLength(0);
  });

  it('keeps only the last 2 KB of output in the report', () => {
    const work = tracker();
    work.track([task()]);
    late(work, commandDone('cmd-1', 0, 'x'.repeat(5_000) + 'END'));
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    const summary = wakes[0]!.completions[0]!.summary;
    expect(summary.endsWith('END')).toBe(true);
    expect(summary.length).toBeLessThan(2_100);
  });
});

describe('a terminal that never ends', () => {
  it('never wakes the chat; the ceiling stops it once and its end wakes nobody', () => {
    const ceiling = 60_000;
    const work = new CodexBackgroundWork({
      onWake: (wake) => {
        wakes.push(wake);
        return true;
      },
      terminate: async (t) => {
        terminated.push(t.taskId);
      },
      ceilingMs: ceiling,
      now: () => now,
    });
    work.track([task({ label: 'pnpm dev' })]);
    vi.advanceTimersByTime(ceiling - 1);
    expect(wakes).toHaveLength(0);
    expect(terminated).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(terminated).toEqual(['cmd-1']);
    // Stopped by the ceiling: it holds nothing that could wake the chat.
    expect(work.holds('s1')).toBe(false);
    late(work, commandDone('cmd-1', 143, ''));
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ startTurn: false });
    expect(wakes[0]!.completions[0]).toMatchObject({
      status: 'stopped',
      summary: BACKGROUND_CEILING_COPY,
      wakes: false,
    });
    vi.advanceTimersByTime(ceiling * 10);
    expect(terminated).toEqual(['cmd-1']);
    expect(wakes).toHaveLength(1);
  });

  it('forgets a task Codex could not stop at the ceiling', async () => {
    const work = new CodexBackgroundWork({
      onWake: () => true,
      terminate: async () => {
        throw new Error('gone');
      },
      ceilingMs: 10,
    });
    work.track([task()]);
    await vi.advanceTimersByTimeAsync(10);
    expect(work.taskOf('s1', 'cmd-1')).toBeUndefined();
  });
});

describe('the pending gate', () => {
  it('holds a queued message from the first completion, and is bounded', () => {
    const work = tracker();
    work.track([task()]);
    expect(work.isPending('s1')).toBe(false);
    late(work, commandDone('cmd-1'));
    expect(work.isPending('s1')).toBe(true);
    expect(work.isPending('someone-else')).toBe(false);
    now = SEGMENT_PENDING_BOUND_MS;
    expect(work.isPending('s1')).toBe(false);
  });

  it('releases the gate when the wake opens, and announces it when nobody took it', () => {
    const work = tracker(() => false);
    work.track([task()]);
    late(work, commandDone('cmd-1'));
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(work.isPending('s1')).toBe(false);
    expect(gateChanges).toEqual(['s1']);
  });
});

describe('stops and lost processes', () => {
  it('reports a task a person stopped as stopped, and never wakes the model for it', () => {
    const work = tracker();
    work.track([task()]);
    work.markStopping('cmd-1');
    expect(work.holds('s1')).toBe(false);
    late(work, commandDone('cmd-1', 143));
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(wakes[0]).toMatchObject({ startTurn: false });
    expect(wakes[0]!.completions[0]).toMatchObject({ status: 'stopped', wakes: false });
  });

  it('says it lost track when the process goes away, once per session, never a model turn', () => {
    const work = tracker();
    work.track([
      task(),
      task({ taskId: 'cmd-2', processId: '9' }),
      task({ taskId: 'other', sessionId: 's2', processKey: 'p2' }),
    ]);
    work.processGone('p1');
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(wakes).toEqual([
      { sessionId: 's1', completions: [], startTurn: false, notices: [BACKGROUND_WORK_LOST_COPY] },
    ]);
    expect(work.taskOf('s2', 'other')).toBeDefined();
  });

  it('forgets a command missing from two lists in a row, without a report', () => {
    const work = tracker();
    work.track([task()]);
    work.reconcile('t1', new Set());
    expect(work.taskOf('s1', 'cmd-1')).toBeDefined();
    work.reconcile('t1', new Set(['4242']));
    work.reconcile('t1', new Set());
    expect(work.taskOf('s1', 'cmd-1')).toBeDefined();
    work.reconcile('t1', new Set());
    expect(work.taskOf('s1', 'cmd-1')).toBeUndefined();
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(wakes).toHaveLength(0);
  });
});

describe('helper agents', () => {
  it('finishes a tracked helper on its late subAgentActivity', () => {
    const work = tracker();
    work.track([task({ taskId: 'agent-thread', kind: 'agent', label: '/root/helper' })]);
    const done = work.completionOf({
      method: 'item/completed',
      params: {
        item: {
          type: 'subAgentActivity',
          id: 'x',
          kind: 'completed',
          agentThreadId: 'agent-thread',
        },
      },
    });
    expect(done?.completion).toMatchObject({ kind: 'agent', status: 'completed', wakes: true });
  });
});

describe('the notice a woken agent reads', () => {
  it('names each finished task, its outcome and its output, in a DorkOS block', () => {
    const text = buildBackgroundUpdate([
      {
        taskId: 'cmd-1',
        kind: 'bash',
        label: 'npm test',
        status: 'failed',
        summary: 'Exit code 1.\n3 failing',
        wakes: true,
      },
    ]);
    expect(text).toMatch(/^<background_update>/);
    expect(text).toContain('Command `npm test` (failed):\nExit code 1.\n3 failing');
    expect(text).toContain('</background_update>');
  });
});
