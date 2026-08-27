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
 * 5. **One turn at a time per client (DOR-1088).** This is the single chokepoint
 *    every turn-starting caller goes through, so it is where the one-writer rule
 *    is enforced: a trigger whose session already has a live turn from the SAME
 *    client WAITS in {@link SessionTurnQueue} instead of starting a second
 *    stream beside it. Two streams on one session are two subprocesses resuming
 *    one transcript, and that is what left a live session showing an idle
 *    composer. A second CLIENT still meets the lock and its unchanged
 *    409/takeover answer. Both the chain and the lock are keyed on the id the
 *    RUNTIME resolves to, not the id the request carried, because one live
 *    session answers to every id it has ever held.
 *
 * ## Known bounds of the waiting model (retired by DOR-1089)
 *
 * Making a queued trigger wait moves a cost onto the HTTP request, and two edges
 * of that are worth stating rather than discovering:
 *
 * - **The POST is held open for the wait.** A turn parked on a person's approval
 *   emits nothing for as long as the person takes, so the queued request behind
 *   it waits too. That wait is bounded — `queueWaitMs`, defaulting to the lock's
 *   TTL — after which the waiter proceeds to the lock and gets the same answer a
 *   stranger would (it starts if the lock is free, and is refused if it is not).
 *   So the bound is minutes, not the turn's full lifetime, but it is still long
 *   for an HTTP request.
 * - **The client does not bound it from its side.** `postMessage` in the web
 *   transport is a raw `fetch` with no abort signal, and nothing here watches for
 *   request abort — so a proxy or tunnel that kills a long-held POST shows the
 *   person a failure for a turn that is still queued to run.
 *
 * Both are properties of holding the wait in a request at all. DOR-1089's durable
 * queue retires them by accepting the message immediately and running it from
 * server-owned state, at which point nothing waits on a socket.
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
import { settleOpenTurnBefore } from './settle-open-turn.js';
import { assembleAdditionalContext } from './context-assembler.js';
import { takeStagedContext } from './staged-context-store.js';
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

/** One reservation in a session's turn chain. */
interface TurnSlot {
  /**
   * Resolves when every turn the SAME client reserved earlier on the SAME
   * session has settled, or when the wait bound elapses — whichever comes first.
   * Never rejects: a failed turn releases its slot like any other, so one bad
   * turn cannot wedge the chain behind it.
   */
  readonly ready: Promise<void>;
  /**
   * Mark this turn settled so the next waiter may run. Idempotent.
   *
   * The caller MUST reach this on every exit path — a refused lock and a throw
   * before the turn is launched included — or every later turn this client sends
   * to this session waits for the full bound before it can proceed.
   */
  release(): void;
}

/**
 * Separator between the two halves of a chain key.
 *
 * NUL, because a client id arrives in the `X-Client-Id` header and is therefore
 * whatever the caller chose to send. A printable separator lets a crafted id
 * collide with another session's chain — `"a b"` + `"c"` and `"a"` + `"b c"`
 * produce the same key with a space — which would silently serialize (or fail
 * to serialize) two unrelated sessions. Node rejects a header value containing
 * NUL before it reaches a route, so no id can carry one.
 */
const TURN_QUEUE_KEY_SEP = '\u0000';

/**
 * Serializes turn triggers per (session, client) — subtlety 5 above.
 *
 * A second trigger from the same client is not a mistake to refuse: the person
 * typed that message for this session and meant it. So it WAITS, in a promise
 * chain of the shape `RuntimeAdapter.enqueueForSession` uses in `@dorkos/relay`
 * (ADR-0075), and runs the instant the turn ahead of it settles.
 *
 * **Why the key carries the client id.** Refusing a second CLIENT is the lock's
 * job, and that behavior is deliberate: a second client's POST is a 409 naming
 * the holder while the turn is alive, and an accepted takeover once the holder
 * goes dark (otherwise a crashed turn would own the session until its TTL).
 * Making a second client wait here would turn a refusal into a hang and delete
 * the takeover path. Different clients therefore never queue behind each other;
 * they meet at the lock exactly as before.
 *
 * **Why a chain can be reached by more than one id.** A live session answers to
 * every id it has ever held: the request UUID the client first used, plus the
 * canonical id the runtime assigns mid-first-turn. The runtime resolves both to
 * one session, so keying a chain on the raw request id let the same tab's second
 * POST — sent under the canonical id it just read off the 202 — miss the chain
 * its own first turn was standing in and start a second stream into one
 * projector (DOR-1088 review, G4). {@link link} points the newly-learned id at
 * the chain that already exists, and callers resolve through {@link primaryOf}.
 *
 * @internal Exported for testing only — {@link triggerTurn} owns the one instance.
 */
