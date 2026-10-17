/**
 * The message dispatcher's in-memory state: open turns, waiting messages,
 * launches under way, waiting agent compactions and the per-session dispatch
 * mutex, plus the lifecycle listeners and the queued-chat ceiling resolver.
 *
 * Every other dispatcher module reads and writes the same maps through here, so
 * there is exactly one copy of each.
 *
 * @module services/session/message-dispatcher/state
 */
import type {
  AgentRuntime,
  TurnPermissionBound,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import type { TriggerTurnDeps, TriggerTurnResult } from '../trigger-turn.js';
import { isChatClientId } from '../chat-messages/chat-client-id.js';
import { isRelayClientId } from '../../core/session-relay/relay-client-id.js';
import { isBoundedDocCommentClientId } from '../../docs/comments/doc-comment-client-id.js';
import { logger } from '../../../lib/logger.js';
import type {
  DispatchLifecycleEvent,
  InFlightTurn,
  PendingAgentCompaction,
  PendingDispatch,
} from './types.js';

/**
 * How many times each session's queue has been released — a turn boundary or
 * the runtime's gate release (DOR-2065). A held attempt compares it before and
 * after: a release that landed while the attempt was out (Switch now, the work
 * ending) found nothing parked to release, so the attempt retries at once.
 */
export const releases = new Map<string, number>();
/** Turns open right now, keyed by resolved session id. */
export const inFlight = new Map<string, InFlightTurn>();
/**
 * The {@link inFlight} token of each session's open AGENT-started turn.
 *
 * Kept apart from the slot so {@link noteRuntimeTurnClosed} can tell its own
 * claim from a dispatched turn's — the two race by construction, since a
 * runtime turn opens exactly when the process talks with nothing dispatched.
 */
export const runtimeTurns = new Map<string, symbol>();
/** Accepted messages waiting to launch, keyed by message id. */
export const pending = new Map<string, PendingDispatch>();
/** Signal-owned preparations must drain before their host disposes its database. */
export const privateLaunches = new Map<AbortSignal, Set<Promise<TriggerTurnResult>>>();
/**
 * Messages whose launch is under way: out of {@link pending}, still on the
 * queue.
 *
 * The gap between the two is not instantaneous. A launch leaves `pending`
 * synchronously and the row leaves the store at `turn_start`, and between those
 * two moments the turn is awaiting its neutral context bag — real filesystem
 * work. A row seen in that window is on disk with no pending entry behind it,
 * which is precisely what {@link adoptQueuedMessages} takes to mean "a previous
 * process left this", so it would adopt a message that is at this instant being
 * sent — running somebody's words twice and reporting a queue recovery on a
 * server that never restarted.
 */
export const launching = new Set<string>();

/**
 * The ceiling a queued message another chat sent launches under (spec
 * `spin-off-chats` §3), read from that chat's own record of the send at the
 * moment the turn LAUNCHES, not when it was accepted: a batched row gains
 * senders while it waits, and a row adopted after a restart has no in-memory
 * plan to carry one. Wired at boot by the chat-message service.
 */
export type QueuedChatCeilingResolver = (messageId: string) => TurnPermissionCeiling;

let queuedChatCeiling: QueuedChatCeilingResolver | undefined;

/**
 * Wire (or clear) how a chat-sent queue row's ceiling is read.
 *
 * @param resolver - Reads a row's ceiling; `undefined` clears it.
 */
export function setQueuedChatCeilingResolver(
  resolver: QueuedChatCeilingResolver | undefined
): void {
  queuedChatCeiling = resolver;
}

/**
 * The ceiling a launching message runs under: the caller's own, plus a bound
 * read from who queued the row.
 *
 * - A row another chat sent adds its senders' bound; with no resolver wired it
 *   is held to the receiving runtime's default: it fails closed.
 * - A row the session relay sent adds the runtime's default, always. The relay
 *   passes that ceiling itself, but a row adopted after a restart has no
 *   in-memory plan to carry it, and words from the web must still ask before
 *   anything that needs a person (spec `everything-is-a-space` B2, option 2).
 * - A row a doc comment by anybody but the owner sent keeps the ceiling it was
 *   sent with, and is held to the runtime's default when a restart lost it
 *   (DOR-2983).
 */
export function launchCeiling(
  clientId: string,
  messageId: string,
  own: TurnPermissionCeiling | undefined
): TurnPermissionCeiling | undefined {
  if (isBoundedDocCommentClientId(clientId)) return own ?? 'runtime-default';
  let bound: TurnPermissionCeiling;
  if (isChatClientId(clientId)) bound = queuedChatCeiling?.(messageId) ?? 'runtime-default';
  else if (isRelayClientId(clientId)) bound = 'runtime-default';
  else return own;
  if (own === undefined) return bound;
  const list = (c: TurnPermissionCeiling): readonly TurnPermissionBound[] =>
    Array.isArray(c) ? (c as readonly TurnPermissionBound[]) : [c as TurnPermissionBound];
  return [...list(own), ...list(bound)];
}

/**
 * Whether a queued message is being launched right now: its words are being
 * read into a turn, so anything appended to its row would be lost. A caller
 * that batches into a waiting row asks this first, in the same tick.
 *
 * @param messageId - The queue row's id.
 */
export function isQueuedMessageLaunching(messageId: string): boolean {
  return launching.has(messageId);
}

/** Agent-requested summaries waiting to run, one per session at most, keyed by primary id. */
export const pendingCompactions = new Map<string, PendingAgentCompaction>();
/** Tail of each session's dispatch mutex chain; dropped when it drains. */
export const dispatchMutex = new Map<string, Promise<void>>();
/** Sessions the fleet has reported gone, awaiting the next sweep. */
export const orphanedSessions = new Set<string>();

/** Everyone listening through {@link onDispatchLifecycle}. */
export const lifecycleListeners = new Set<(event: DispatchLifecycleEvent) => void>();
/**
 * Messages whose rows the orphan sweep deleted while their launch was under
 * way. If that launch then starts no turn, the drop is the session's going,
 * not a person's Remove, and is reported as such.
 */
export const sweptWhileLaunching = new Set<string>();

/**
 * Hear every accepted message start, settle or drop, whoever sent it and
 * however it got here — including rows {@link adoptQueuedMessages} recovered
 * after a restart, whose original caller's callbacks died with the old process.
 * That is what this exists for: a sender that has to learn, by message id, what
 * became of a message it was told was accepted (`ctx.agent.send`, DOR-2683).
 *
 * Listeners run synchronously inside the dispatcher's own bookkeeping, so they
 * must be quick and must not throw; a throw is logged and swallowed.
 *
 * @param listener - Receives each {@link DispatchLifecycleEvent}
 * @returns A function that stops listening
 */
export function onDispatchLifecycle(listener: (event: DispatchLifecycleEvent) => void): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

/**
 * Tell every lifecycle listener about one event, logging and swallowing a throw.
 *
 * @param event - What happened to the message
 */
export function emitLifecycle(event: DispatchLifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn('[MessageDispatcher] a lifecycle listener threw', {
        messageId: event.messageId,
        phase: event.phase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Run `fn` with this session's dispatch mutex held.
 *
 * Every decision that starts or ends a turn goes through here, so two of them
 * cannot interleave on one session. The mutex is released as soon as the
 * decision is made — it is never held for the turn's duration, which is the
 * write-lock's job.
 *
 * **What it does NOT serialize: the warm-process reaper.** An earlier note here
 * said the reaper shared this mutex, and the code was written trusting it — a
 * reap landing between the router reading `canStageSession` and
 * {@link deliverStage} taking this lock was therefore reported as an adapter bug
 * (DOR-1325). The reaper is a timer inside the claude-code session registry and
 * takes nothing from this module; every holder of this mutex is in this file.
 * Anything that must survive a reap has to re-ask after the fact rather than
 * assume the lock froze the world.
 *
 * @param sessionKey - The resolved session id to serialize on
 * @param fn - The critical section
 */
export async function withDispatchMutex<T>(
  sessionKey: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = dispatchMutex.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => held);
  dispatchMutex.set(sessionKey, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Only the CURRENT tail may drop the entry; a later waiter has already
    // chained onto ours and must keep its place.
    if (dispatchMutex.get(sessionKey) === chained) dispatchMutex.delete(sessionKey);
  }
}

/**
 * Builds the runtime-neutral port `triggerTurn` needs from a resolved runtime.
 *
 * The builder itself (`turnDeps`) stays in `message-dispatcher.ts`, because that
 * file is the one place a runtime's turn-starting methods may be called from
 * (`dispatcher-single-ingress.test.ts`). It registers itself here when that
 * module loads, which is before any message can be launched.
 */
let turnDepsBuilder: ((runtime: AgentRuntime) => TriggerTurnDeps) | undefined;

/**
 * Register the builder {@link buildTurnDeps} calls.
 *
 * @param builder - `turnDeps` from `message-dispatcher.ts`
 */
export function setTurnDepsBuilder(builder: (runtime: AgentRuntime) => TriggerTurnDeps): void {
  turnDepsBuilder = builder;
}

/**
 * Build the runtime-neutral port `triggerTurn` needs, through the registered builder.
 *
 * @param runtime - The runtime the launching message's session resolves to
 */
export function buildTurnDeps(runtime: AgentRuntime): TriggerTurnDeps {
  if (!turnDepsBuilder) throw new Error('The message dispatcher has not been loaded.');
  return turnDepsBuilder(runtime);
}
