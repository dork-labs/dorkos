/**
 * Trigger-only orchestration for a RUNTIME-fulfilled command intent (currently
 * `compact`) — the sibling of {@link import('./trigger-turn').triggerTurn} for
 * `POST /api/sessions/:id/command-intents/:intent` (ADR-0264, ADR-0273).
 *
 * A runtime-fulfilled intent is recognized client-side and dispatched here. This
 * acquires the session write-lock, runs `runtime.executeCommandIntent` detached,
 * and feeds the resulting `StreamEvent`s into the per-session
 * {@link SessionStateProjector} — so the client learns of the compaction solely
 * over `GET /:id/events` (e.g. a `compact_boundary`), exactly like a turn. It
 * reuses the turn machinery — the lock lifecycle
 * ({@link import('./trigger-turn').DetachedTurnLifecycle}), the stall watchdog
 * ({@link withStallGuard}), the error-terminal translation
 * ({@link guardTurnErrors}), and {@link feedProjector} — but deliberately omits
 * three turn-only concerns:
 *
 * - **No user message.** A compact opens no user bubble, so `feedProjector` is
 *   called without a `userMessage` — the turn is a bare projector wrapper around
 *   the boundary the adapter yields.
 * - **No context assembly.** A compact carries no content, so there is no neutral
 *   `additionalContext` bag to build.
 * - **No canonical-id rekey.** Compact only ever runs on an EXISTING session,
 *   whose id is already stable, so there is no new-session remap to converge.
 *
 * @module services/session/trigger-command-intent
 */
