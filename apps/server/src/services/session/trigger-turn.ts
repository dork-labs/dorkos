/**
 * Trigger-only turn orchestration for the message POST (ADR-0264, Design B.2).
 *
 * `POST /api/sessions/:id/messages` no longer streams tokens in-band. Instead it
 * TRIGGERS a turn that runs detached from the HTTP response: the runtime's
 * `sendMessage` generator is consumed server-side and fed into the per-session
 * {@link SessionStateProjector}, so every token flows out the SINGLE delivery
 * path — `GET /:id/events` — and never on the POST response. This module owns
 * the three subtleties that make that safe:
 *
 * 1. **Canonical id discovery.** A brand-new session is assigned its real SDK id
 *    early in the stream (the adapter's reverse-index remap). The POST must
 *    return that canonical id so the client can re-key its URL and its `/events`
 *    subscription. {@link triggerTurn} starts the detached turn, then resolves
 *    the 202 as soon as the canonical id is observable (polled off
 *    `getInternalSessionId` as the stream advances) — with a timeout fallback to
 *    the provided id for existing sessions whose id never changes.
 *
 * 2. **Lock lifetime.** The session write-lock must be held for the turn's REAL
 *    duration, not the lifetime of the (now short-lived) POST response. The lock
 *    is therefore acquired against a {@link DetachedTurnLifecycle} — a tiny
 *    `SseResponse` whose `close` this module emits when the turn finishes — so
 *    the lock manager's close-driven cleanup fires on turn completion, not when
 *    the 202 is sent. The lock is also released explicitly on completion AND on
 *    error (idempotent), so a turn that throws can never strand the lock.
 *
 * 3. **Single delivery / detached error surfacing.** Because the client can no
 *    longer learn of a turn error from the POST, {@link guardTurnErrors} routes
 *    any `sendMessage` rejection into the projector (an `error` `status_change`
 *    plus a `turn_end`) so `/events` consumers see the failure. The
 *    `feedProjector` `finally` already closes the turn on a clean end.
 *
 * @module services/session/trigger-turn
 */
import type { MessageOpts, SseResponse, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ClientContext } from '@dorkos/shared/additional-context';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SessionStateProjector } from './session-state-projector.js';
import { feedProjector } from './session-event-normalizer.js';
import { assembleAdditionalContext } from './context-assembler.js';

/**
 * The `seq`-less shape of a single {@link SessionEvent} member, selected by its
 * `type` discriminator. Distributing `Extract` before `Omit` preserves each
 * member's full field set so object literals type-check precisely (a bare
 * `Omit<SessionEvent, 'seq'>` collapses the union to its common keys).
 */
type RawOf<T extends SessionEvent['type']> = Omit<Extract<SessionEvent, { type: T }>, 'seq'>;

/**
 * A self-controlled {@link SseResponse} that decouples the session write-lock
 * from the HTTP response lifecycle. The lock manager attaches its cleanup to
 * `on('close')`; we emit that close ourselves exactly once, when the detached
 * turn completes — so the lock is held for the turn, not for the 202.
 */
export class DetachedTurnLifecycle implements SseResponse {
  private readonly closeCallbacks: Array<() => void> = [];
  private closed = false;

