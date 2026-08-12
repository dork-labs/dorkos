import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { GlobalEvent } from '@opencode-ai/sdk';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  createOpenCodeEventContext,
  mapOpenCodeTurn,
  matchesOpenCodeSession,
  matchesOpenCodeSubagentSession,
  type OpenCodeEventContext,
  type OpenCodeWireEvent,
} from '../event-mapper.js';

/**
 * Replays of RAW `/global/event` streams captured off a live OpenCode sidecar
 * (probe of 2026-08-11, `opencode-ai` 1.18.15 driving a local Ollama model).
 * Every payload in `fixtures/*.jsonl` is verbatim, in wire order — only two
 * kinds of line were dropped, neither of which the demux would have admitted or
 * the assertions below would have read: events belonging to no session in the
 * turn (heartbeats, plugin/catalog chatter, other directories) and
 * `message.part.delta` text increments.
 *
 * Hand-written orderings are what let DOR-1146 through: the synthetic cancel
 * test fed the aborted `task` part BEFORE the parent's `session.idle`, while the
 * real wire delivers it AFTER — past the terminal the mapper returns on.
 */

/** DorkOS session id — deliberately NOT the OpenCode `ses_*` id. */
const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';

/** One captured stream plus the demux key the runtime would have subscribed with. */
interface Capture {
  readonly events: readonly GlobalEvent[];
  readonly directory: string;
  readonly ocSessionId: string;
}

/**
 * Load a capture and recover its demux key from the capture itself: the parent
 * session is the only one that reports no `parentID`.
 */
function loadCapture(name: string): Capture {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as GlobalEvent);
  for (const event of events) {
    const payload = event.payload as { type: string; properties?: { info?: SessionInfoish } };
    const info = payload.properties?.info;
    if (payload.type === 'session.updated' && info !== undefined && info.parentID === undefined) {
      return { events, directory: event.directory, ocSessionId: info.id };
    }
  }
  throw new Error(`capture ${name} carries no parent session`);
}

/** The `session.created`/`session.updated` payload fields the parent lookup reads. */
interface SessionInfoish {
  id: string;
  parentID?: string;
}

/**
 * Feed the capture through the exact admit filter `opencode-runtime.ts`
 * installs on the shared global stream. Filtering lazily inside the generator
 * is load-bearing: `matchesOpenCodeSubagentSession` reads the child sessions
 * the mapper has learned so far, so each event must be tested only after the
 * previous one has been mapped — which is what a per-pull generator gives.
 */
async function* admit(
  capture: Capture,
  ctx: OpenCodeEventContext
): AsyncGenerator<OpenCodeWireEvent> {
  for (const event of capture.events) {
    const admitted =
      matchesOpenCodeSession(event, capture.directory, capture.ocSessionId) ||
      matchesOpenCodeSubagentSession(event, capture.directory, ctx);
    if (admitted) yield event.payload as OpenCodeWireEvent;
  }
}

/**
 * Map a whole captured turn, exactly as the runtime's `sendMessage` does, and
 * hand back the turn context too — it holds the reply routing the adapter
 * answers permissions through.
 */
async function replayWithContext(
  name: string
): Promise<{ events: StreamEvent[]; ctx: OpenCodeEventContext }> {
  const capture = loadCapture(name);
  const ctx = createOpenCodeEventContext(SESSION_ID);
  const events: StreamEvent[] = [];
  for await (const event of mapOpenCodeTurn(admit(capture, ctx), ctx)) events.push(event);
  return { events, ctx };
}

/** Map a whole captured turn, exactly as the runtime's `sendMessage` does. */
async function replay(name: string): Promise<StreamEvent[]> {
  return (await replayWithContext(name)).events;
}

/** Just the background-task lifecycle, which is what the subagent card renders. */
function taskEvents(events: StreamEvent[]): StreamEvent[] {
  return events.filter((event) => event.type.startsWith('background_task_'));
}

