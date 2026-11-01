/**
 * The stream-end sweep of a session's background children (DOR-1100,
 * DOR-1108, FB-18), split out of `session-event-normalizer.ts`.
 *
 * When a turn's stream ends, a child still running is either lost (the
 * process it lived in exited, so its `task_notification` can never arrive) or
 * still in sight (a warm process outlives its turn). The runtime says which:
 * every child it names in `stillLive` is spared, and every other one gets a
 * terminal `untracked` update, so the count drains through the same events a
 * live client and a replay both fold.
 *
 * @module services/session/turn-stream/stranded-children
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SessionStateProjector } from '../session-state-projector.js';

/**
 * Retire every running child the runtime no longer sees.
 *
 * @param projector - The session's projector.
 * @param stillLive - What the runtime still sees running; absent means the
 *   process ended with the stream. A runtime that throws spares nothing.
 */
export function sweepStrandedChildren(
  projector: SessionStateProjector,
  stillLive: (() => readonly string[]) | undefined
): void {
  const spared = new Set(liveChildren(stillLive));
  for (const taskId of projector.listRunningSubagents()) {
    if (spared.has(taskId)) continue;
    const untracked: Omit<Extract<SessionEvent, { type: 'subagent_update' }>, 'seq'> = {
      type: 'subagent_update',
      taskId,
      status: 'untracked',
    };
    projector.ingest(untracked);
  }
}

/** What a runtime says is still running, read once. A failure spares none. */
export function liveChildren(stillLive: (() => readonly string[]) | undefined): readonly string[] {
  if (!stillLive) return [];
  try {
    return stillLive();
  } catch {
    return [];
  }
}
