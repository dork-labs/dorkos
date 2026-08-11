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

/** Map a whole captured turn, exactly as the runtime's `sendMessage` does. */
async function replay(name: string): Promise<StreamEvent[]> {
  const capture = loadCapture(name);
  const ctx = createOpenCodeEventContext(SESSION_ID);
  const out: StreamEvent[] = [];
  for await (const event of mapOpenCodeTurn(admit(capture, ctx), ctx)) out.push(event);
  return out;
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
});