describe('live capture: user stops a turn with a subagent running', () => {
  it('reports the subagent as stopped', async () => {
    const events = await replay('live-cancel.jsonl');
    const done = events.filter((event) => event.type === 'background_task_done');
    expect(done).toHaveLength(1);
    expect(done[0]!.data).toMatchObject({ taskId: 'call_93izxca0', status: 'stopped' });
    expect(StreamEventSchema.safeParse(done[0]).success).toBe(true);
  });

  it('closes the subagent BEFORE the turn terminal, so no event trails done', async () => {
    const events = await replay('live-cancel.jsonl');
    expect(taskEvents(events).map((event) => event.type)).toEqual([
      'background_task_started',
      'background_task_done',
    ]);
    const types = events.map((event) => event.type);
    expect(types.lastIndexOf('background_task_done')).toBeLessThan(types.indexOf('done'));
    expect(types.indexOf('done')).toBe(types.length - 1);
  });

  it('ends the turn with exactly one done and no error — a stop is not a failure', async () => {
    const events = await replay('live-cancel.jsonl');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('starts the subagent once, with the child session it delegated to', async () => {
    const events = await replay('live-cancel.jsonl');
    const started = events.filter((event) => event.type === 'background_task_started');
    expect(started).toHaveLength(1);
    expect(started[0]!.data).toMatchObject({
      taskId: 'call_93izxca0',
      taskType: 'agent',
      description: 'inspect the files',
      subagentSessionId: 'ses_0107a57a2ffeGrKr7yavzAD5U0',
    });
  });
});

describe('live capture: a subagent that finishes normally', () => {
  it('reports started then done{completed}, and nothing else', async () => {
    const events = await replay('live-delegate.jsonl');
    expect(taskEvents(events).map((event) => event.type)).toEqual([
      'background_task_started',
      'background_task_done',
    ]);
    expect(taskEvents(events)[1]!.data).toMatchObject({
      taskId: 'call_brh1zeye',
      status: 'completed',
    });
  });

  it('does not re-close an already-finished subagent at the turn terminal', async () => {
    const events = await replay('live-delegate.jsonl');
    expect(events.filter((event) => event.type === 'background_task_done')).toHaveLength(1);
  });

  it('streams the parent turn and terminates on the parent session.idle', async () => {
    const events = await replay('live-delegate.jsonl');
    expect(events.some((event) => event.type === 'text_delta')).toBe(true);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)!.type).toBe('done');
  });
});

describe('live capture: the stream dies with the child still running', () => {
  /**
   * This capture was cut off mid-run: the child's `bash` call is still
   * `running` and the parent never reached `session.idle`. DorkOS did not
   * observe the turn end, so it must not claim the child stopped — the
   * normalizer's end-of-stream sweep retires it as `untracked` instead
   * (DOR-1108), which is the strongest claim the evidence supports.
   */
  it('reports the child working but never closes it', async () => {
    const events = await replay('live-child-tools.jsonl');
    expect(taskEvents(events).map((event) => event.type)).toEqual([
      'background_task_started',
      'background_task_progress',
    ]);
    expect(taskEvents(events)[1]!.data).toMatchObject({ toolUses: 1, lastToolName: 'bash' });
  });

  it('still terminates the turn exactly once', async () => {
    const events = await replay('live-child-tools.jsonl');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)!.type).toBe('done');
  });

  /**
   * The reason that capture ends mid-run: the child's `bash` call raised a
   * `permission.asked` IN THE CHILD SESSION, the child path dropped it, and the
   * turn sat silent for 7+ minutes with nothing on screen until the probe gave
   * up (DOR-1126). The ask is in the capture verbatim — the mapper simply had
   * nowhere to put it.
   */
  it("surfaces the child's own ask on the parent turn, named for the subagent (DOR-1126)", async () => {
    const { events, ctx } = await replayWithContext('live-child-tools.jsonl');
    const approvals = events.filter((event) => event.type === 'approval_required');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.data).toMatchObject({
      toolCallId: 'per_fef50a146001jQshzG9Vh6W93z',
      toolName: 'bash',
      title: 'The general subagent needs permission',
      input: '{"patterns":["ls -F"],"command":"ls -F"}',
    });
    expect(StreamEventSchema.safeParse(approvals[0]).success).toBe(true);
    // Answering it means answering the CHILD session — the reply route is
    // per-session, and the parent's id would 404 the permission.
    expect(ctx.pendingPermissionSessions.get('per_fef50a146001jQshzG9Vh6W93z')).toBe(
      'ses_010af9e8cffe57H7AZMRP71rhc'
    );
  });
});