  /** Register a close handler (the lock manager registers its cleanup here). */
  on(_event: 'close', cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  /** Fire all close handlers once; further calls are no-ops. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCallbacks) cb();
  }
}

/** How long to wait for the first event before falling back to the provided id. */
export const CANONICAL_ID_TIMEOUT_MS = 5_000;

/** The collaborators {@link triggerTurn} needs, narrowed to a runtime-neutral port. */
export interface TriggerTurnDeps {
  /**
   * Acquire the session write-lock; returns false when held by another client.
   * The `token` is the per-turn lock identity (I1) so {@link releaseLock} can be
   * token-matched and a superseded same-client turn cannot drop a newer lock.
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean;
  /**
   * Release the session write-lock for this client (idempotent at the manager).
   * When `token` is supplied, release is a no-op unless it matches the current
   * lock's token — a stale releaser from a superseded turn does nothing (I1).
   */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void;
  /** The runtime's per-turn event generator. */
  sendMessage(sessionId: string, content: string, opts: MessageOpts): AsyncGenerator<StreamEvent>;
  /** Resolve the backend-internal (canonical) id once the adapter assigns it. */
  getInternalSessionId(sessionId: string): string | undefined;
  /**
   * Re-key the projector registry entry from `oldId` to `newId`, preserving the
   * SAME projector instance (C1). Called once the canonical id is resolved for a
   * brand-new session so a later `/events` subscription keyed by the canonical id
   * resolves to the in-flight turn's projector, not a fresh empty one. A no-op
   * when the id is unchanged. Runtime-neutral: the registry is id-keyed, not
   * runtime-specific.
   */
  rekeyProjector(oldId: string, newId: string): void;
  /**
   * Capabilities of the active runtime — the assembler reads `nativeContext`
   * to omit any context kind the runtime injects itself.
   */
  getCapabilities(): RuntimeCapabilities;
}

/** Inputs for {@link triggerTurn}. */
export interface TriggerTurnOpts {
  sessionId: string;
  clientId: string;
  content: string;
  cwd?: string;
  /** Neutral client-sourced context signals (ui_state, queued) for this turn. */
  context?: ClientContext;
  /** The projector for `sessionId` (keyed by the client-facing id, which is stable). */
  projector: SessionStateProjector;
  deps: TriggerTurnDeps;
  /** Records a detached-turn failure (logging is the caller's concern). */
  onError?(err: unknown): void;
}

/** Outcome of a {@link triggerTurn} attempt. */
export interface TriggerTurnResult {
  /** True when the lock was acquired and the turn started. */
  accepted: boolean;
  /** The canonical session id to return in the 202 body (when accepted). */
  canonicalId?: string;
}

/**
 * Acquire the lock, start a detached turn feeding the projector, and resolve the
 * canonical session id for the 202 response. The returned promise settles as
 * soon as the lock is taken and the canonical id is known (or the timeout
 * elapses) — the turn itself continues in the background, releasing the lock
 * when it finishes.
 *
 * @param opts - Session/turn inputs, the projector, the feed seam, and the
 *   runtime-neutral lock/send/resolve port.
 * @returns `{ accepted: false }` when the session is locked by another client;
 *   otherwise `{ accepted: true, canonicalId }`.
 */
export async function triggerTurn(opts: TriggerTurnOpts): Promise<TriggerTurnResult> {
  const { sessionId, clientId, content, cwd, context, projector, deps } = opts;

  // Acquire against a detached lifecycle so the lock is bound to the turn, not
  // to the soon-to-be-closed POST response. The per-turn token (I1) makes this
  // turn's release token-matched: if a second same-client turn auto-flushes and
  // re-acquires before this one settles, this turn's stale releaseOnce becomes a
  // no-op and cannot drop the newer lock (which would admit a concurrent writer).
  const lifecycle = new DetachedTurnLifecycle();
  const lockToken = Symbol('detached-turn-lock');
  if (!deps.acquireLock(sessionId, clientId, lifecycle, lockToken)) {
    return { accepted: false };
  }

  // Idempotent release: explicit on completion/error, plus the lifecycle close
  // that drives the lock manager's own cleanup. Both funnel through here. The
  // token ensures only THIS turn's acquisition is released.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    deps.releaseLock(sessionId, clientId, lockToken);
    lifecycle.close();
  };

  // Tap the stream so the 202 can resolve the canonical id the instant the
  // adapter has processed enough to assign it. The `firstEvent` promise resolves
  // on the first yield (or settles if the stream is empty/throws), bounding the
  // wait without polling.
  //
  // C1 rekey is RETRIED on every yielded event until a canonical id DIFFERENT
  // from the request id appears: the adapter's reverse-index remap (driven by
  // the SDK init message) is NOT guaranteed to have run by the first yield —
  // observed live (acceptance run 20260610-173202, F2), a one-shot read at
  // first-event time raced the init and the projector stayed keyed by the
  // request UUID for the whole first turn, leaving the canonical-id (sidebar)
  // view a fresh empty projector. Identity must NOT disarm the retry (acceptance
  // run 20260611-145454): the Claude adapter SEEDS `sdkSessionId === sessionId`
  // at ensureSession time, so the first yield always sees a truthy identity
  // mapping before the init assigns the real id. A genuinely-identity session
  // (resume path) just keeps the retry armed all turn — one map lookup per
  // event, harmless.
  let signalFirstEvent: () => void;
  const firstEvent = new Promise<void>((resolve) => {
    signalFirstEvent = resolve;
  });
  let idResolved = false;
  const tryRekey = (): void => {
    if (idResolved) return;
    const canonical = deps.getInternalSessionId(sessionId);
    if (!canonical || canonical === sessionId) return;
    idResolved = true;
    deps.rekeyProjector(sessionId, canonical);
  };
  // Assemble the neutral context bag once, server-side: git_status is derived
  // here (identical for every runtime), client signals are normalized, and any
  // kind the runtime injects natively is omitted. `content` is passed through
  // pristine — context rides `additionalContext`, out-of-band (ADR-0273).
  const additionalContext = await assembleAdditionalContext({
    cwd: cwd ?? '',
    clientContext: context,
    nativeContext: deps.getCapabilities().nativeContext,
  });
  const tapped = tapEachEvent(
    deps.sendMessage(sessionId, content, { cwd, additionalContext }),
    () => {
      signalFirstEvent();
      tryRekey();
    }
  );

  // Run the turn detached. The source is wrapped so a `sendMessage`/SDK throw is
  // translated INTO the stream — an error `status_change` (ingested directly,
  // since lifecycle has no StreamEvent carrier) plus a terminal `done` bearing
  // `terminalReason: 'error'` — so feedProjector closes the turn exactly once
  // with `turn_end{terminalReason:'error'}` and the durable stream shows the
  // failure (the client can no longer learn of it from the POST). The lock is
  // released when the (now always-clean) turn settles.
  const guarded = guardTurnErrors(projector, tapped, (err) => opts.onError?.(err));
  // The trigger content rides the turn_start (userMessage) so the EventLog is a
  // self-sufficient history source for log-backed runtimes (ADR-0263).
  const turn = feedProjector(projector, guarded, { userMessage: content })
    // guardTurnErrors already swallows source throws; this catch is the last line
    // of defense against a feedProjector-internal rejection so the detached
    // promise never becomes an unhandled rejection. The lock still releases below.
    .catch((err) => opts.onError?.(err))
    .finally(releaseOnce);
  // The turn runs to completion in the background; the request does not await it.
  void turn;

  // Wait for the first event or a timeout — never for the whole turn. The 202's
  // canonical id is best-effort: if the adapter has not resolved it by the first
  // yield (the F2 race), the request id is returned and the client keeps using
  // it — which stays fully functional because the per-event `tryRekey` above
  // converges the registry as soon as the id is known, and the runtime resolves
  // snapshots/subscriptions through the id alias in both directions.
  await Promise.race([firstEvent, delay(CANONICAL_ID_TIMEOUT_MS)]);
  tryRekey();
  const canonicalId = deps.getInternalSessionId(sessionId) ?? sessionId;

  return { accepted: true, canonicalId };
}

/**
 * Yield through a source generator, invoking `onEvent` just before EACH event is
 * forwarded, and guaranteeing at least one invocation if the source ends or
 * throws without yielding (so the canonical-id wait never hangs on an empty or
 * immediately-failing stream). Callers make their callbacks idempotent — the
 * canonical-id signal resolves once and the rekey retry disarms itself.
 */
async function* tapEachEvent(
  source: AsyncIterable<StreamEvent>,
  onEvent: () => void
): AsyncIterable<StreamEvent> {
  let fired = false;
  try {
    for await (const event of source) {
      fired = true;
      onEvent();
      yield event;
    }
  } finally {
    // Empty stream or a throw before the first yield still releases the waiter.
    if (!fired) onEvent();
  }
}

/**
 * Forward a turn's `StreamEvent`s, translating a source throw into a clean
 * terminal sequence so `feedProjector` never sees a rejection (it would emit a
 * reason-less `turn_end` from its own `finally` AND leave the consumer racing a
 * second close). On a mid-stream throw this:
 *   1. ingests an `error` `status_change` DIRECTLY (lifecycle has no StreamEvent
 *      carrier, so the normalizer cannot express it), then
 *   2. yields a final `done` bearing `terminalReason: 'error'`, which
 *      `feedProjector` maps to the single closing `turn_end{terminalReason:'error'}`,
 * leaving the durable stream with `…status_change(error), turn_end(error)` —
 * never a frozen `streaming`. The original error is reported via `onError`.
 *
 * @param projector - The session projector (for the direct error-status ingest).
 * @param source - The runtime's per-turn `StreamEvent` stream.
 * @param onError - Records the original failure (logging is the caller's concern).
 */
async function* guardTurnErrors(
  projector: SessionStateProjector,
  source: AsyncIterable<StreamEvent>,
  onError: (err: unknown) => void
): AsyncIterable<StreamEvent> {
  try {
    yield* source;
  } catch (err) {
    onError(err);
    // lifecycle has no StreamEvent carrier, so ingest the error status directly.
    const errorStatus: RawOf<'status_change'> = {
      type: 'status_change',
      status: { lifecycle: 'error' },
    };
    projector.ingest(errorStatus);
    // session_status carries the terminalReason feedProjector attaches to the
    // closing turn_end; the trailing done triggers that single turn_end.
    yield {
      type: 'session_status',
      data: { sessionId: projector.sessionId, terminalReason: 'error' },
    };
    yield { type: 'done', data: { sessionId: projector.sessionId } };
  }
}

/** A sleep used only to bound the canonical-id wait. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