export class SessionTurnQueue {
  /** Tail of each live chain, keyed by session+client; dropped when it drains. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Later-learned session id → the session id its chain is filed under. */
  private readonly aliases = new Map<string, string>();

  /** The session id `sessionId`'s chain is filed under (itself, unless aliased). */
  private primaryOf(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  /**
   * Record that `aliasId` names the same live session as `primaryId`, so a
   * trigger arriving under either id joins one chain.
   *
   * Idempotent, and safe to call with ids already linked; a self-link is
   * ignored. Aliases are dropped when the session's last chain drains.
   *
   * @param aliasId - The newly-learned id (the runtime's canonical id).
   * @param primaryId - The id the existing chain is filed under.
   */
  link(aliasId: string, primaryId: string): void {
    const primary = this.primaryOf(primaryId);
    if (aliasId === primary) return;
    this.aliases.set(aliasId, primary);
  }

  /**
   * Reserve the next slot in `(sessionId, clientId)`'s chain.
   *
   * Registration is synchronous, so two triggers arriving in the same tick are
   * ordered by arrival: the second sees the first's tail and queues behind it
   * instead of racing it.
   *
   * @param sessionId - The session whose turns are being serialized; resolved
   *   through any alias recorded by {@link link}.
   * @param clientId - The lock identity triggering the turn.
   * @param maxWaitMs - How long this reservation may wait for the turns ahead of
   *   it before proceeding anyway. The bound exists because the write-lock has a
   *   TTL and the chain does not: without it, a turn that went dark handed the
   *   session to any STRANGER one TTL later while its own client's queued turn
   *   waited on a slot that would never be released (DOR-1088 review, G1c). A
   *   waiter released by the bound still meets the lock, so it proceeds only if
   *   the lock is genuinely free — it gets the same answer a stranger would, at
   *   the same moment.
   * @returns The slot to await ({@link TurnSlot.ready}) and release.
   */
  reserve(sessionId: string, clientId: string, maxWaitMs: number): TurnSlot {
    const primary = this.primaryOf(sessionId);
    const key = `${primary}${TURN_QUEUE_KEY_SEP}${clientId}`;
    const previous = this.tails.get(key);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // Head of the chain: nothing to wait for, and no timer to arm.
    let ready: Promise<void>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (previous === undefined) {
      ready = Promise.resolve();
    } else {
      ready = Promise.race([
        previous,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    }
    // The next reservation waits for THIS one to settle, and for our own wait to
    // be over — so a slot released by the bound above does not make its
    // successor inherit an unbounded wait on a predecessor that never settles.
    const tail = ready.then(() => settled);
    this.tails.set(key, tail);

    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        settle();
        // Only the CURRENT tail may drop the entry; a later reservation has
        // already chained onto ours and must keep its place in the map.
        if (this.tails.get(key) === tail) {
          this.tails.delete(key);
          this.pruneAliases(primary);
        }
      },
    };
  }

  /** Drop `primary`'s aliases once no client has a live chain on it. */
  private pruneAliases(primary: string): void {
    const prefix = `${primary}${TURN_QUEUE_KEY_SEP}`;
    for (const key of this.tails.keys()) {
      if (key.startsWith(prefix)) return;
    }
    for (const [alias, target] of this.aliases) {
      if (target === primary) this.aliases.delete(alias);
    }
  }

  /** How many chains are live. Zero once every reserved slot has been released. */
  get size(): number {
    return this.tails.size;
  }

  /** How many alias links are held. Zero once every aliased session goes quiet. */
  get aliasCount(): number {
    return this.aliases.size;
  }
}

/**
 * The process-wide queue every turn trigger reserves from.
 *
 * @internal Exported so tests can assert every slot is handed back.
 */
export const sessionTurnQueue = new SessionTurnQueue();

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
  /**
   * End a turn the runtime has left open before this one starts, answering
   * whether it settled anything (`AgentRuntime.settleOpenTurn`). Absent for a
   * runtime that cannot strand a turn — which reads as "nothing to settle".
   */
  settleOpenTurn?(sessionId: string): Promise<boolean>;
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
   * Instructions the CALLER attaches to this turn's system prompt, ahead of
   * anything the person typed and behind everything DorkOS says about the agent
   * itself (`launch-resolver.ts` concatenates it after the base append).
   *
   * The channel for standing framing that must sit in the cacheable prefix
   * rather than in the turn's own words: a scheduled task's brief, a room's
   * `ROOM.md` conventions. Not for anything a person typed — that is `content`,
   * and not for per-turn signals — those are `additionalContext` (ADR-0273).
   *
   * Passed straight to the runtime, which decides how to deliver it: claude-code
   * puts it on the SDK's `systemPrompt.append` and relaunches a warm process
   * when it changes, while codex and opencode have no system-prompt channel and
   * compose it into each turn's input. All three deliver a CHANGED value on the
   * next turn of a running session, which the shared runtime conformance suite
   * pins (`project-rooms` §3.3).
   */
  systemPromptAppend?: string;
  /**
   * Which billing account this LAUNCH should run on, as a Claude account
   * registry id. Set only by the route that accepted a person's pre-launch
   * choice on the send that creates a claude-code session; passed straight
   * through to the runtime, which resolves it against the registry and stores
   * nothing (ADR 260821-205323).
   */
  accountHint?: string;
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
  /**
   * The dispatcher's id for this message, handed to the runtime so a `result`
   * can be correlated back to the message that caused it.
   *
   * Correlation is by id and NEVER positional: a runtime that coalesces a
   * dequeued batch answers several dispatched ids with ONE result, so counting
   * results against sends silently mismatches. Absent for a caller that has not
   * been through the dispatcher (there is none in production).
   */
  messageId?: string;
  /** The projector for `sessionId` (keyed by the client-facing id, which is stable). */
  projector: SessionStateProjector;
  deps: TriggerTurnDeps;
  /** Inactivity window before the stall watchdog fires. Defaults to SESSIONS.TURN_STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
  /**
   * How long this trigger may wait for the same client's earlier turns on this
   * session before proceeding anyway. Defaults to SESSIONS.LOCK_TTL_MS, so a
   * queued turn is never made to wait longer than the point at which a STRANGER
   * could take the lock out from under the turn ahead of it (review G1c).
   */
  queueWaitMs?: number;
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
 * ## What the 202 means for a QUEUED trigger (DOR-1088)
 *
 * When this client already has a live turn on this session, the trigger waits
 * its turn (subtlety 5 in the module doc) and this promise resolves only once
 * the queued turn actually STARTS. That keeps the 202's meaning exactly what it
 * has always been — "your turn is running; watch `/events`" — with an accurate
 * canonical id and a real 409 still available if the lock is gone by then.
 * Resolving the 202 at enqueue time instead would have to invent a third answer
 * for a turn that later fails to acquire, and would tell the cockpit its queue
 * had drained while the messages were still lined up server-side, which is how
 * a person loses the chance to edit one. The cost is an HTTP request held open
 * for the wait, bounded by `queueWaitMs` — see the module doc's "Known bounds".
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
    systemPromptAppend,
    accountHint,
    settings,
    projector,
    deps,
  } = opts;

  // A live session answers to EVERY id it has ever held — the request UUID the
  // client first used and the canonical id the runtime assigns mid-first-turn —
  // and the runtime resolves both to one session. So the queue and the lock must
  // key on the id the RUNTIME would resolve to, never on the id this request
  // happened to carry: keyed on the raw id, the same tab's second POST (sent
  // under the canonical id it just read off its own 202) missed both and started
  // a second stream into one projector (review G4). `turnKey` is that resolved
  // id, and it is re-pointed mid-turn the moment a canonical id appears.
  let turnKey = deps.getInternalSessionId(sessionId) ?? sessionId;

  // One turn at a time per client (DOR-1088). Reserve BEFORE anything else so
  // two triggers arriving in the same tick are ordered by arrival, then wait for
  // whatever this client already has running on this session. A different client
  // never waits here — its answer is the lock's, unchanged.
  const slot = sessionTurnQueue.reserve(
    turnKey,
    clientId,
    opts.queueWaitMs ?? SESSIONS.LOCK_TTL_MS
  );
  await slot.ready;

  // Acquire against a detached lifecycle so the lock is bound to the turn, not
  // to the soon-to-be-closed POST response. The per-turn token (I1) makes this
  // turn's release token-matched: if this turn goes dark, loses its lock to the
  // TTL and a later same-client turn takes it, this turn's stale releaseOnce
  // becomes a no-op and cannot drop the newer lock (which would admit a
  // concurrent writer).
  // One probe, two consumers (DOR-782): the stall watchdog must not shoot a turn
  // parked on a person, and the lock must not expire under one. Read off the
  // projector's pending-interaction set rather than `lifecycle === 'blocked'` —
  // the set IS the pending state, while the lifecycle is a projection a later
  // status_change can overwrite.
  const waitingOnPerson = (): boolean => projector.hasPendingInteractions();
  const lifecycle = new DetachedTurnLifecycle(waitingOnPerson);
  const lockToken = Symbol('detached-turn-lock');
  if (!deps.acquireLock(turnKey, clientId, lifecycle, lockToken)) {
    slot.release();
    return { accepted: false };
  }

  // Idempotent release: explicit on completion/error, plus the lifecycle close
  // that drives the lock manager's own cleanup. Both funnel through here. The
  // token ensures only THIS turn's acquisition is released. The queue slot goes
  // with it — the next turn this client sends may start the moment the lock this
  // one held is gone, and not one moment before.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    // `turnKey`, not `sessionId`: a mid-turn canonical id moves the lock, and
    // the release has to target wherever it ended up.
    deps.releaseLock(turnKey, clientId, lockToken);
    lifecycle.close();
    slot.release();
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
    // The projector is not the only thing keyed by session id. The client is
    // about to start using this canonical id (the 202 hands it over), and a POST
    // arriving under it has to meet THIS turn's chain and THIS turn's lock —
    // otherwise the tab's own next message starts a second stream into the
    // projector we just re-pointed (review G4).
    if (canonical !== turnKey) {
      sessionTurnQueue.link(canonical, turnKey);
      // Move the write-lock rather than holding two: acquire under the new id,
      // then drop the old. A refusal means someone else already holds the
      // canonical id, which this turn cannot resolve — keep the lock we have and
      // let the existing refusal paths answer.
      if (deps.acquireLock(canonical, clientId, lifecycle, lockToken)) {
        deps.releaseLock(turnKey, clientId, lockToken);
        turnKey = canonical;
      }
    }
  };
  // Everything from here to `void turn` runs BEFORE anything else can release
  // the lock or the queue slot: if it throws, no turn exists to settle and no
  // `finally` will ever fire, so the release has to happen in the catch. Left
  // unguarded, one throwing context assembly would hold the lock to its TTL and
  // wedge every later turn this client sends to this session (DOR-1088).
  try {
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
    // Fold in any context a person STAGED for a runtime that cannot append to
    // its own transcript (the fold-into-next fallback, task 4.2). Taken — not
    // peeked — so each note rides exactly this one dispatch; the ordinary case
    // holds nothing and pays a single map lookup. A native-staging runtime never
    // fills this hold, so its dispatches are untouched.
    additionalContext.push(...takeStagedContext(sessionId));
    // Nothing below may open a turn while this session still has one open
    // (DOR-1295) — `feedProjector` mints this turn's `turn_start` before it pulls
    // the generator once, so a turn settled any later than here settles INSIDE
    // this one. `settle-open-turn.ts` carries the whole reasoning, including why
    // the wait is unconditional and why it may precede the boundary gate.
    //
    // Asked with `sessionId` rather than `turnKey` because it addresses the same
    // wiring `deps.sendMessage` below addresses, and that takes the id the
    // request carried. A turn's budget is the flat bound: unlike a command
    // intent, a turn's POST carries no abort signal and so has no client-side
    // deadline to stay under.
    await settleOpenTurnBefore(sessionId, projector, deps, SESSIONS.STRANDED_TURN_SETTLE_MS);
    const tapped = tapEachEvent(
      deps.sendMessage(sessionId, content, {
        cwd,
        additionalContext,
        ...(systemPromptAppend !== undefined ? { systemPromptAppend } : {}),
        ...(accountHint !== undefined ? { accountHint } : {}),
        ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
        ...settings,
      }),
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
      // A turn that has not yielded once has not shown it is running, so its
      // first gap gets the tighter window (DOR-1229). Not a caller option: no
      // caller has a reason to want a launch that never starts to sit longer,
      // and the guard already takes the shorter of this and `timeoutMs`.
      firstEventTimeoutMs: SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS,
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
  } catch (err) {
    // No turn was launched, so nothing downstream will ever settle. Give the
    // lock and the queue slot back here or this session is wedged for this
    // client until the lock's TTL — and the queue, which has no TTL, forever.
    releaseOnce();
    throw err;
  }

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