describe('live capture: a subagent asks, the operator approves, the run finishes', () => {
  /**
   * The whole DOR-1126 loop, captured through the REAL runtime (probe of
   * 2026-08-11: local Ollama `gemma4:latest`, the adapter's own `bash: ask`
   * ruleset, the card answered by `approveTool()`). The reply went to the CHILD
   * session, the sidecar echoed it, the child's `bash` ran, and the parent turn
   * ended 28s later — where before the ask was never shown and the turn waited.
   */
  it("shows the ask, clears it on the sidecar's echo, and finishes the subagent", async () => {
    const { events, ctx } = await replayWithContext('live-child-permission.jsonl');
    const relevant = events
      .filter((event) => event.type !== 'text_delta' && event.type !== 'thinking_delta')
      .map((event) => event.type);
    expect(relevant).toEqual([
      'tool_call_start',
      'background_task_started',
      'background_task_progress',
      'approval_required',
      'interaction_cancelled',
      'tool_call_end',
      'tool_result',
      'background_task_done',
      'session_status',
      'session_status',
      'session_status',
      'session_status',
      'done',
    ]);

    const approval = events.find((event) => event.type === 'approval_required')!;
    expect(approval.data).toMatchObject({
      toolCallId: 'per_ff0c31fc4001nfdcvgtN85TKvs',
      toolName: 'bash',
      title: 'The general subagent needs permission',
    });
    // The answer was sent to the child session; its echo cleared the card AND
    // (DOR-1148) carries the same Approved receipt an in-DorkOS approve would.
    expect(events.find((event) => event.type === 'interaction_cancelled')!.data).toEqual({
      interactionId: 'per_ff0c31fc4001nfdcvgtN85TKvs',
      reason: 'approved',
    });
    expect(events.find((event) => event.type === 'background_task_done')!.data).toMatchObject({
      status: 'completed',
      toolUses: 1,
    });
    // Nothing outstanding at the terminal, so nothing was withdrawn.
    expect(ctx.pendingPermissionSessions.size).toBe(0);
  });
});

describe('live capture: the user stops the turn while the subagent is asking', () => {
  /**
   * Captured through the real runtime (same probe, `interruptQuery` fired the
   * moment the card appeared). Two things this ordering proves that no
   * hand-written one could:
   *
   * - the sidecar publishes NO `permission.replied` for an ask it abandons, so
   *   the card is only taken down because the turn terminal withdraws it;
   * - the `task` part settles itself here, with the BARE `Task cancelled` and no
   *   `interrupted` flag — the shape `subagentFailureStatus` used to read as a
   *   failure, on the most ordinary stop there is.
   */
  it('withdraws the ask and reports the subagent as stopped, not failed', async () => {
    const { events, ctx } = await replayWithContext('live-child-permission-stop.jsonl');
    const approval = events.find((event) => event.type === 'approval_required')!;
    expect(approval.data).toMatchObject({
      toolCallId: 'per_ff0c80c8d001N16GikRcotWY1j',
      title: 'The general subagent needs permission',
    });

    const cancelled = events.filter((event) => event.type === 'interaction_cancelled');
    expect(cancelled).toHaveLength(1);
    // No `permission.replied` rode this capture at all (see the class doc above)
    // — this withdrawal is the turn-terminal sweep, not an echo, so it carries
    // no `reason` and (DOR-1148) must not fabricate an Approved/Denied receipt
    // for an ask nobody actually answered.
    expect(cancelled[0]!.data).toEqual({ interactionId: 'per_ff0c80c8d001N16GikRcotWY1j' });

    expect(events.find((event) => event.type === 'background_task_done')!.data).toMatchObject({
      taskId: 'call_wzvfj4m1',
      status: 'stopped',
    });
    expect(ctx.pendingPermissionSessions.size).toBe(0);
  });

  it('settles the withdrawal inside the turn, and ends the turn exactly once', async () => {
    const types = (await replay('live-child-permission-stop.jsonl')).map((event) => event.type);
    expect(types.indexOf('interaction_cancelled')).toBeLessThan(types.indexOf('done'));
    expect(types.filter((type) => type === 'done')).toHaveLength(1);
    expect(types.at(-1)).toBe('done');
  });
});
