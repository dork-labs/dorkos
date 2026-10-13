/**
 * Drop the in-memory state of log-backed sessions nobody is using (DOR-2897).
 *
 * A session's projector holds its event log in memory: up to 5,000 events and
 * `EVENT_LOG_MAX_BYTES` each. Claude Code disposes its projectors when it
 * evicts an idle session, but nothing ever disposed a Codex, OpenCode or Doe
 * one, so every such chat opened since the server started stayed in memory for
 * the life of the process.
 *
 * Those runtimes are LOG-BACKED: the durable session-event store holds their
 * whole conversation (`persist: 'history'`, DOR-189), so the projector is only a
 * cache of it and the next read rebuilds it from the store. This sweep drops a
 * log-backed projector once it has sat idle, with nobody reading its stream,
 * for two sweeps in a row. A reader that comes back after that gets a fresh
 * snapshot, because the new projector has a new stream generation.
 *
 * Claude Code projectors are never touched here: their history is the
 * transcript, not the store, and their runtime owns their lifetime. Neither is
 * a session showing an error or waiting on a person: those stay, whole event
 * log and all, until somebody deals with them or the server restarts.
 *
 * @module services/session/replay/projector-idle-sweep
 */
import type { SessionEventStore } from '../session-event-store.js';
import {
  disposeProjector,
  listLiveProjectors,
  setSessionEventStore,
  type SessionStateProjector,
} from '../session-state-projector.js';

/**
 * Gap between sweeps (ms). A projector is dropped after it looks idle and
 * unchanged on two sweeps in a row, so between one and two of these.
 */
export const PROJECTOR_IDLE_SWEEP_MS = 10 * 60_000;

/**
 * What each disposable projector looked like at the sweep that first saw it
 * that way: its stream position and how often it had been handed out.
 */
const idleAt = new WeakMap<SessionStateProjector, { cursor: number; acquisitions: number }>();

/**
 * Whether a projector holds nothing the store cannot give back, and nothing a
 * person still needs to see: it is log-backed, nobody is reading its stream,
 * and it is plainly idle, with no turn open, nothing waiting on a person (a
 * question, an approval, a capability hold or a sign-in card), no background
 * task and no error to show. An errored session keeps its badge in every
 * window until it is dealt with.
 *
 * @param projector - The projector to judge.
 */
function isDisposable(projector: SessionStateProjector): boolean {
  const counters = projector.debugCounters();
  if (counters.persistence !== 'history' || counters.subscribers > 0) return false;
  if (projector.peekInProgressTurn() !== null || projector.hasPendingInteractions()) return false;
  if (projector.hasOpenSigninCards()) return false;
  const status = projector.getStatus();
  // A stopped turn settles to `interrupted` and stays there until the next one;
  // no window is ever shown that on connect, so it holds nothing worth keeping.
  const settled = status.lifecycle === 'idle' || status.lifecycle === 'interrupted';
  return settled && status.lastError === null && status.runningSubagentCount === 0;
}

/**
 * Run one sweep: drop every log-backed projector that was disposable on the
 * previous sweep and has neither moved nor been handed out since. A caller
 * that fetched a projector and has not started its turn yet holds a reference
 * the registry would no longer know, and a turn fed into it would be lost, so
 * any fetch between the two looks keeps it.
 *
 * @returns How many projectors were dropped.
 */
export function sweepIdleProjectors(): number {
  let dropped = 0;
  for (const projector of listLiveProjectors()) {
    if (!isDisposable(projector)) {
      idleAt.delete(projector);
      continue;
    }
    const seen = { cursor: projector.getCursor(), acquisitions: projector.acquisitions };
    const before = idleAt.get(projector);
    if (before?.cursor === seen.cursor && before.acquisitions === seen.acquisitions) {
      disposeProjector(projector.sessionId);
      dropped += 1;
    } else {
      idleAt.set(projector, seen);
    }
  }
  return dropped;
}

/**
 * Wire the durable session-event store and start the idle sweep it makes safe.
 * Only the server's boot calls this. The timer runs for the life of the
 * process and never holds it open.
 *
 * @param store - The store log-backed sessions persist to.
 */
export function wireSessionEventStore(store: SessionEventStore): void {
  setSessionEventStore(store);
  setInterval(sweepIdleProjectors, PROJECTOR_IDLE_SWEEP_MS).unref();
}
