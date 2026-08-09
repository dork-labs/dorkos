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
 *    error (idempotent), so a turn that throws can never strand the lock. The
 *    lifecycle also vouches for the turn's liveness (DOR-782) so the lock's TTL
 *    measures INACTIVITY rather than elapsed time: a turn that runs an hour while
 *    streaming keeps its lock, one that goes dark still loses it a TTL later.
 *
 * 3. **Single delivery / detached error surfacing.** Because the client can no
 *    longer learn of a turn error from the POST, {@link guardTurnErrors} routes
 *    any `sendMessage` rejection into the projector (an `error` `status_change`,
 *    a typed `error` event carrying the failure details, plus a `turn_end`) so
 *    `/events` consumers see the failure. The `feedProjector` `finally` already
 *    closes the turn on a clean end.
 *
 * 4. **Stall watchdog.** A runtime that stops yielding entirely (a hung
 *    subprocess) would otherwise pin `feedProjector`'s for-await forever:
 *    lifecycle frozen at `streaming`, lock held to its TTL, generator leaked.
 *    `withStallGuard` (composed INSIDE {@link guardTurnErrors}) races each
 *    source event against an inactivity timer, pausing while the session is
 *    parked on a person; on a stall it interrupts the runtime and injects the
 *    same typed-error terminal sequence as a throw. The lock path needs no
 *    special handling: the guard always ends the stream cleanly, so
 *    `feedProjector` settles and the existing `finally(releaseOnce)` fires as on
 *    any turn. The pause reads the projector's PENDING-INTERACTION SET, not its
 *    `blocked` lifecycle (DOR-782): the lifecycle is a projection that a
 *    concurrent turn's `turn_start` overwrites with `streaming`, which used to
 *    un-pause the watchdog for a turn still holding an unanswered approval.
 *
 * @module services/session/trigger-turn
 */
