/**
 * What the fleet is told a session is DOING, and when.
 *
 * The lifecycle fan-out already tells the sidebar that a session is streaming.
 * These tests cover the second half: the tool the session is streaming THROUGH,
 * throttled so a chatty turn cannot flood every connected client, and cleared
 * the moment the turn is over — a stale verb that outlives its turn is a lie,
 * and worse than no verb at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getOrCreateProjector,
  disposeProjector,
  onProjectorStatusChange,
  ACTIVITY_FANOUT_THROTTLE_MS,
} from '../session-state-projector.js';
import type { RawSessionEvent, ProjectorStatusUpdate } from '../session-state-projector.js';
import type { SessionActivity } from '@dorkos/shared/session-stream';

const unsubs: Array<() => void> = [];

/** Register a status listener that is torn down after the test. */
function listen(fn: (u: ProjectorStatusUpdate) => void): void {
  unsubs.push(onProjectorStatusChange(fn));
}

/** A `tool_call` event for `toolName` with a JSON `input`. */
function toolCall(toolName: string, input: Record<string, unknown>): RawSessionEvent {
  return {
    type: 'tool_call',
    toolCallId: `tc-${toolName}`,
    toolName,
    status: 'running',
    input: JSON.stringify(input),
  } as RawSessionEvent;
}

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.();
  vi.useRealTimers();
});

