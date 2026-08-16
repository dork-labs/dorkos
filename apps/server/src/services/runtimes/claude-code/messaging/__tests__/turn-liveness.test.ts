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
  AGENT_TASK_ID,
  DELIVERY_AGENT_TASK_ID,
  SHELL_TASK_ID,
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

/** A `result` — the end of a segment. */
function resultFrame(): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: 'sdk-1' } as unknown as SDKMessage;
}

/** The model speaking inside a segment. */
function assistantFrame(): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'a-1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
  } as unknown as SDKMessage;
}

describe('createTurnLiveness — notifications owed a delivery', () => {
  it('does not hold the stream open when nothing is owed and nothing is live', () => {
    const liveness = createTurnLiveness();
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });

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

  it.each(['failed', 'stopped'] as const)('owes a delivery for a %s task too', (status) => {
    const liveness = createTurnLiveness();
    liveness.observe(taskSettled('t1', status));
    expect(liveness.holdOpenAtResult().hold).toBe(true);
  });

  it('ignores a settle with no task id rather than owing an unmatchable delivery', () => {
    const liveness = createTurnLiveness();
    liveness.observe({ type: 'system', subtype: 'task_notification' } as unknown as SDKMessage);
    expect(liveness.owedCount()).toBe(0);
  });

  it('ignores messages that say nothing about background work', () => {
    const liveness = createTurnLiveness();
    liveness.observe({ type: 'system', subtype: 'status' } as unknown as SDKMessage);
    liveness.observe({ type: 'system', subtype: 'task_progress' } as unknown as SDKMessage);
    liveness.observe(resultFrame());
    expect(liveness.owedCount()).toBe(0);
    expect(liveness.liveAgentCount()).toBe(0);
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

  // The turn's own init opens nothing new, so it must not drain a queue that
  // has not been handed over.
  it('the turn opening init is not a delivery segment', () => {
    const liveness = createTurnLiveness();
    liveness.observe(taskSettled('t1'));
    expect(liveness.observe(initFrame())).toEqual({ segmentRunning: false });
    expect(liveness.owedCount()).toBe(1);
  });

  // The model speaking proves a segment is under way and that a `result` will
  // close it — enough to drop a deadline, but it hands nothing over, so the
  // queue stands.
  it.each(['assistant', 'stream_event'])('%s activity releases without draining owed', (type) => {
    const liveness = createTurnLiveness();
    liveness.observe(taskSettled('t1'));
    liveness.observe(resultFrame());
    const change = liveness.observe({ ...assistantFrame(), type } as unknown as SDKMessage);
    expect(change).toEqual({ segmentRunning: true });
    expect(liveness.owedCount()).toBe(1);
  });

  // These promise no `result`, so releasing a deadline on them could leave the
  // turn held open with nothing coming and nothing to bound it.
  it.each(['task_progress', 'task_updated', 'background_tasks_changed'])(
    '%s never reports a segment running',
    (subtype) => {
      const liveness = createTurnLiveness();
      liveness.observe(resultFrame());
      const change = liveness.observe({
        type: 'system',
        subtype,
        tasks: [],
        session_id: 'sdk-1',
      } as unknown as SDKMessage);
      expect(change).toEqual({ segmentRunning: false });
    }
  );

  it('the tag DOR-1149 keyed on is no longer read at all', () => {
    const liveness = createTurnLiveness();
    liveness.observe(taskSettled('t1'));
    liveness.observe(resultFrame());
    // The transcript-only shape. Were this still parsed, `owed` would drop.
    const change = liveness.observe({
      type: 'user',
      session_id: 'sdk-1',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: '<task-notification><task-id>t1</task-id></task-notification>',
      },
    } as unknown as SDKMessage);
    expect(change).toEqual({ segmentRunning: false });
    expect(liveness.owedCount()).toBe(1);
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

  it('lets go once the agent leaves the level set', () => {
    const liveness = createTurnLiveness();
    liveness.observe(tasksChanged([{ id: 'agent-1', type: 'local_agent' }]));
    liveness.observe(tasksChanged([]));
    expect(liveness.liveAgentCount()).toBe(0);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });

  // Background SHELLS are out of scope: the CLI kills them 5s after stdin ends
  // and always did, so holding for one would change behaviour nobody asked to
  // change.
  it('a background shell does not hold the stream open', () => {
    const liveness = createTurnLiveness();
    liveness.observe(tasksChanged([{ id: 'shell-1', type: 'local_bash' }]));
    expect(liveness.liveAgentCount()).toBe(0);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });

  it('counts the agents in a mixed set and ignores the shells beside them', () => {
    const liveness = createTurnLiveness();
    liveness.observe(
      tasksChanged([
        { id: 'agent-1', type: 'local_agent' },
        { id: 'shell-1', type: 'local_bash' },
        { id: 'agent-2', type: 'local_agent' },
      ])
    );
    expect(liveness.liveAgentCount()).toBe(2);
  });

  // REPLACE semantics, per `sdk.d.ts`: the latest frame IS the membership. An id
  // that only ever appeared on an edge bookend is not live, so a `task_started`
  // whose task was killed without a bookend cannot pin the stream open.
  it('takes the latest level frame as authoritative, never the edge bookends', () => {
    const liveness = createTurnLiveness();
    liveness.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'started-only',
      task_type: 'local_agent',
    } as unknown as SDKMessage);
    expect(liveness.liveAgentCount()).toBe(0);

    liveness.observe(tasksChanged([{ id: 'agent-1', type: 'local_agent' }]));
    liveness.observe(tasksChanged([{ id: 'agent-2', type: 'local_agent' }]));
    expect(liveness.liveAgentCount()).toBe(1);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: false });
  });

  // Belt and braces. The level frame that drops the agent precedes its
  // notification in every capture, so this is not what normally clears it — but
  // a settled task is definitionally no longer running, whatever order the two
  // arrive in.
  it('a settled agent stops being live even without a level frame', () => {
    const liveness = createTurnLiveness();
    liveness.observe(tasksChanged([{ id: 'agent-1', type: 'local_agent' }]));
    liveness.observe(taskSettled('agent-1'));
    expect(liveness.liveAgentCount()).toBe(0);
    // Settled, so a delivery is now owed — and THAT hold does get a deadline.
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: true });
  });

  // The cap (`MAX_DEFERRED_SEGMENT_CLOSES`, 8) was a third way to close early.
  // A turn with a chatty helper is legitimately many segments long.
  it('holds at every result for as long as the agent lives — there is no cap', () => {
    const liveness = createTurnLiveness();
    liveness.observe(tasksChanged([{ id: 'agent-1', type: 'local_agent' }]));
    for (let i = 0; i < 40; i++) {
      expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: false });
    }
  });

  // This runs inside the pump's message loop, where ANY throw leaves the
  // `for await` and is reported as the process dying. A malformed frame must
  // not be able to fake a crash.
  it('survives a level frame with no usable tasks, and keeps holding', () => {
    const liveness = createTurnLiveness();
    liveness.observe(tasksChanged([{ id: 'agent-1', type: 'local_agent' }]));

    for (const malformed of [
      { type: 'system', subtype: 'background_tasks_changed', session_id: 'sdk-1' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: null, session_id: 'sdk-1' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: 'nope', session_id: 'sdk-1' },
    ]) {
      expect(() => liveness.observe(malformed as unknown as SDKMessage)).not.toThrow();
    }
    // DELIBERATE: the set is left alone rather than cleared. A frame we cannot
    // read is not evidence that the agents stopped, and dropping a hold is the
    // failure this module exists to prevent.
    expect(liveness.liveAgentCount()).toBe(1);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: false });
  });

  it('skips entries with no usable task id but keeps the rest of the frame', () => {
    const liveness = createTurnLiveness();
    liveness.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_type: 'local_agent', description: 'no id' },
        null,
        { task_id: 42, task_type: 'local_agent' },
        { task_id: 'agent-real', task_type: 'local_agent', description: 'fine' },
      ],
      session_id: 'sdk-1',
    } as unknown as SDKMessage);
    expect(liveness.liveAgentCount()).toBe(1);
  });

  it('a live agent outranks an owed delivery: the hold takes no deadline', () => {
    const liveness = createTurnLiveness();
    liveness.observe(
      tasksChanged([
        { id: 'agent-1', type: 'local_agent' },
        { id: 'agent-2', type: 'local_agent' },
      ])
    );
    liveness.observe(taskSettled('agent-2'));
    expect(liveness.liveAgentCount()).toBe(1);
    expect(liveness.owedCount()).toBe(1);
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

  it('holds the stream open at a result taken while the captured agent is live', () => {
    const liveness = createTurnLiveness();
    const frames = readBackgroundTaskFrames();
    // Everything up to (not including) the level frame that drops the agent.
    for (const frame of frames.slice(0, 4)) liveness.observe(frame);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: true, armDeadline: false });

    liveness.observe(frames[4]!);
    expect(liveness.holdOpenAtResult()).toEqual({ hold: false, armDeadline: false });
  });

  it('reads the agent and the shell apart by task_type, not by session_id', () => {
    const liveness = createTurnLiveness();
    const frames = readBackgroundTaskFrames();
    liveness.observe(frames[2]!); // both tasks live
    expect(liveness.liveAgentCount()).toBe(1);
    liveness.observe(taskSettled(AGENT_TASK_ID));
    expect(liveness.liveAgentCount()).toBe(0);
    liveness.observe(taskSettled(SHELL_TASK_ID));
    expect(liveness.owedCount()).toBe(2);
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

  it('never sees a task-notification user message in the whole capture', () => {
    const users = readDeliverySegmentFrames().filter((f) => f.type === 'user');
    expect(users.some((f) => JSON.stringify(f).includes('<task-notification>'))).toBe(false);
  });

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

  it('the captured second init really is an init that follows a result', () => {
    const frames = readDeliverySegmentFrames();
    const inits = frames.filter(
      (f) => f.type === 'system' && 'subtype' in f && f.subtype === 'init'
    );
    expect(inits).toHaveLength(2);
    expect(frames.indexOf(inits[1]!)).toBe(8);
    // The agent's settle is the frame immediately before it.
    const settle = frames[7] as unknown as { subtype: string; task_id: string };
    expect(settle.subtype).toBe('task_notification');
    expect(settle.task_id).toBe(DELIVERY_AGENT_TASK_ID);
  });
});