import type { MessageOpts, SseResponse, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { SessionSettings, StreamEvent } from '@dorkos/shared/types';
import type { ClientContext, RoomContextData } from '@dorkos/shared/additional-context';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import type { SessionStateProjector } from './session-state-projector.js';
import type { LockActivity } from './session-lock.js';
import { feedProjector } from './session-event-normalizer.js';
import { assembleAdditionalContext } from './context-assembler.js';
import { withStallGuard } from './stall-guard.js';
import { SESSIONS } from '../../config/constants.js';
import { startSpan, SPAN, ATTR } from '../observability/index.js';
import { logError, logger } from '../../lib/logger.js';

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
 *
 * It is also the turn's liveness witness ({@link LockActivity}, DOR-782). The
 * lock TTL is there to reclaim a lock whose holder vanished, but measured from
 * acquisition it also expired locks held by turns that were plainly alive: a
 * room turn legally runs an hour, so it spent 55 minutes stealable while
 * streaming. This reports the turn as alive when either is true — it emitted an
 * event recently, or it is parked on a person — and reports nothing once the
 * turn goes genuinely dark, so a vanished holder is still reclaimed one TTL
 * later. That silence is separately bounded by the stall watchdog, which shares
 * the same "parked on a person" probe, so a renewed lock cannot outlive a turn
 * the watchdog would have killed.
 */
export class DetachedTurnLifecycle implements SseResponse, LockActivity {
  private readonly closeCallbacks: Array<() => void> = [];
  private closed = false;
  private activityAt = Date.now();

  /**
   * Build a lifecycle for one detached turn.
   *
   * @param waitingOnPerson - Probe answering "is this turn parked on an approval,
   *   question, or elicitation only a person can resolve?" Such a turn emits
   *   nothing for as long as the person takes, and must not be treated as dead.
   *   Defaults to "never", for callers that construct a lifecycle without one.
   */
  constructor(private readonly waitingOnPerson: () => boolean = () => false) {}

  /** Record proof of life; called for every event the turn yields. */
  touch(): void {
    this.activityAt = Date.now();
  }

  /** Epoch ms of the turn's most recent proof of life ({@link LockActivity}). */
  lastActivityAt(): number {
    return this.waitingOnPerson() ? Date.now() : this.activityAt;
  }

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
  /** Interrupt the runtime's in-flight turn (stall watchdog). Resolves false when none found. */
  interruptQuery(sessionId: string): Promise<boolean>;
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
  /**
   * Where this turn is happening, when a room triggered it. Passed straight to
   * the assembler; it is server-derived and never reaches this from a client.
   */
  roomContext?: RoomContextData;
  /**
   * Background the caller attached to this turn — the agent reads it, the person
   * never sees it. Passed straight to the assembler, which renders it into the
   * neutral bag as a `seed_context` entry; `content` is untouched.
   */
  seedContext?: string;
  /**
   * Execution settings for THIS turn, when the caller has resolved them itself.
   *
   * The normal path leaves this unset: settings live in `session_metadata` and
   * every adapter reads them there. Rooms are the exception — a room session's
   * row is written AFTER the turn is known to have started (so a runtime that
   * throws leaves no orphan row), which is too late to seed the turn that is
   * starting. The runner therefore resolves the same defaults and passes them
   * here for the session's FIRST turn; once the row exists it passes an empty
   * object instead, so from the second turn nothing is overridden and the row
   * governs.
   *
   * Deliberately narrower than `SessionSettings`: model and effort are the two
   * a caller may resolve for one turn. `permissionMode` and `fastMode` are
   * posture, not preference, and must not be smuggled in as a per-send override
   * that outranks what the person set on the session.
   */
  settings?: Pick<SessionSettings, 'model' | 'effort'>;
  /** The projector for `sessionId` (keyed by the client-facing id, which is stable). */
  projector: SessionStateProjector;
  deps: TriggerTurnDeps;
  /** Inactivity window before the stall watchdog fires. Defaults to SESSIONS.TURN_STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
  /** Records a detached-turn failure (logging is the caller's concern). */
  onError?(err: unknown): void;
  /**
   * Fired once when the DETACHED turn settles, however it settles.
   *
   * The 202 resolves long before this. A caller that wants to record how a turn
   * ended — the diagnostic dispatch buffer does — has nowhere else to learn it,
   * because the request is gone and `onError` only fires on a failure.
   *
   * A throw here is caught and logged rather than allowed to escape: this runs
   * on the turn's own settlement path, where an unhandled rejection would take
   * down work that has already succeeded. An observability hook must be
   * structurally unable to kill a turn.
   *
   * @param outcome - `'failed'` when the turn reported an error, else `'ok'`.
   */
  onSettled?(outcome: 'ok' | 'failed'): void;
  /**
   * Receives the `seq` of THIS turn's `turn_start` — its identity on the durable
   * stream.
   *
   * For the one caller that both triggers a turn and reads the same stream back:
   * a room. Without it the room had to guess which `turn_start` was its own by
   * comparing the trigger text, which any other turn carrying the same words
   * satisfies — and which a turn carrying NO text (a `/compact`-style command
   * intent, whose `turn_start` has no `userMessage` at all) satisfied by
   * default. A seq is the identity itself, so neither is a question any more.
   *
   * Fired synchronously, before the turn's first event can reach any subscriber
   * — see `feedProjector`.
   *
   * @param seq - The `turn_start`'s seq.
   */
  onTurnStart?(seq: number): void;
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
  const {
    sessionId,
    clientId,
    content,
    cwd,
    context,
    roomContext,
    seedContext,
    settings,
    projector,
    deps,
  } = opts;

  // Acquire against a detached lifecycle so the lock is bound to the turn, not
  // to the soon-to-be-closed POST response. The per-turn token (I1) makes this
  // turn's release token-matched: if a second same-client turn auto-flushes and
  // re-acquires before this one settles, this turn's stale releaseOnce becomes a
  // no-op and cannot drop the newer lock (which would admit a concurrent writer).
  // One probe, two consumers (DOR-782): the stall watchdog must not shoot a turn
  // parked on a person, and the lock must not expire under one. Read off the
  // projector's pending-interaction set rather than `lifecycle === 'blocked'` —
  // the set IS the pending state, while the lifecycle is a projection a later
  // status_change can overwrite.
  const waitingOnPerson = (): boolean => projector.hasPendingInteractions();
  const lifecycle = new DetachedTurnLifecycle(waitingOnPerson);
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
  // Span the detached turn's real lifetime (started here, ended in the turn's
  // finally). No-op when debug tracing is off. `eventCount` is tallied in the
  // per-event tap below and recorded when the turn settles.
  const turnSpan = startSpan(SPAN.SESSION_TURN, { [ATTR.SESSION_ID]: sessionId });
  let eventCount = 0;
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
    ...(roomContext ? { roomContext } : {}),
    ...(seedContext ? { seedContext } : {}),
    nativeContext: deps.getCapabilities().nativeContext,
  });
  const tapped = tapEachEvent(
    deps.sendMessage(sessionId, content, { cwd, additionalContext, ...settings }),
    () => {
      signalFirstEvent();
      tryRekey();
      // Proof of life for the write-lock: a turn that is visibly producing
      // events must never be declared abandoned and stolen mid-flight (DOR-782).
      lifecycle.touch();
      eventCount++;
    }
  );

  // Run the turn detached, double-wrapped. Inner: the stall watchdog abandons a
  // source that goes silent past the threshold, interrupts the runtime, and
  // injects the typed-error terminal sequence. It receives the ORIGINAL trigger
  // sessionId for interruptQuery: every runtime resolves its own alias in both
  // directions, so the pre-rekey id stays valid all turn. Outer: guardTurnErrors
  // translates a `sendMessage`/SDK throw INTO the stream, as an error
  // `status_change` (ingested directly, since lifecycle has no StreamEvent
  // carrier) plus a terminal `done` bearing `terminalReason: 'error'`, so
  // feedProjector closes the turn exactly once with
  // `turn_end{terminalReason:'error'}` and the durable stream shows the failure
  // (the client can no longer learn of it from the POST). The lock is released
  // when the (now always-clean) turn settles.
  const stallGuarded = withStallGuard(tapped, {
    sessionId,
    timeoutMs: opts.stallTimeoutMs ?? SESSIONS.TURN_STALL_TIMEOUT_MS,
    isPaused: waitingOnPerson,
    onStall: () => deps.interruptQuery(sessionId),
    onError: (err) => opts.onError?.(err),
  });
  let failed = false;
  const guarded = guardTurnErrors(projector, stallGuarded, (err) => {
    failed = true;
    opts.onError?.(err);
  });
  // The trigger content rides the turn_start (userMessage) so the EventLog is a
  // self-sufficient history source for log-backed runtimes (ADR-0263).
  const turn = feedProjector(projector, guarded, {
    userMessage: content,
    ...(opts.onTurnStart ? { onTurnStart: opts.onTurnStart } : {}),
  })
    // guardTurnErrors already swallows source throws; this catch is the last line
    // of defense against a feedProjector-internal rejection so the detached
    // promise never becomes an unhandled rejection. The lock still releases below.
    .catch((err) => {
      failed = true;
      turnSpan.markError();
      return opts.onError?.(err);
    })
    .finally(() => {
      turnSpan.setAttr(ATTR.EVENT_COUNT, eventCount);
      turnSpan.end();
      releaseOnce();
      // Contained: this is the turn's own settlement path, where a throw becomes
      // an unhandled rejection. An observability hook must be structurally
      // unable to kill a turn, so the guarantee is enforced here rather than
      // asked for in the hook's doc.
      try {
        opts.onSettled?.(failed ? 'failed' : 'ok');
      } catch (err) {
        logger.warn('[trigger-turn] a turn-settled observer threw', {
          sessionId,
          ...logError(err),
        });
      }
    });
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
 *
 * @param source - The stream to forward.
 * @param onEvent - Fired just before each event; also once if the stream ends
 *   or throws without yielding.
 * @internal Exported so {@link import('./trigger-command-intent').triggerCommandIntent}
 * proves its own liveness to the lock off the same seam.
 */