import type { CommandIntentOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { SessionStateProjector } from './session-state-projector.js';
import { feedProjector } from './session-event-normalizer.js';
import { withStallGuard } from './stall-guard.js';
import {
  DetachedTurnLifecycle,
  guardTurnErrors,
  sessionTurnQueue,
  tapEachEvent,
} from './trigger-turn.js';
import { SESSIONS } from '../../config/constants.js';

/** The collaborators {@link triggerCommandIntent} needs, narrowed to a runtime-neutral port. */
export interface TriggerCommandIntentDeps {
  /**
   * Acquire the session write-lock; returns false when held by another client.
   * The `token` is the per-turn lock identity so {@link releaseLock} can be
   * token-matched (a stale releaser from a superseded turn does nothing).
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean;
  /** Release the session write-lock for this client (idempotent at the manager). */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void;
  /** The runtime's command-intent generator (gated on capability by the caller). */
  executeCommandIntent(
    sessionId: string,
    intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent>;
  /** Interrupt the runtime's in-flight work (stall watchdog). Resolves false when none found. */
  interruptQuery(sessionId: string): Promise<boolean>;
  /**
   * Resolve the backend-internal (canonical) id for this session, so the queue
   * slot and the lock are keyed the same way a turn keys them. A compact runs
   * only on an existing session, but "existing" does not mean "referred to by
   * one id" — the session still answers to the request UUID it was born under.
   */
  getInternalSessionId(sessionId: string): string | undefined;
}

/** Inputs for {@link triggerCommandIntent}. */
export interface TriggerCommandIntentOpts {
  sessionId: string;
  clientId: string;
  /** The runtime-fulfilled intent to dispatch (e.g. `'compact'`). */
  intent: RuntimeCommandIntentId;
  cwd?: string;
  /**
   * Trailing instructions after the intent token (e.g. `/compact focus on the
   * API changes`). Forwarded to the adapter; runtimes whose mechanism takes no
   * instruction ignore them.
   */
  instructions?: string;
  /** The projector for `sessionId` (keyed by the stable client-facing id). */
  projector: SessionStateProjector;
  deps: TriggerCommandIntentDeps;
  /** Inactivity window before the stall watchdog fires. Defaults to SESSIONS.TURN_STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
  /**
   * How long this intent may wait for the same client's earlier work on this
   * session. Defaults to SESSIONS.LOCK_TTL_MS, matching a turn's bound.
   */
  queueWaitMs?: number;
  /** Records a detached-turn failure (logging is the caller's concern). */
  onError?(err: unknown): void;
}

/** Outcome of a {@link triggerCommandIntent} attempt. */
export interface TriggerCommandIntentResult {
  /** True when the lock was acquired and the intent started; false → session busy. */
  accepted: boolean;
}

/**
 * Acquire the lock and start a detached command-intent run feeding the projector.
 *
 * There is no canonical id to wait for, so this returns as soon as the lock is
 * taken and the detached run has been kicked off (the run continues in the
 * background, releasing the lock when it finishes). It is `async` only because
 * it waits its turn first: a compact shares the session's single writer with
 * every turn, so it reserves a slot in the SAME per-(session, client) chain
 * {@link import('./trigger-turn').triggerTurn} uses (review G7). Two things
 * follow. A compact triggered while this client's own turn is running now WAITS
 * for that turn and then runs, where before it silently replaced the live turn's
 * lock. And it can no longer slip into the gap between a turn releasing the lock
 * and the queued turn behind it acquiring one.
 *
 * The client bounds its own request at 30s (`runCommandIntent` in the web
 * transport), which is shorter than the wait this may impose. A compact behind a
 * long turn therefore reports a failure to the person while still being queued
 * to run — a rough edge inherited from holding the wait in a request, retired
 * with the rest of that model by DOR-1089's durable queue.
 *
 * @param opts - Session/intent inputs, the projector, and the runtime-neutral port.
 * @returns `{ accepted: false }` when the session is locked by another client;
 *   otherwise `{ accepted: true }`.
 */
export async function triggerCommandIntent(
  opts: TriggerCommandIntentOpts
): Promise<TriggerCommandIntentResult> {
  const { sessionId, clientId, intent, cwd, instructions, projector, deps } = opts;

  // Same resolved key a turn uses: one live session answers to every id it has
  // ever held, so keying on the raw request id would queue against nothing.
  const turnKey = deps.getInternalSessionId(sessionId) ?? sessionId;
  const slot = sessionTurnQueue.reserve(
    turnKey,
    clientId,
    opts.queueWaitMs ?? SESSIONS.LOCK_TTL_MS
  );
  await slot.ready;

  // Acquire against a detached lifecycle so the lock is bound to the intent's
  // real duration, not to the soon-to-be-sent 202 response (same contract as a
  // turn). The per-turn token makes this run's release token-matched.
  // One probe, two consumers (DOR-782): the stall watchdog must not shoot a run
  // parked on a person, and the lock must not expire under one. See
  // {@link DetachedTurnLifecycle} and `SessionStateProjector.hasPendingInteractions`.
  const waitingOnPerson = (): boolean => projector.hasPendingInteractions();
  const lifecycle = new DetachedTurnLifecycle(waitingOnPerson);
  const lockToken = Symbol('detached-command-intent-lock');
  if (!deps.acquireLock(turnKey, clientId, lifecycle, lockToken)) {
    slot.release();
    return { accepted: false };
  }

  // Idempotent release: fired when the detached run settles (success or error),
  // plus the lifecycle close that drives the lock manager's own cleanup.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    deps.releaseLock(turnKey, clientId, lockToken);
    lifecycle.close();
    slot.release();
  };

  // Drive the adapter's intent generator through the SAME guards a turn uses:
  // the stall watchdog abandons a runtime that goes silent past the threshold and
  // interrupts it; the outer error-guard translates a throw INTO a terminal error
  // sequence so feedProjector always closes the turn exactly once and `/events`
  // consumers see any failure. No userMessage — a compact opens no user bubble.
  // Every yielded event is proof of life for the write-lock (DOR-782), so a
  // long-running intent is not declared abandoned and stolen mid-flight.
  let source;
  try {
    source = tapEachEvent(deps.executeCommandIntent(sessionId, intent, { cwd, instructions }), () =>
      lifecycle.touch()
    );
  } catch (err) {
    // Nothing was launched, so nothing downstream will release the lock or the
    // queue slot. Hand both back here (mirrors `triggerTurn`).
    releaseOnce();
    throw err;
  }
  const stallGuarded = withStallGuard(source, {
    sessionId,
    timeoutMs: opts.stallTimeoutMs ?? SESSIONS.TURN_STALL_TIMEOUT_MS,
    isPaused: waitingOnPerson,
    onStall: () => deps.interruptQuery(sessionId),
    onError: (err) => opts.onError?.(err),
  });
  const guarded = guardTurnErrors(projector, stallGuarded, (err) => opts.onError?.(err));
  // The run continues in the background; the request does not await it. The final
  // `.catch` is the last line of defense against a feedProjector-internal
  // rejection so the detached promise never becomes an unhandled rejection.
  void feedProjector(projector, guarded)
    .catch((err: unknown) => opts.onError?.(err))
    .finally(() => releaseOnce());

  return { accepted: true };
}
