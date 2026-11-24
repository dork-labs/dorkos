/**
 * Whether a turn is still alive at a `result` (DOR-1238, superseding DOR-1149).
 *
 * The tracker decides one thing: may the CLI's stdin be closed yet. Closing it
 * early does not merely cost the steering opportunity — it CANCELS the tool
 * calls of every segment that follows, which is the bug this answers. So the
 * tests below pin both halves: a live background agent holds the stream open
 * without any deadline at all, and a settled-but-undelivered notification holds
 * it under one.
 */
import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnLiveness } from '../turn-liveness.js';
import {
  readBackgroundTaskFrames,
  readDeliverySegmentFrames,
} from './fixtures/background-tasks.js';

/**
 * The SDK's level signal: the FULL set of live background tasks after a change.
 * Real shape, captured 2026-08-16 — each entry carries its own `task_type`.
 */
function tasksChanged(
  tasks: Array<{ id: string; type: 'local_agent' | 'local_bash' }>
): SDKMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map(({ id, type }) => ({
      task_id: id,
      task_type: type,
      description: `task ${id}`,
    })),
    uuid: `level-${tasks.map((t) => t.id).join('-')}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

/** The SDK lifecycle message saying a background task has settled. */
function taskSettled(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped' = 'completed'
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    session_id: `subagent-${taskId}`,
  } as unknown as SDKMessage;
}

/** The `system/init` that opens a query segment. */
function initFrame(): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: 'sdk-1' } as unknown as SDKMessage;
}

/**
 * What the warm path asks, on top of the resume path's stdin question (spec
 * `warm-process-lifecycle` D1, slice 2).
 *
 * `liveAgentCount` answers "may stdin be closed", where only a subagent has
 * ever counted. The quiet predicate asks a wider question — "is this process
 * doing anything somebody would be upset to lose" — and a Monitor or a task
 * type nobody has catalogued is exactly that.
 */
describe('the warm path reads every live task, not only subagents', () => {
  it('splits live tasks into the ones that hold a process and the ones that do not', () => {
    const liveness = createTurnLiveness();
    liveness.observe(
      tasksChanged([
        { id: 'agent-1', type: 'local_agent' },
        { id: 'agent-2', type: 'local_agent' },
        { id: 'shell-1', type: 'local_bash' },
      ])
    );

    expect(liveness.liveTaskCounts()).toEqual({ agents: 2, shells: 1, other: 0 });
    // The resume path's narrower question is unchanged by any of this.
    expect(liveness.liveAgentCount()).toBe(2);
  });

  it('names every live task, and forgets one once it settles (FB-18)', () => {
    const liveness = createTurnLiveness();
    expect(liveness.liveTaskIds()).toEqual([]);
    liveness.observe(
      tasksChanged([
        { id: 'agent-1', type: 'local_agent' },
        { id: 'shell-1', type: 'local_bash' },
      ])
    );
    expect(liveness.liveTaskIds()).toEqual(['agent-1', 'shell-1']);

    liveness.observe(taskSettled('agent-1'));
    expect(liveness.liveTaskIds()).toEqual(['shell-1']);
  });

  it('gives up on owed deliveries and reports which ones it abandoned', () => {
    const liveness = createTurnLiveness();
    liveness.observe(taskSettled('task-1'));
    liveness.observe(taskSettled('task-2'));
    expect(liveness.owedCount()).toBe(2);

    // The warm path's escape hatch: on the resume path this debt is bounded by
    // a deferred stdin close the pump never performs, so without this a
    // delivery that never arrives holds the queue for the process's life.
    expect(liveness.expireOwed()).toEqual(['task-1', 'task-2']);
    expect(liveness.owedCount()).toBe(0);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });
});

/** A `result` — the end of a segment. */
function resultFrame(): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: 'sdk-1' } as unknown as SDKMessage;
}

describe('createTurnLiveness — notifications owed a delivery', () => {
  // The case the first attempt at this fix got wrong: a task SETTLES before the
  // `result` that ends the segment, so keying on "tasks still running" left
  // nothing outstanding at the moment it mattered.
  it('holds the stream open after a task settles but before its delivery', () => {
    const liveness = createTurnLiveness();
    liveness.observe(taskSettled('t1'));
    expect(liveness.owedCount()).toBe(1);
    // Owed with nothing live is the ONLY hold that gets a deadline.
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: true });
  });
});

// The correction DOR-1238's review forced. DOR-1149 keyed the delivery on a
// `<task-notification>` USER message, which exists only in the JSONL transcript
// and is never yielded on the SDK stream — so `owed` only ever grew and every
// background-task turn ended by deadline expiry. What the stream really shows
// is a second `system/init` opening the segment the queue drains into.
describe('createTurnLiveness — what a delivery looks like ON THE STREAM (DOR-1238)', () => {
  it('a post-result init drains what was owed and reports a segment running', () => {
    const liveness = createTurnLiveness();
    liveness.observe(initFrame());
    liveness.observe(taskSettled('t1'));
    liveness.observe(taskSettled('t2'));
    expect(liveness.observe(resultFrame())).toEqual({ segmentRunning: false });
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: true });

    expect(liveness.observe(initFrame())).toEqual({ segmentRunning: true });
    expect(liveness.owedCount()).toBe(0);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });
});

describe('createTurnLiveness — background agents still running (DOR-1238)', () => {
  it('holds the stream open, with NO deadline, while an agent is live', () => {
    const liveness = createTurnLiveness();
    liveness.observe(tasksChanged([{ id: 'agent-1', type: 'local_agent' }]));
    expect(liveness.liveAgentCount()).toBe(1);
    // No deadline: the level signal is self-correcting, so a hold that waits on
    // it cannot wedge — and expiring one mid-segment is the bug (DOR-1238).
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: false });
  });
});

// The capture is the contract: if an SDK bump changes these shapes, this suite
// is where it shows up rather than in a production session.
describe('createTurnLiveness — against the captured SDK 0.3.224 stream', () => {
  it('follows one real agent and one real shell from launch to settle', () => {
    const liveness = createTurnLiveness();
    const frames = readBackgroundTaskFrames();
    const seen: Array<{ live: number; owed: number }> = [];
    for (const frame of frames) {
      liveness.observe(frame);
      seen.push({ live: liveness.liveAgentCount(), owed: liveness.owedCount() });
    }

    // Frame 0 is the level frame that announces the agent; the shell that joins
    // it at frame 2 never adds to the live count.
    expect(seen[0]).toEqual({ live: 1, owed: 0 });
    expect(seen[2]).toEqual({ live: 1, owed: 0 });
    // Frame 4 is the level frame that drops the agent, leaving the shell alone.
    expect(seen[4]).toEqual({ live: 0, owed: 0 });
    // Frame 6 is the agent's notification: settled, delivery now owed.
    expect(seen[6]).toEqual({ live: 0, owed: 1 });
    // The shell's own notification is owed a delivery too — it is a settle like
    // any other; what the shell never does is hold the stream open while it RUNS.
    expect(liveness.owedCount()).toBe(2);
    expect(liveness.liveAgentCount()).toBe(0);
  });
});

// The whole turn, replayed off the wire. This is the suite that would have
// caught DOR-1149's mistaken model: there is no user message to key on here,
// because the CLI never sends one.
describe('createTurnLiveness — against the captured delivery segment', () => {
  /**
   * A fresh tracker and the captured frames. The capture carries no `result`
   * (see the fixture module), so each test feeds them in at the two points the
   * real stream had them — after LAUNCHED, and at the end of the delivery
   * segment.
   */
  function replay(): { liveness: ReturnType<typeof createTurnLiveness>; frames: SDKMessage[] } {
    const frames = readDeliverySegmentFrames();
    return { liveness: createTurnLiveness(), frames };
  }

  it('holds at the first result, then closes at the second — no deadline ever needed', () => {
    const { liveness, frames } = replay();
    // The turn's own init, the level frame, and both task_started frames.
    for (const frame of frames.slice(0, 4)) liveness.observe(frame);
    expect(liveness.liveAgentCount()).toBe(1);

    // RESULT #1: the main segment ends with the agent still running.
    liveness.observe(resultFrame());
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: false });

    // The shell settles, the level frame empties, the agent settles.
    for (const frame of frames.slice(4, 8)) liveness.observe(frame);
    expect(liveness.liveAgentCount()).toBe(0);
    expect(liveness.owedCount()).toBe(2);
    // Had a result landed here it would have armed the deadline — the only
    // window in the whole turn where one is warranted.
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: true });

    // The SECOND init: the delivery segment opens and drains the queue.
    expect(liveness.observe(frames[8]!)).toEqual({ segmentRunning: true });
    expect(liveness.owedCount()).toBe(0);
    // Its first assistant frame keeps saying "a segment is running".
    expect(liveness.observe(frames[9]!)).toEqual({ segmentRunning: true });

    // RESULT #2: nothing live, nothing owed — stdin closes on the clean path.
    liveness.observe(resultFrame());
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });
});

/**
 * A run id in the CLI's real shape (SDK 0.3.304): the run's start time in base
 * 36, padded to nine characters, then eight hex digits. Ids of one task sort,
 * as plain strings, in the order the runs opened.
 */
function runIdAt(ms: number, hex: string): string {
  return `${ms.toString(36).padStart(9, '0')}-${hex}`;
}

/** An earlier and a later run of one task. */
const RUN_1 = runIdAt(Date.UTC(2026, 10, 1, 20, 0, 0), '1a2b3c4d');
const RUN_2 = runIdAt(Date.UTC(2026, 10, 1, 20, 5, 0), '9f8e7d6c');

/** A level frame whose entries name the run each task is on (SDK 0.3.304). */
function tasksChangedWithRuns(
  tasks: Array<{ id: string; type: 'local_agent' | 'local_bash'; runId: string }>
): SDKMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map(({ id, type, runId }) => ({
      task_id: id,
      run_id: runId,
      task_type: type,
      description: `task ${id}`,
    })),
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

/** A settle that names its run, and optionally keeps itself out of the transcript. */
function runSettled(taskId: string, runId: string | undefined, extra: object = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    ...(runId !== undefined ? { run_id: runId } : {}),
    status: 'completed',
    ...extra,
    session_id: `subagent-${taskId}`,
  } as unknown as SDKMessage;
}

/** A task starting, in the foreground or the background. */
function taskStarted(taskId: string, backgrounded: boolean, runId?: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    ...(runId !== undefined ? { run_id: runId } : {}),
    task_type: 'local_agent',
    description: `task ${taskId}`,
    is_backgrounded: backgrounded,
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

// DOR-3755. A resumed task keeps its `task_id` and gets a new `run_id`, and
// the run ids of one task sort in the order the runs opened (`sdk.d.ts`). Keyed
// on the task id alone, a late settle from the old run deleted the NEW run's
// live entry, and the helper still working read as gone.
describe('createTurnLiveness — one task, several runs (DOR-3755)', () => {
  it("a late settle from an earlier run leaves the newer run's helper live", () => {
    const liveness = createTurnLiveness();
    liveness.observe(tasksChangedWithRuns([{ id: 'agent-1', type: 'local_agent', runId: RUN_2 }]));
    liveness.observe(runSettled('agent-1', RUN_1));

    expect(liveness.liveAgentCount()).toBe(1);
    // A live helper holds with no deadline, whatever else is owed.
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: false });
  });

  it('two runs of one task that both settle owe two deliveries, cleared one at a time', () => {
    const liveness = createTurnLiveness();
    liveness.observe(runSettled('agent-1', RUN_1));
    liveness.observe(runSettled('agent-1', RUN_2));
    expect(liveness.owedCount()).toBe(2);

    // One consumed prompt clears one debt, the older one.
    expect(liveness.clearOldestOwed(1)).toEqual(['agent-1']);
    expect(liveness.owedCount()).toBe(1);
  });
});

// DOR-3755. The CLI emits `task_notification` for every task it registers. A
// foreground task's result already went back inline as its tool result, and a
// `skip_transcript` task is never put in front of the model, so neither is
// ever delivered — and a debt for one held the turn for the full deadline.
describe('createTurnLiveness — settles nothing is delivered for (DOR-3755)', () => {
  it('a foreground task owes nothing, so the result closes at once', () => {
    const liveness = createTurnLiveness();
    liveness.observe(taskStarted('fg-1', false));
    liveness.observe(runSettled('fg-1', undefined));
    liveness.observe(resultFrame());

    expect(liveness.owedCount()).toBe(0);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });
});