export async function* tapEachEvent(
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
 *   2. yields a typed `error` StreamEvent (code `turn_exception`), so thrown and
 *      adapter-yielded errors converge on the durable stream: live clients
 *      render the failure inline and the projector latches
 *      `SessionStatus.lastError`, then
 *   3. yields a final `done` bearing `terminalReason: 'error'`, which
 *      `feedProjector` maps to the single closing `turn_end{terminalReason:'error'}`,
 * leaving the durable stream with `…status_change(error), error, turn_end(error)` —
 * never a frozen `streaming`. The original error is reported via `onError`.
 *
 * Exported so the command-intent trigger ({@link
 * import('./trigger-command-intent').triggerCommandIntent}) drives its adapter
 * generator through the SAME error-terminal translation a turn uses.
 *
 * @param projector - The session projector (for the direct error-status ingest).
 * @param source - The runtime's per-turn `StreamEvent` stream.
 * @param onError - Records the original failure (logging is the caller's concern).
 * @internal Exported for testing only.
 */
export async function* guardTurnErrors(
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
    // The typed error rides the stream (unlike the status ingest above) so the
    // normalizer projects it onto the turn: rendered inline live, latched into
    // SessionStatus.lastError, and reconstructed into log-backed history.
    const errorMessage = err instanceof Error ? err.message : String(err);
    yield {
      type: 'error',
      data: {
        message: errorMessage,
        code: 'turn_exception',
        // A thrown auth error (revoked/expired sign-in) still classifies so the
        // client offers a re-auth affordance rather than a generic failure.
        category: detectAuthError({ message: errorMessage }) ? 'auth_error' : 'execution_error',
        ...(err instanceof Error && err.stack ? { details: err.stack } : {}),
      },
    };
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