describe('projector activity fan-out', () => {
  it('announces the first tool of a turn immediately', () => {
    vi.useFakeTimers();
    const p = getOrCreateProjector('act-1', '/work/alpha');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    expect(updates.at(-1)?.status.activity).toBeUndefined();

    p.ingest(toolCall('Edit', { file_path: '/repo/strip-state.ts' }));
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({
      sessionId: 'act-1',
      cwd: '/work/alpha',
      status: { lifecycle: 'streaming', activity: { toolName: 'Edit', target: 'strip-state.ts' } },
    });

    disposeProjector('act-1');
  });

  it('throttles a chatty turn, then flushes the LATEST tool once the window passes', () => {
    vi.useFakeTimers();
    const p = getOrCreateProjector('act-2');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Read', { file_path: '/repo/a.ts' }));
    expect(updates).toHaveLength(2);

    // Three more tools inside one window: the wire must not carry three more
    // events, and what finally lands must be the last of them, not the first.
    vi.advanceTimersByTime(200);
    p.ingest(toolCall('Read', { file_path: '/repo/b.ts' }));
    vi.advanceTimersByTime(200);
    p.ingest(toolCall('Read', { file_path: '/repo/c.ts' }));
    vi.advanceTimersByTime(200);
    p.ingest(toolCall('Grep', { pattern: 'deriveStripState' }));
    expect(updates).toHaveLength(2);

    vi.advanceTimersByTime(ACTIVITY_FANOUT_THROTTLE_MS);
    expect(updates).toHaveLength(3);
    expect(updates.at(-1)?.status.activity).toEqual({
      toolName: 'Grep',
      target: 'deriveStripState',
    });

    disposeProjector('act-2');
  });

  it('clears the activity at turn_end, and never lets a throttled one land after it', () => {
    vi.useFakeTimers();
    const p = getOrCreateProjector('act-3');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Bash', { command: 'pnpm verify' }));
    // A second tool arms the trailing flush…
    p.ingest(toolCall('Bash', { command: 'pnpm build' }));
    // …and then the turn ends before that flush was due.
    p.ingest({ type: 'turn_end' });

    const settled = updates.at(-1);
    expect(settled?.status.lifecycle).toBe('idle');
    expect(settled?.status.activity).toBeUndefined();

    const afterTurn = updates.length;
    vi.advanceTimersByTime(ACTIVITY_FANOUT_THROTTLE_MS * 3);
    expect(updates).toHaveLength(afterTurn);
    expect(p.getStatus().activity).toBeUndefined();

    disposeProjector('act-3');
  });

  it('clears the activity on a turn error, without waiting for the throttle', () => {
    vi.useFakeTimers();
    const p = getOrCreateProjector('act-4');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Bash', { command: 'pnpm verify' }));
    const beforeError = updates.length;

    // A typed error does not move the lifecycle (a turn can recover), so this
    // clear has nothing else to ride out on — it must fan out on its own.
    p.ingest({ type: 'error', message: 'boom' } as RawSessionEvent);
    expect(updates.length).toBe(beforeError + 1);
    expect(updates.at(-1)?.status.activity).toBeUndefined();
    expect(p.getStatus().activity).toBeUndefined();

    disposeProjector('act-4');
  });

  it('clears the activity when a dangling turn is marked interrupted', () => {
    const p = getOrCreateProjector('act-5');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Bash', { command: 'sleep 600' }));
    p.markInterrupted();

    expect(updates.at(-1)?.status.lifecycle).toBe('interrupted');
    expect(updates.at(-1)?.status.activity).toBeUndefined();

    disposeProjector('act-5');
  });

  it('does not carry a tool into a turn that starts without the last one ending', () => {
    // Purpose: `turn_end` is the ordinary clear, so it hides this one. A turn
    // that opens over an unclosed turn is the case where it is the ONLY thing
    // standing between the fleet and a verb from a turn nobody is running any
    // more — an adapter whose stream died mid-tool and was re-driven.
    const p = getOrCreateProjector('act-6');
    const activities: Array<SessionActivity | undefined> = [];
    listen((u) => activities.push(u.status.activity));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Edit', { file_path: '/repo/a.ts' }));
    expect(p.getStatus().activity).toEqual({ toolName: 'Edit', target: 'a.ts' });

    p.ingest({ type: 'turn_start' });
    expect(p.getStatus().activity).toBeUndefined();
    expect(activities.at(-1)).toBeUndefined();

    disposeProjector('act-6');
  });

  it('carries the pending tool when the turn blocks on a person', () => {
    // Purpose: a session parked on an approval is still ABOUT something, and the
    // lifecycle transition to `blocked` must not blank what that something is.
    const p = getOrCreateProjector('act-7');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Bash', { command: 'rm -rf build' }));
    p.ingest({
      type: 'approval_required',
      id: 'tc-Bash',
      startedAt: Date.now(),
      remainingMs: 60_000,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);

    expect(updates.at(-1)?.status.lifecycle).toBe('blocked');
    expect(updates.at(-1)?.status.activity).toEqual({
      toolName: 'Bash',
      target: 'rm -rf build',
    });

    disposeProjector('act-7');
  });

  it('refuses an activity injected through a status_change — the projector owns this field', () => {
    // Purpose: `status_change` carries a PARTIAL SessionStatus, which the
    // projector merges field-wise onto the held one. That partial is derived
    // from the same schema, so the moment `activity` joined SessionStatus it
    // became a key any runtime's status delta could set — and the fold would
    // have accepted it, fanned it out, and let a runtime name a tool the
    // session never started. Nothing legitimate produces it (the normalizer
    // maps no source field to it), so the honest shape is that the delta
    // cannot express it at all.
    const p = getOrCreateProjector('act-9');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Read', { file_path: '/repo/real.ts' }));
    const before = updates.length;

    p.ingest({
      type: 'status_change',
      status: { activity: { toolName: 'InjectedTool', target: 'not-a-real-thing' } },
    } as unknown as RawSessionEvent);

    expect(p.getStatus().activity).toEqual({ toolName: 'Read', target: 'real.ts' });
    expect(updates).toHaveLength(before);

    disposeProjector('act-9');
  });

  it('leaves no timer behind when a projector with an armed flush is disposed', () => {
    // Purpose: the trailing flush is a real timer on a long-lived object. A
    // disposed projector is off the registry and unreachable, so a surviving
    // timer would fire into nothing — announcing a session that no longer
    // exists to every connected client, and holding a reference to it until
    // it did.
    vi.useFakeTimers();
    const p = getOrCreateProjector('act-10');
    listen(() => {});

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Read', { file_path: '/repo/a.ts' }));
    // The second tool inside the window is what arms the trailing flush.
    p.ingest(toolCall('Read', { file_path: '/repo/b.ts' }));
    expect(vi.getTimerCount()).toBe(1);

    disposeProjector('act-10');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a tool_result: the reading is what the session started, not what it finished', () => {
    vi.useFakeTimers();
    const p = getOrCreateProjector('act-8');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    p.ingest(toolCall('Bash', { command: 'pnpm verify' }));
    const afterCall = updates.length;

    p.ingest({
      type: 'tool_result',
      toolCallId: 'tc-Bash',
      toolName: 'Bash',
      status: 'complete',
      result: 'ok',
    } as RawSessionEvent);
    vi.advanceTimersByTime(ACTIVITY_FANOUT_THROTTLE_MS * 2);

    expect(updates).toHaveLength(afterCall);
    expect(p.getStatus().activity).toEqual({ toolName: 'Bash', target: 'pnpm verify' });

    disposeProjector('act-8');
  });
});
