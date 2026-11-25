/**
 * The dispatcher's hook into the run record (spec `turns-survive-restarts`
 * §4.7, DOR-5159): each dispatcher moment that changes what became of a turn
 * is written, through the facts sink, in the same synchronous step as the
 * in-memory decision it records.
 *
 * The record never decides for the dispatcher but in one place: a launch that
 * finds another run of its chat `started` or `running` does not go on
 * ({@link launchVerdictOf}). Everything else is a record of what the
 * dispatcher's own rules already did. A failure to write is logged and never
 * breaks the turn it describes, but the record is then behind: a run may be
 * left live with nothing in this process running it. That is why a run is
 * held (`holdRun` in `turn-port/facts.ts`) only while its launch or turn is
 * under way here: a live run of this boot nobody holds is retired at the next
 * read of its chat, so one failed write cannot hold the chat's next launch.
 *
 * With no run record wired, every call here is skipped and every launch goes
 * on, exactly as before the record existed.
 *
 * @module services/session/message-dispatcher/run-feed
 */
import type { RunFact } from '@dorkos/shared/turn-port';
import { logger } from '../../../lib/logger.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { peekProjector, type TurnBoundaryKind } from '../session-state-projector.js';
import {
  turnFacts,
  type DispatcherRunFeed,
  type LaunchVerdict,
  type ObservedTurnEnd,
} from '../turn-port/facts.js';
import type { DispatchPlan } from './types.js';

/**
 * Write one moment to the record, logging rather than throwing.
 *
 * @param what - The moment, for the log line.
 * @param write - The write.
 * @param fallback - What to answer when nothing is wired or the write fails.
 */
export function toRuns<T>(what: string, write: (feed: DispatcherRunFeed) => T, fallback: T): T {
  const feed = turnFacts()?.dispatcher;
  if (!feed) return fallback;
  try {
    return write(feed);
  } catch (err) {
    logger.error('[MessageDispatcher] the run record refused a write', {
      what,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

/**
 * Report one of the port's facts about a run.
 *
 * @param fact - What happened.
 */
export function reportRun(fact: RunFact): void {
  const sink = turnFacts();
  if (!sink) return;
  try {
    sink.report(fact);
  } catch (err) {
    logger.error('[MessageDispatcher] the run record refused a fact', {
      kind: fact.kind,
      runId: fact.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The run for a message the dispatcher just accepted (transition 1): called
 * inside the transaction that writes its queue row, when it has one.
 *
 * @param plan - What the message carries: its chat and its origin.
 * @param queueMessageId - Its queue row, when it has one.
 */
export function acceptRun(
  plan: Pick<DispatchPlan, 'sessionId' | 'turn'>,
  queueMessageId: string | undefined
): string | undefined {
  return toRuns(
    'accept',
    (feed) =>
      feed.accept({
        chatKey: queueKeyOf(plan.sessionId),
        origin: plan.turn.origin ?? null,
        ...(queueMessageId !== undefined ? { queueMessageId } : {}),
      }),
    undefined
  );
}

/**
 * The run of a queue row this process is adopting.
 *
 * @param sessionId - The chat, by any id it answers to.
 * @param queueMessageId - The row.
 */
export function adoptRun(sessionId: string, queueMessageId: string): string | undefined {
  return toRuns(
    'adopt',
    (feed) => feed.runOfQueueRow({ chatKey: queueKeyOf(sessionId), queueMessageId }),
    undefined
  );
}

/**
 * Whether a launch may go on, as the record answers it (transition 4): only
 * when no other run of the chat is `started` or `running`.
 *
 * @param plan - The launching message.
 */
export function launchVerdictOf(plan: DispatchPlan): LaunchVerdict {
  const { runId } = plan;
  if (runId === undefined) return { kind: 'starting' };
  return toRuns('launch', (feed) => feed.launchBegins(runId), { kind: 'starting' });
}

/**
 * A run of `plan` moves, if it has one.
 *
 * @param plan - The message.
 * @param what - The moment, for the log line.
 * @param write - The write, given the plan's run id.
 */
export function feedRun(
  plan: Pick<DispatchPlan, 'runId'>,
  what: string,
  write: (feed: DispatcherRunFeed, runId: string) => void
): void {
  const { runId } = plan;
  if (runId === undefined) return;
  toRuns(what, (feed) => write(feed, runId), undefined);
}

/**
 * Chats whose current dispatcher turn has seen the agent act, by queue key,
 * outside a pause's hold (§4.7). Set by the launch's `onActed`, cleared at
 * the next launch's `turn_start`; read at `turn_end`.
 */
const actedChats = new Set<string>();

/**
 * The agent acted in the chat's current turn, and no pause holds it.
 *
 * @param sessionId - The chat, by any id it answers to.
 */
export function noteTurnActed(sessionId: string): void {
  actedChats.add(queueKeyOf(sessionId));
}

/**
 * A new turn of the chat begins: whether its agent acted is not known yet.
 *
 * @param sessionId - The chat, by any id it answers to.
 */
export function forgetTurnActed(sessionId: string): void {
  actedChats.delete(queueKeyOf(sessionId));
}

/**
 * How a `turn_end` the projector just ingested ended the turn, read off the
 * status it settled to (§4.4): a stop the runtime's own `turn_end` reported,
 * a failure, or a turn that finished. A turn that hit a usage limit is told
 * apart by the store, which knows when the turn started.
 *
 * @param sessionId - The projector's id.
 */
function observedTurnEnd(sessionId: string): ObservedTurnEnd | undefined {
  const status = peekProjector(sessionId)?.getStatus();
  if (!status) return undefined;
  const ending =
    status.lifecycle === 'interrupted'
      ? 'stopped'
      : status.lifecycle === 'error'
        ? 'failed'
        : 'completed';
  const limit = status.limit;
  return {
    ending,
    ...(limit && limit.state === 'limited' ? { limitSince: limit.since } : {}),
    ...(actedChats.has(queueKeyOf(sessionId)) ? { acted: true } : {}),
  };
}

/**
 * The projector's boundary listener: at `turn_end`, record the ending on the
 * chat's `started` or `running` run at once, before its status moves at
 * settle (§4.7). A kill between the two must not read as `process_died`.
 *
 * @param sessionId - The session that reached a boundary.
 * @param kind - Which boundary.
 */
export function recordTurnEnd(sessionId: string, kind: TurnBoundaryKind): void {
  if (kind !== 'turn_end' || !turnFacts()) return;
  const observed = observedTurnEnd(sessionId);
  if (!observed) return;
  toRuns('turn_end', (feed) => feed.turnEnded(queueKeyOf(sessionId), observed), undefined);
}
