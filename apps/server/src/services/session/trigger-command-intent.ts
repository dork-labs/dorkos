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
import { DetachedTurnLifecycle, guardTurnErrors } from './trigger-turn.js';
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
 * Unlike {@link import('./trigger-turn').triggerTurn} this resolves synchronously:
 * there is no canonical id to wait for, so it returns the instant the lock is
 * taken and the detached run has been kicked off (the run continues in the
 * background, releasing the lock when it finishes).
 *
 * @param opts - Session/intent inputs, the projector, and the runtime-neutral port.
 * @returns `{ accepted: false }` when the session is locked by another client;
 *   otherwise `{ accepted: true }`.
 */
export function triggerCommandIntent(opts: TriggerCommandIntentOpts): TriggerCommandIntentResult {
  const { sessionId, clientId, intent, cwd, instructions, projector, deps } = opts;

  // Acquire against a detached lifecycle so the lock is bound to the intent's
  // real duration, not to the soon-to-be-sent 202 response (same contract as a
  // turn). The per-turn token makes this run's release token-matched.
  const lifecycle = new DetachedTurnLifecycle();
  const lockToken = Symbol('detached-command-intent-lock');
  if (!deps.acquireLock(sessionId, clientId, lifecycle, lockToken)) {
    return { accepted: false };
  }

  // Idempotent release: fired when the detached run settles (success or error),
  // plus the lifecycle close that drives the lock manager's own cleanup.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    deps.releaseLock(sessionId, clientId, lockToken);
    lifecycle.close();
  };

  // Drive the adapter's intent generator through the SAME guards a turn uses:
  // the stall watchdog abandons a runtime that goes silent past the threshold and
  // interrupts it; the outer error-guard translates a throw INTO a terminal error
  // sequence so feedProjector always closes the turn exactly once and `/events`
  // consumers see any failure. No userMessage — a compact opens no user bubble.
  const source = deps.executeCommandIntent(sessionId, intent, { cwd, instructions });
  const stallGuarded = withStallGuard(source, {
    sessionId,
    timeoutMs: opts.stallTimeoutMs ?? SESSIONS.TURN_STALL_TIMEOUT_MS,
    isPaused: () => projector.getStatus().lifecycle === 'blocked',
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
