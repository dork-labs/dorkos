/**
 * Turn windowing over the pump's single continuous output (spec
 * `persistent-session-runtime` §5, task 3.3).
 *
 * ## The rule
 *
 * **A DorkOS turn OPENS on dispatch and CLOSES on the `result` that answers
 * it.** Today the units coincide — one `sendMessage` is one `query()` is one
 * `result` is one `turn_end` — which is why nothing needed windowing. A pump
 * pulls them apart: one process, many turns, and a CLI that can start
 * continuations DorkOS never asked for. This module is the layer that cuts the
 * discrete turns the durable stream expects out of that continuous stream.
 *
 * ## Correlation is by id, never by position
 *
 * Every dispatched message is stamped with its server-minted `messageId` as the
 * SDK message's `uuid` (`HeldUserPrompt.push`), and the SDK echoes it back
 * on the `result` as `user_message_uuid`. Matching on that id is the whole
 * design: the CLI coalesces a dequeued BATCH into ONE assistant turn answered by
 * ONE `result`, so "the nth result answers the nth message" is false the first
 * time two rows are dequeued together. Text matching was rejected for the same
 * ambiguity when the room runner needed turn identity; it is not coming back.
 *
 * A window therefore carries a SET of ids — every message of the batch that
 * opened it — and the correlated `result` closes all of them at once.
 *
 * ## Four kinds of `result`, and why only one of them opens a window of its own
 *
 * | The `result` carries                        | What it means                              | What happens                                                        |
 * | ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
 * | a `user_message_uuid` the open window holds | it answers this dispatch                   | the window closes — one `turn_end`                                   |
 * | no `user_message_uuid` at all               | the SDK does not carry one here            | it terminates whatever window is open, else a runtime window         |
 * | a `user_message_uuid` an EARLIER window sent | the CLI carried that message into this turn | the OPEN window closes on it (DOR-1294)                             |
 * | a `user_message_uuid` this session never sent | the CLI answered something nobody sent    | a synthetic `origin: 'runtime'` window; the open window is UNTOUCHED |
 *
 * The second row is reality winning over the spec's phrasing, and it is
 * load-bearing: `SDKResultError` — every `error_during_execution`,
 * `error_max_turns`, `error_max_budget_usd` result — has NO `user_message_uuid`
 * field at all (`sdk.d.ts`, `SDKResultSuccess` declares it, `SDKResultError`
 * does not). Treating an unnamed result as uncorrelated would strand the open
 * window forever on every failed turn, which is precisely the bug windowing
 * exists to prevent. It is not positional guessing either: an unnamed result
 * closes the ONE open window whole, ids and all, which is the same answer
 * coalescing gives — no ordinal is ever counted.
 *
 * ## A message id outlives the window that sent it (DOR-1294)
 *
 * The third row is the one a live measurement bought. The CLI decides for itself
 * WHEN a message it accepted becomes part of a turn, and a steer pushed at the
 * tail of a turn can miss it: the turn ends on its own `result`, the steered
 * message stays in the CLI's queue, and the CLI answers it in the NEXT turn it
 * runs — coalesced with whatever DorkOS dispatched by then, under ONE `result`
 * naming the steer. Correlating only against the OPEN window's ids read that as
 * "a message this session never sent", gave it a runtime window, and left the
 * dispatched window with no `result` that could ever close it. Every later
 * dispatch then found a window open and the session was dead until restart —
 * one arm-B run in three, in the P5.1 measurement
 * (`research/20260817_persistent-session-flag-measurement.md` §6).
 *
 * So the ids this session has SENT and not yet seen answered outlive their
 * window ({@link SessionTurnWindows.awaitingResult}, bounded by
 * {@link MAX_AWAITING_IDS}). A `result` naming one of them is the CLI ending the
 * turn it was running, and the open window is this layer's claim on that turn —
 * so it closes it. The distinction against the fourth row is real and worth
 * keeping: an id nobody ever sent is a continuation the CLI started by itself,
 * which genuinely is a turn of its own.
 *
 * ## A steered window waits to see whether the steer got a turn of its own
 *
 * The third row above is the case where a LATER dispatch was already open to
 * take the late answer. When there is no later dispatch, the same CLI behaviour
 * lost the whole answer instead (DOR-1314). The person steers at the tail of a
 * turn; the CLI ends that turn on the dispatched message's `result`, then runs
 * the steer as a turn of its own — and every word of that second turn arrives
 * with no window open, so it becomes a synthetic runtime window that
 * `PersistentDispatch` drains and drops. Three flag-on runs in DOR-1312 hit it
 * after EVERY steer, 23 to 53 events each.
 *
 * So a `result` that names one of a window's ids while a STEERED id of that
 * window is still unanswered does not close it. The close is deferred for
 * {@link CONTINUATION_GRACE_MS}, and three things settle it:
 *
 * - **The CLI starts a turn** (an `assistant` message or the `stream_event`
 *   partials of one — {@link beginsATurn}). The clock stops, the continuation's
 *   text lands in the turn the person is watching, and the window closes on the
 *   `result` that names the steer. The wait is for the continuation to BEGIN,
 *   never for it to finish, so a long turn is not cut short.
 * - **The clock runs out.** The deferred `result` closes the window exactly as
 *   it would have immediately. A coalesced steer costs half a second, nothing
 *   more — and only in the shape where the `result` named the DISPATCHED id; a
 *   `result` naming the steer itself leaves nothing outstanding and closes at
 *   once.
 * - **...unless the process is demonstrably still working**, in which case the
 *   wait extends to {@link CONTINUATION_CAP_MS}. Any frame that is not content
 *   — an `api_retry` before the continuation's first request, an `auto`
 *   `compact_boundary` taken to make room for the steer's turn, a late tool
 *   result — is proof of life without being proof a turn began, and the short
 *   clock is the wrong question to keep asking of a process that is visibly
 *   busy. Extending to the cap rather than adding another grace is what makes
 *   this cover the real gaps: an `api_retry` announces a 700ms backoff, which
 *   outlasts any single 500ms grace by itself (DOR-1314 review, probe D).
 * - **Something else needs the window NOW** — a dispatch, a `settleOpenTurn`, a
 *   crash. Each takes the deferred `result` with it.
 *
 * **The deferred `result` is never dropped while the window lives.** Only the
 * TIMER is cancellable. That is what keeps every one of those exits honest, and
 * it is what makes the re-arm above safe: however many times the clock is reset
 * by a talking process, the window is holding a real terminal the whole time,
 * so reaching the cap is a clean close and never a hang. Cleared together, they
 * left a healthy turn waiting to be stamped "the agent never finished this
 * turn" by the next message that came along.
 *
 * ## And a window may not outlive its turn, whatever the ids say
 *
 * Correlation is a best effort against another process's bookkeeping, so the
 * ingress has a backstop that does not depend on it: a dispatch that finds a
 * window still open ABANDONS it — one synthetic error `result`, one `turn_end`,
 * the pump's turn ended — and proceeds, rather than refusing forever. See
 * {@link SessionTurnWindows.dispatch}.
 *
 * ## Out-of-window messages are attributed, never dropped
 *
 * The process talks between turns (a `system/init` from an explicit warm, a
 * tool that was still running when its turn ended). Those messages are held and
 * flushed into whichever window comes next — the next dispatch's, or the
 * synthetic runtime window a stray `result` opens. The durable stream stays a
 * complete account of the session, which is the same honesty rule the presence
 * contract already enforces. The buffer is bounded ({@link MAX_UNATTRIBUTED_MESSAGES});
 * a session that somehow exceeds it drops its oldest held messages with a warning
 * rather than growing without limit.
 *
 * The one exception is a CRASH, which drops the hold outright: the words belong
 * to a process that no longer exists, and the next window belongs to a different
 * one. {@link SessionTurnWindows.onCrash} carries the reasoning in full.
 *
 * This deliberately does NOT re-derive the projector's reopen predicate
 * (DOR-1100): a closed window reopens on raw model speech and nothing else, and
 * that rule keeps working unchanged INSIDE each window's stream.
 *
 * @module services/runtimes/claude-code/sessions/session-turn-windows
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContextUsage, UsageStatus } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import type { TurnOrigin } from '../../../session/session-event-normalizer.js';
import { validateDispatchBoundary } from '../dispatch-boundary.js';
import { fetchContextBreakdown } from '../sdk/context-usage.js';
import { fetchSubscriptionUsage } from '../sdk/subscription-usage.js';
import {
  PumpRefusedError,
  type PumpControlQuery,
  type PumpCrash,
  type PumpDispatch,
} from './session-pump-contract.js';

/**
 * How long a window's accounting fetch may take before the window closes
 * without it. Matches `message-sender`'s bound for the same two control calls,
 * because it is the same fetch against the same control channel — only now it
 * runs at every window close instead of at the one close that ended the process.
 */
const WINDOW_USAGE_TIMEOUT_MS = 8_000;

/**
 * How many between-window messages are held before the oldest are dropped.
 *
 * Generous: a turn's worth of trailing tool traffic is tens of messages, and the
 * hold is normally emptied within seconds by the next window. The cap exists so
 * a session that is warm for hours and never dispatched again cannot grow this
 * buffer without limit.
 */
const MAX_UNATTRIBUTED_MESSAGES = 500;

/**
 * How many sent-but-unanswered correlation ids are remembered before the oldest
 * are forgotten.
 *
 * Generous, and cheap: an id is a short string, and the set only grows when the
 * CLI answers a batch with one `result` (every OTHER id of that batch stays,
 * unanswerable and harmless). The cap exists so a session that runs for hours
 * cannot grow this set without limit; forgetting the oldest costs nothing but
 * the DOR-1294 correlation for a message sent hundreds of turns ago.
 */
const MAX_AWAITING_IDS = 200;

/**
 * How long a steered window waits, after the `result` that answered its
 * dispatch, for the CLI to START the turn it queued the steer into (DOR-1314).
 *
 * The wait is for the FIRST message of that turn, not for the turn itself:
 * once anything arrives the grace is cancelled and the window closes on the
 * `result` that names the steer, however long the work takes. So this bounds
 * only the case where the CLI has nothing more to say — it folded the steer
 * into the turn it just answered, or dropped it — and half a second is far more
 * than the CLI needs to begin speaking after ending a turn on the same process.
 *
 * A bound is not optional. Waiting forever is how DOR-1294 killed a session:
 * a window that cannot close refuses every later dispatch. Here the cost of the
 * timer expiring is nothing at all — the deferred `result` closes the window
 * exactly as it would have closed it immediately.
 */
const CONTINUATION_GRACE_MS = 500;

/**
 * The MOST a steered window may defer its close, measured from the first time
 * the grace was armed (DOR-1314 review, probe D).
 *
 * A bound on the wait for a process that is demonstrably still working, not on
 * the wait for a first word. Any frame that is not content extends the wait to
 * THIS, rather than to another {@link CONTINUATION_GRACE_MS}, because the gaps
 * it has to cover are longer than one grace: an `api_retry` announces its own
 * backoff (700ms in the review's probe D, and a ladder backs off further), and
 * an `auto` compaction takes seconds. Adding a grace per frame would still have
 * lost both, since neither emits anything more until the continuation starts.
 *
 * Ten graces. Long enough for a retry ladder or a compaction ahead of the
 * continuation — both are seconds on this path, not tens of seconds — and short
 * enough that a process emitting bookkeeping forever cannot sit on a finished
 * turn indefinitely. Reaching the cap costs nothing: the deferred `result` is
 * held throughout, so expiry is a clean close on the CLI's own terminal and
 * never a hang.
 *
 * Measured from the first arming, and reset only by a discrete new reason to
 * expect a continuation — another `result` deferred, or another steer — never
 * by the process's own chatter, which is the whole point of having a cap.
 */
const CONTINUATION_CAP_MS = 5_000;

/** The per-window accounting fetched from the still-live process at its close. */
export interface WindowUsage {
  /** The authoritative per-category context breakdown, when the fetch answered. */
  context?: ContextUsage;
  /** The current subscription utilization, when this session has one. */
  subscription?: UsageStatus;
}

/** One slice of the pump's output: the turn a dispatch opened, or one nobody asked for. */
export interface TurnWindow {
  /**
   * Every `messageId` this window answers, in dispatch order. More than one
   * when a dequeued batch coalesced into a single turn; EMPTY on a synthetic
   * runtime window, because nobody dispatched it.
   */
  readonly ids: readonly string[];
  /**
   * `'user'` when a dispatch opened this window, `'runtime'` when a `result`
   * answering no dispatch did. Passed straight through to `turn_start.origin`,
   * so a window nobody asked for cannot be disguised as a person's turn.
   */
  readonly origin: TurnOrigin;
  /**
   * This window's messages, in the order the process produced them, ending when
   * the window closes. Iterate it exactly once — it is the stream the
   * ADR-0264 pipeline maps and feeds to `feedProjector`.
   */
  readonly messages: AsyncIterable<SDKMessage>;
}

/** The slice of `SessionPump` the windower drives. `SessionPump` satisfies it. */
export interface WindowedPump {
  /** Run one dequeued batch as one turn. */
  dispatch(batch: readonly PumpDispatch[]): Promise<void>;
  /** `RUNNING → WARM`, once the closing window's accounting is done. */
  endTurn(): void;
  /** The live process's control channel, for the per-window accounting fetch. */
  readonly controlQuery: PumpControlQuery | undefined;
}

/** Everything the windower needs to cut turns out of one pump's output. */
export interface SessionTurnWindowsOptions {
  sessionId: string;
  /** The pump whose output is being windowed. */
  pump: WindowedPump;
  /**
   * A window opened.
   *
   * Built as the stall watchdog's arm seam — per window, not per process,
   * because a WARM session sitting legitimately silent for ten minutes must not
   * be interrupted for it. **No watchdog is wired to it today (task 3.10):** on
   * the pump path each `sendMessage` generator carries exactly one window, so
   * `withStallGuard` measures a single turn's silence without being told about
   * windows at all. The seam is kept for P4's `deliverIntoTurn`, where one
   * stream will carry several. `PersistentDispatch` uses this to notice a
   * window nobody dispatched, so it can be drained rather than left buffering.
   */
  onWindowOpen?: (window: TurnWindow) => void;
  /**
   * A window closed and its stream has ended. **The stall watchdog disarms
   * here** — the signal's `closed`, which disarms only once the LAST open
   * window is gone, so a runtime window closing beside a dispatched one leaves
   * the turn somebody is waiting for still guarded.
   *
   * The process-idle timer is deliberately NOT armed here. It rides the pump's
   * `onStateChange` instead (`session-pump-registry.ts`), because a session can
   * reach WARM without any window ever having opened — an explicit `warm()` —
   * and arming from here would leave that one holding its subprocess forever.
   */
  onWindowClose?: (window: TurnWindow) => void;
  /**
   * This window's accounting, delivered BEFORE its `result` is released so the
   * `context_usage` event still precedes `done` — exactly the ordering
   * `message-sender` gets today by fetching just ahead of the result mapper,
   * only now it happens at every window close rather than at the first.
   */
  onUsage?: (usage: WindowUsage) => void;
  /** Override the bound on the accounting fetch. */
  usageTimeoutMs?: number;
  /** Override {@link CONTINUATION_GRACE_MS}, for tests that drive it directly. */
  continuationGraceMs?: number;
  /** Override {@link CONTINUATION_CAP_MS}, for tests that drive it directly. */
  continuationCapMs?: number;
}

/** A buffered stream of SDK messages with an explicit end. */
class WindowChannel {
  private readonly pending: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  /** Hand a message to the consumer, or hold it until one arrives. */
  push(message: SDKMessage): void {
    if (this.ended) return;
    this.pending.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  /**
   * Take back everything pushed but not yet consumed, emptying the channel.
   *
   * For a window that is being abandoned before anyone observed it: its
   * messages belong to no window now, so they go back on hold for the next one
   * rather than dying in a stream nothing will ever read.
   */
  takePending(): SDKMessage[] {
    return this.pending.splice(0, this.pending.length);
  }

  /** No more messages will come. Idempotent. */
  end(): void {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** Every message pushed, in order, until {@link end}. */
  async *drain(): AsyncGenerator<SDKMessage> {
    for (;;) {
      while (this.pending.length > 0) yield this.pending.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** A window plus the machinery that fills it. */
interface WindowRecord {
  ids: string[];
  origin: TurnOrigin;
  channel: WindowChannel;
  window: TurnWindow;
  /**
   * The subset of {@link ids} a STEER added, still waiting for a `result` that
   * names it. A dispatched batch's ids are answered together by one `result`;
   * a steered id may instead get a turn of its own (DOR-1314), which is the
   * whole reason these are counted apart.
   */
  steered: Set<string>;
  /** The grace timer running right now, if this window is waiting on a steer. */
  grace?: ReturnType<typeof setTimeout>;
  /**
   * The wall-clock moment past which this window may not defer any further,
   * however much the process keeps talking ({@link CONTINUATION_CAP_MS}). Set
   * when the grace is first armed for a given reason, and cleared with it.
   */
  graceDeadline?: number;
  /** The `result` that would have closed this window, held for the grace. */
  deferred?: SDKMessage;
}

/** Build a window record and the public handle onto it. */
function createRecord(ids: string[], origin: TurnOrigin): WindowRecord {
  const channel = new WindowChannel();
  return {
    ids,
    origin,
    channel,
    window: { ids, origin, messages: channel.drain() },
    steered: new Set<string>(),
  };
}

/**
 * The id an SDK `result` says it answers, or `undefined` when it carries none.
 *
 * Read defensively rather than by type narrowing: only `SDKResultSuccess`
 * declares `user_message_uuid`, and the absence on `SDKResultError` is a fact
 * this module's correlation rules turn on.
 */
function readAnsweredId(message: SDKMessage): string | undefined {
  const named = (message as { user_message_uuid?: unknown }).user_message_uuid;
  return typeof named === 'string' && named.length > 0 ? named : undefined;
}

/**
 * The `result` a dead process never got to send.
 *
 * Deliberately carries no `terminal_reason`: the mapper turns a non-success
 * subtype into a typed `error` event, and `feedProjector`'s existing error latch
 * settles the window as `turn_end{terminalReason:'error'}`. Resolving the
 * terminal by the existing rules is the spec's instruction, and it beats
 * inventing an SDK reason string that the SDK itself never emits.
 */
function crashResult(crash: PumpCrash): SDKMessage {
  const detail = crash.error instanceof Error ? crash.error.message : undefined;
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [
      detail === undefined
        ? 'The agent stopped before it finished this turn.'
        : `The agent stopped before it finished this turn: ${detail}`,
    ],
    uuid: `crash-${crash.sessionId}`,
    session_id: crash.sessionId,
  } as unknown as SDKMessage;
}

/**
 * Whether this message is the CLI STARTING a turn, rather than bookkeeping it
 * emits between them.
 *
 * Two shapes prove it: `assistant`, and the `stream_event` partials that carry
 * one. A turn's own work is always preceded by an `assistant` — a tool call is
 * an `assistant` message before it is a `user` tool result — so within a turn
 * this is a sound signal.
 *
 * **It is not a complete one, and the caller does not treat it as one.** The
 * CLI emits frames BEFORE a continuation's first word that are not content at
 * all: an `api_retry` when the continuation's first request is retried, an
 * `auto` `compact_boundary` taken to make room for the steer's turn. Reading a
 * `false` here as "no continuation is coming" lost exactly those (DOR-1314
 * review, probe D). So a `false` does not close anything on its own — it means
 * "not yet proven", and {@link onMessage} answers it by re-arming the grace
 * within the cap rather than by letting the clock run out.
 *
 * The two shapes deliberately excluded are the ones the module doc names as
 * routine between-turn traffic: a `system` line, and the `user` tool result of
 * a tool that was still running when its turn ended. That late tool result
 * belongs to the turn that JUST FINISHED, so it is not evidence a new one
 * began — but it IS evidence the process is alive, which is why it re-arms.
 * The two answers are different questions and the split is the whole point:
 * only content stops the clock, anything else merely postpones it.
 *
 * @param message - The message the process just produced
 */
function beginsATurn(message: SDKMessage): boolean {
  return message.type === 'assistant' || message.type === 'stream_event';
}

/**
 * The `result` a turn never produced, for a window that has to be closed anyway.
 *
 * Same shape and same reasoning as {@link crashResult}: a non-success subtype
 * maps to a typed `error` event and `feedProjector`'s error latch settles the
 * window as `turn_end{terminalReason:'error'}`. The wording is the operator's,
 * not the SDK's, because nothing in the SDK ever said this — DorkOS is the one
 * declaring the turn over (DOR-1294).
 */
function strandedResult(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['The agent never finished this turn, so DorkOS ended it to accept the next message.'],
    uuid: `stranded-${sessionId}`,
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/**
 * Cuts one pump's continuous output into turn windows, correlated by
 * `messageId`.
 *
 * Wire it to the pump's two observer seams — `onMessage` → {@link onMessage},
 * `onCrash` → {@link onCrash} — and dispatch through {@link dispatch} rather
 * than through the pump, so every turn has a window around it.
 */
export class SessionTurnWindows {
  private readonly opts: SessionTurnWindowsOptions;
  private current: WindowRecord | undefined;
  /**
   * Every close in flight — their accounting fetches outlive the `result`s that
   * caused them, and there can be more than one at a time (see {@link finish}).
   * A close removes itself once it has fully settled.
   */
  private readonly closingWindows = new Set<Promise<void>>();
  /** Messages that arrived with no window open, waiting for the next one. */
  private readonly held: SDKMessage[] = [];
  /**
   * Every correlation id this session has pushed at the process and not yet
   * seen a `result` name — insertion-ordered, bounded by
   * {@link MAX_AWAITING_IDS}.
   *
   * This is what makes an id outlive the window that sent it, which is the
   * DOR-1294 fix: see the module doc. Emptied on a crash, for the same reason
   * the held buffer is — the process that owed those answers is gone, and the
   * next one owes nothing under an old id.
   */
  private readonly awaitingResult = new Set<string>();

  /**
   * Build a windower over one pump.
   *
   * @param opts - The pump, the window observers, and the accounting seam
   */
  constructor(opts: SessionTurnWindowsOptions) {
    this.opts = opts;
  }

  /** The window that is open right now, if any — what the stall watchdog guards. */
  get openWindow(): TurnWindow | undefined {
    return this.current?.window;
  }

  /**
   * End the window this session has left open, ahead of the turn that is about
   * to replace it (DOR-1295).
   *
   * The same abandonment {@link dispatch} performs as its backstop, reachable
   * BEFORE a successor's turn exists. That ordering is the whole point.
   * `dispatch`'s call happens inside the successor's own generator, which
   * `feedProjector` only pulls AFTER minting the successor's `turn_start` — so
   * the stranded turn's terminal reliably arrived inside the successor's turn,
   * settling a healthy turn as the abandoned one's error and splitting its
   * durable rows across two turns. Called from the seam that composes a turn
   * (`trigger-turn`), this settles the old turn while the successor is still
   * only an intention.
   *
   * `dispatch` keeps its own backstop: this is a courtesy the composer extends,
   * and the ingress invariant may not depend on every caller extending it.
   *
   * **The return value is about HONESTY, not about whether work happened.** The
   * caller (`settle-open-turn.ts`) turns a `true` into "ended a turn that never
   * finished" in the operator's log, so it may only be `true` when that
   * sentence is TRUE. A window mid-grace has a real `result` in hand — its turn
   * finished perfectly and DorkOS was merely waiting to see whether a steered
   * message got a turn of its own (DOR-1314) — so it settles on that result and
   * answers `false`. The settle still happened; the caller's unconditional wait
   * on the projection covers it either way.
   *
   * @returns True when a turn that never finished had to be abandoned, false
   *   when there was nothing to settle — which is every ordinary turn — or when
   *   a finished turn settled on the real `result` it was holding
   */
  abandonOpenWindow(): boolean {
    if (this.current === undefined) return false;
    // A window mid-grace is not stranded — its turn ended, and DorkOS was only
    // waiting to see whether a steer got a turn of its own (DOR-1314). It gets
    // the real `result` it is holding rather than a synthetic error.
    if (this.settleDeferredNow(this.current)) return false;
    this.abandonStranded(this.current);
    return true;
  }

  /**
   * Add a steered message's id to the OPEN window so the turn's `result` still
   * correlates (spec `persistent-session-runtime` §2.3, task 4.1).
   *
   * A steer pushes a second user message into the running turn's input stream,
   * and the CLI coalesces it into the SAME assistant turn — answered by ONE
   * `result` carrying ONE `user_message_uuid`, which may be the steer's rather
   * than the opening message's. Unless the open window holds the steer's id
   * too, that `result` would be read as answering a message this session never
   * sent (see {@link onResult}), opening a synthetic runtime turn beside the
   * real one and stranding the real one open. Adding the id is what keeps a
   * steered turn to exactly one `turn_start` and one `turn_end`.
   *
   * The id joins the window's live `ids` array — the same array
   * {@link TurnWindow.ids} exposes — so a `result` that arrives after this is
   * correlated whichever of the batch's ids it names.
   *
   * @param messageId - The steered message's server-minted correlation id
   * @returns True when a window was open to steer, false when none was (the
   *   turn closed between the caller's check and here)
   */
  steerOpenWindow(messageId: string): boolean {
    if (this.current === undefined) return false;
    this.current.ids.push(messageId);
    // Counted apart from the batch's own ids: the CLI decides for itself
    // whether a steer joins the running turn or gets one of its own, and this
    // window may not close until it has said which (DOR-1314, {@link onResult}).
    this.current.steered.add(messageId);
    // A steer that lands DURING the grace restarts it. The grace is exactly
    // when a person types — the agent has just gone quiet — and letting the
    // original clock run out under a brand-new steer would close the window and
    // send that steer's answer into a runtime window nothing projects: the very
    // loss this mechanism exists to prevent, re-entered through its own repair.
    //
    // Only while the timer is still ARMED. Once a continuation has begun the
    // timer is already stopped, and re-arming it there would put a deadline on
    // a turn that is actively running.
    //
    // A person steering is a discrete new reason to expect a continuation, not
    // the process's own chatter, so the cap starts over with it.
    if (this.current.grace !== undefined) {
      this.current.graceDeadline = undefined;
      this.armGrace(this.current, 'grace');
    }
    // And remembered beyond this window, because the CLI may not answer a steer
    // inside the turn it joined — the DOR-1294 case, and the one this ledger was
    // built for. Remembered on the TAG rather than on a successful push, exactly
    // as the window's own `ids` are: the caller tags before it pushes (see
    // `PersistentDispatch.steer`), and an id nothing was sent under is inert —
    // no `result` can ever name it.
    this.rememberSent([messageId]);
    return true;
  }

  /**
   * Remember a STAGED message's id, which belongs to no window at all (spec
   * `persistent-session-runtime` §2.5, task 4.2).
   *
   * A staged message rides `shouldQuery: false`: the SDK appends it to the
   * transcript, runs no turn for it, and merges it into the next user message
   * that does query. So no window opens for it and no `result` is expected — but
   * the merged turn's single `result` may still name IT rather than the
   * dispatched message it merged into, and a `result` naming an id this layer
   * has never heard of is the shape that stranded a window in DOR-1294. Telling
   * the ledger about it costs one string and closes that door; an id no
   * `result` ever names is inert.
   *
   * @param messageId - The server-minted id the staged message was stamped with
   */
  noteStagedMessage(messageId: string): void {
    this.rememberSent([messageId]);
  }

  /**
   * Open a window for one dequeued batch and dispatch it.
   *
   * **This is the single ingress for a pump-driven turn**, which is what keeps
   * one session's turns to one at a time: a dispatch that arrives while the
   * previous window is still settling its accounting WAITS for it rather than
   * racing it, and a window that is somehow still open when the wait ends is
   * settled before this one opens (never two at once — see the abandonment
   * paragraph below).
   *
   * **The directory boundary is asked here, per dispatch, before anything is
   * sent** (task 3.9). On the resume-per-message path the same question is
   * asked at the top of every `executeSdkQuery`, which is per turn only because
   * every turn is a launch; a warm process is launched once and serves many
   * turns, so a cwd that moved between two dispatches would never be re-asked.
   * The relaunch pin list would catch most of those by forcing a new launch,
   * but a security boundary may not ride on a fingerprint comparison, so this
   * gate is its own — see `dispatch-boundary.ts`. A refused turn is refused
   * exactly as a refused pump dispatch is: nothing sent, no window announced,
   * so the person's queued message is still theirs.
   *
   * The window is REGISTERED before the pump is asked to dispatch but ANNOUNCED
   * only once the dispatch is accepted, and the split is deliberate. Registering
   * first is what attributes launch output — a `system/init`, or a whole fast
   * turn — to the window that caused it rather than to a runtime continuation;
   * the channel buffers it, so an observer that attaches a moment later still
   * reads it in order. Announcing last is what keeps a refused dispatch from
   * being observable at all: `onWindowOpen` is where the window is projected,
   * and a `turn_start` mints the turn identity that RETIRES the caller's queue
   * rows. Announcing before the refusal would retire a row for a turn that never
   * ran, and nothing could put it back — the dispatcher restores only rows still
   * in the store — so the person's message would be silently lost and the
   * durable stream would carry an empty turn that never happened. A dispatch
   * that throws therefore leaves no trace: no window opened, no window closed,
   * and anything the process managed to say goes back on hold for the next
   * window.
   *
   * **What the caller owes this gate.** `cwd` is validated as given, and the
   * pump does not carry a cwd of its own — `PumpLauncher` resolves the real one
   * behind its seam (`session-pump-contract.ts`). So this checks a directory
   * the caller NAMES, not the directory the process will actually run in, and
   * the two are the same only because the caller makes them the same. Whoever
   * composes this into `sendMessage` must therefore hand it the SAME value the
   * launcher resolves — `messageOpts?.cwd || opts.sessionCwd || opts.cwd`, the
   * effective-cwd chain in `messaging/message-sender.ts`, resolved once and
   * passed to both. Resolve it twice by two routes and the gate answers about
   * one directory while the turn runs in another, which is a check that only
   * looks like one.
   *
   * **A window that is still open when a dispatch arrives is ABANDONED, not a
   * refusal** (DOR-1294). It used to be an `IllegalPumpTransitionError`, on the
   * reading that a second dispatch mid-window is a caller bug — but the failure
   * that actually happened was the other one: a window whose `result` went
   * somewhere else stayed open forever, and every later dispatch threw, so the
   * session was dead until the server restarted. A caller reaching here holds
   * the per-session dispatch mutex and the turn's write-lock for the whole
   * stream, so a window still open under it is stranded rather than concurrent;
   * and even in the case where it is not, ending an older turn beats never
   * running another one. So it is closed the way a crash closes one — a
   * synthetic error `result`, one `turn_end`, the pump's turn ended so the
   * dispatch below is not refused a layer down — and said out loud.
   *
   * @param batch - The messages dequeued together, to run as one turn
   * @param cwd - The working directory this turn would run in, resolved by the
   *   caller for THIS dispatch rather than remembered from the launch, and
   *   identical to the value handed to the launcher (see above)
   * @returns The window this dispatch opened
   * @throws BoundaryError When `cwd` is not a directory the operator allowed
   * @throws PumpRefusedError When the batch is empty, or the pump refuses it
   */
  async dispatch(batch: readonly PumpDispatch[], cwd: string): Promise<TurnWindow> {
    if (batch.length === 0) {
      throw new PumpRefusedError(
        'empty-dispatch',
        `session ${this.opts.sessionId} was dispatched an empty batch; there is no turn to open`
      );
    }
    // Ahead of the wait below, not after it: a turn that may not run has no
    // business holding its caller for the length of another window's accounting
    // fetch. Nothing has been sent and no window exists yet, so the throw leaves
    // the session exactly as it found it.
    try {
      await validateDispatchBoundary(cwd);
    } catch (err) {
      // Said out loud, because a refusal nobody can see is how a
      // misconfigured boundary gets diagnosed as "my agent stopped answering".
      logger.warn('[SessionTurnWindows] refused a dispatch outside the directory boundary', {
        sessionId: this.opts.sessionId,
        cwd,
      });
      throw err;
    }
    // A window is not over until its accounting has been fetched, its `result`
    // released, and the pump's turn ended; dispatching into that gap would
    // attribute the tail of one turn to the next, or be refused by a pump still
    // RUNNING the turn nobody told it had finished.
    //
    // A window still holding a deferred close settles on its real `result`
    // FIRST, so the wait below covers it and the abandonment below never sees
    // it. The person is sending their next message, which answers the question
    // the grace was asking: no continuation is coming (DOR-1314).
    if (this.current !== undefined) this.settleDeferredNow(this.current);
    // EVERY close in flight, and looped rather than awaited once: a stray
    // `result` can open and close a runtime window while we wait here, and that
    // close has to be waited for too.
    while (this.closingWindows.size > 0) {
      await Promise.all([...this.closingWindows]);
    }
    // The backstop, and the reason this is not a throw any more: see the doc
    // above and the module doc (DOR-1294).
    if (this.current !== undefined) this.abandonStranded(this.current);
    const record = createRecord(
      batch.map((message) => message.messageId),
      'user'
    );
    this.current = record;
    this.flushHeld(record);
    try {
      await this.opts.pump.dispatch(batch);
    } catch (err) {
      // A turn that never began must leave NO trace: no observer has seen this
      // window, so none has to be told it closed.
      this.current = undefined;
      this.rehold(record.channel.takePending());
      record.channel.end();
      throw err;
    }
    // Only now that the batch really was sent: a refused dispatch put nothing on
    // the process's input stream, so no `result` will ever name these ids and
    // remembering them would be a lie the ledger cannot detect later.
    //
    // And only if this window is still the open one. A fast turn's `result` can
    // land during the await above — the DOR-1187 path, where the pump reaches
    // WARM mid-launch and the whole turn is answered before `dispatch` returns —
    // and it closed this window already. Remembering the ids then would file
    // them as UNANSWERED when the process has already spoken for them, arming
    // the `sentEarlier` branch to close some future window on a spent id.
    if (this.current === record) this.rememberSent(record.ids);
    this.opts.onWindowOpen?.(record.window);
    return record.window;
  }

  /**
   * The pump's `onMessage` seam: attribute one SDK message to a window.
   *
   * Synchronous by contract — the pump calls it from its read loop — so the
   * bookkeeping a later message depends on (which window is open) settles here,
   * while the accounting fetch a close needs runs on its own.
   *
   * @param message - The message the process just produced
   */
  onMessage(message: SDKMessage): void {
    if (message.type === 'result') {
      this.onResult(message);
      return;
    }
    if (this.current !== undefined) {
      // Two tiers, while this window is waiting to see whether a steer got a
      // turn of its own (DOR-1314).
      //
      // The process SPEAKING is the answer: the turn began, so the clock stops
      // outright and the window now closes on the `result` that names the
      // steer. Only the timer stops — the deferred `result` stays on as this
      // window's terminal until a better one arrives.
      //
      // Any OTHER frame is not the answer, but it is proof the process is alive
      // and mid-something — so the short clock stops being the right question
      // and the wait extends to the absolute cap. That is the review's probe D:
      // an `api_retry` announcing a 700ms backoff, or an `auto`
      // `compact_boundary` taken before the steer's turn, would otherwise let a
      // 500ms clock run out on a continuation already on its way. Extending to
      // the cap rather than adding one more grace is deliberate: neither of
      // those frames is followed by anything until the continuation starts, so
      // another 500ms would have missed it just the same.
      if (this.current.grace !== undefined) {
        if (beginsATurn(message)) this.stopGrace(this.current);
        else this.armGrace(this.current, 'until-cap');
      }
      this.current.channel.push(message);
      return;
    }
    this.hold(message);
  }

  /**
   * The pump's `onCrash` seam: close the open window as a failure.
   *
   * Exactly one terminal, because the window's stream ends immediately behind
   * the synthesized `result` — a relaunch's output can only land in a new
   * window. No accounting is fetched: the process that would answer is gone.
   * Task 3.6 owns what happens NEXT (resume, and the queue rows that survive);
   * this owns only the window that was open when the process died.
   *
   * **The held buffer dies with the process** (task 3.6). Whatever the dying
   * process said outside a window is DROPPED here, with a notice, rather than
   * flushed into the next window — which would belong to a different process
   * entirely. Three reasons, in order of weight:
   *
   * - Held messages are the process's OUTPUT, not anybody's input. Nothing a
   *   person typed is at risk: their words are rows in the durable queue, and
   *   the queue is untouched by a crash.
   * - Carrying them forward would attribute a dead process's words to a live
   *   process's turn — a lie about what happened inside that turn, and the hard
   *   kind to debug, because it reads as though the new process said them.
   * - Retiring them into a synthetic runtime window instead would put a turn on
   *   the stream for a session where nothing was running. After an explicit
   *   `warm()` the hold contains a `system/init` and nothing else, so every
   *   idle crash would mint a phantom turn — the exact thing task 3.6's
   *   acceptance forbids.
   *
   * @param crash - What the pump observed
   */
  onCrash(crash: PumpCrash): void {
    this.discardHeld();
    // The process that owed these answers is gone, and a relaunched one owes
    // nothing under an id it never read. Keeping them would let a fresh
    // process's stray `result` close a window on a dead process's id.
    this.awaitingResult.clear();
    const record = this.current;
    if (record === undefined) return;
    this.current = undefined;
    // Whatever this window was waiting for, the process that owed it is gone.
    this.finalizeGrace(record);
    record.channel.push(crashResult(crash));
    record.channel.end();
    this.opts.onWindowClose?.(record.window);
  }

  /** Route a `result` by the id it answers. See the module doc's table. */
  private onResult(result: SDKMessage): void {
    const answered = readAnsweredId(result);
    const record = this.current;
    // Answered once, whichever window it closes: an id the process has now
    // spoken for cannot correlate anything later.
    const sentEarlier = answered !== undefined && this.awaitingResult.delete(answered);
    if (record !== undefined && (answered === undefined || record.ids.includes(answered))) {
      if (answered !== undefined) record.steered.delete(answered);
      // A steer this window pushed that the CLI has NOT named yet. The CLI
      // queues a message pushed at the tail of a turn and answers it in the
      // NEXT turn it runs, so this `result` may not be the end of what the
      // person is owed — and closing on it strands that whole second turn
      // outside any window, where `PersistentDispatch` drains it and the
      // person never sees a word of it (DOR-1314). So the close waits, briefly,
      // to find out. An UNNAMED result is exempt: it is the error shape, and a
      // failed turn is terminal whatever is outstanding.
      if (answered !== undefined && record.steered.size > 0) {
        this.holdForContinuation(record, result);
        return;
      }
      this.current = undefined;
      this.finalizeGrace(record);
      this.finish(record, result);
      return;
    }
    if (record !== undefined && sentEarlier) {
      // A message this session really did send, in a window that has already
      // closed — so the CLI held it back and answered it inside the turn it is
      // running NOW, which is the turn this open window claims (DOR-1294).
      // Closing on it is what keeps the window from waiting for a `result` the
      // CLI has already spent.
      logger.warn('[SessionTurnWindows] a result answered a message an earlier window sent', {
        sessionId: this.opts.sessionId,
        answered,
        open: record.ids,
      });
      this.current = undefined;
      this.finalizeGrace(record);
      this.finish(record, result);
      return;
    }
    if (record !== undefined) {
      logger.warn('[SessionTurnWindows] a result answered a message this session never sent', {
        sessionId: this.opts.sessionId,
        answered,
        open: record.ids,
      });
    }
    // Nobody asked for this one. It gets a window of its own, tagged `runtime`,
    // carrying whatever the process said on its way here.
    const runtime = createRecord([], 'runtime');
    this.flushHeld(runtime);
    this.opts.onWindowOpen?.(runtime.window);
    this.finish(runtime, result);
  }

  /**
   * Hold a window open, briefly, to find out whether the CLI gave a steered
   * message a turn of its own (DOR-1314).
   *
   * The window stays THE open window: anything the process says next lands in
   * it, which is the whole point — a continuation's text belongs in the turn
   * the person is watching, not in a synthetic window nothing projects. The
   * `result` that would have closed it is held rather than pushed, because
   * pushing it ends the turn on the stream; if the continuation runs, the
   * `result` that names the steer closes the window instead and the held one is
   * never emitted. One turn, one terminal, both answers inside it.
   *
   * The held `result`'s own accounting is the cost of that merge: two CLI turns
   * become one DorkOS turn, and the `done` carries the LAST result's totals. So
   * the first CLI turn's per-turn `modelUsage` token split does not reach the
   * observability event. Cost is not lost with it — the SDK reports
   * `total_cost_usd` as a session running total, so the surviving `result`
   * carries both turns' spend. Attributing the second turn to nobody was the
   * alternative.
   *
   * **The held `result` is never discarded while this window lives.** It is
   * this window's terminal until something better replaces it, which is what
   * makes every later close honest: a dispatch, a `settleOpenTurn`, or an
   * abandonment all settle on the REAL result rather than stamping "the agent
   * never finished this turn" on a turn that finished perfectly. Only the TIMER
   * is cancellable ({@link stopGrace}); the terminal is not.
   *
   * @param record - The window whose close is being deferred
   * @param result - The `result` to close it with if nothing more arrives
   */
  private holdForContinuation(record: WindowRecord, result: SDKMessage): void {
    record.deferred = result;
    // A fresh `result` is a discrete new reason to expect a continuation, so
    // the cap starts over. Process chatter never gets to do this.
    record.graceDeadline = undefined;
    this.armGrace(record, 'grace');
  }

  /**
   * Start (or restart) the wait for a continuation to begin, never past this
   * window's absolute cap ({@link CONTINUATION_CAP_MS}).
   *
   * Restarted by two different kinds of thing, and telling them apart is what
   * the cap is for:
   *
   * - **A discrete new reason to expect a continuation** — another `result`
   *   deferred, or a steer arriving DURING the grace (DOR-1314 review, B2: the
   *   agent has just gone quiet, which is exactly when a person types, and
   *   letting the original clock run out under a brand-new steer would drop
   *   that steer's answer). Each of these clears the deadline first, so the cap
   *   starts over.
   * - **Evidence the process is alive and working** — any frame it emits that
   *   is not content ({@link onMessage}). These re-arm WITHIN the cap, so
   *   chatter can postpone the close but never prevent it.
   *
   * @param record - The window waiting on a continuation
   * @param wait - `'grace'` for the short question "did a turn begin?", asked
   *   of a process that has said nothing since. `'until-cap'` once the process
   *   has proven it is alive and mid-something, where the only useful bound
   *   left is the absolute one — see {@link onMessage}.
   */
  private armGrace(record: WindowRecord, wait: 'grace' | 'until-cap'): void {
    this.stopGrace(record);
    const grace = this.opts.continuationGraceMs ?? CONTINUATION_GRACE_MS;
    const cap = this.opts.continuationCapMs ?? CONTINUATION_CAP_MS;
    record.graceDeadline ??= Date.now() + cap;
    // Never negative. A cap already spent arms a zero-delay timer rather than
    // closing inline, because this runs inside the pump's synchronous read loop
    // and a close re-entering it there would attribute the next message to a
    // window that no longer exists.
    const remaining = Math.max(0, record.graceDeadline - Date.now());
    const capped = remaining === 0;
    const delay = wait === 'until-cap' ? remaining : Math.min(grace, remaining);
    record.grace = setTimeout(() => {
      record.grace = undefined;
      // Another path may have settled this window while the timer ran — a
      // dispatch, a crash, an abandonment. Whoever got there first owns the
      // close, and each of them takes {@link WindowRecord.deferred} with it.
      if (this.current !== record) return;
      const deferred = record.deferred;
      if (deferred === undefined) return;
      logger.debug('[SessionTurnWindows] no continuation began; closing the steered turn', {
        sessionId: this.opts.sessionId,
        steered: [...record.steered],
        capped,
      });
      this.finalizeGrace(record);
      this.current = undefined;
      this.finish(record, deferred);
    }, delay);
    // A held timer must never be the reason a server will not exit.
    record.grace.unref?.();
  }

  /**
   * Stop the grace TIMER and nothing else — {@link WindowRecord.deferred}
   * survives as this window's terminal.
   *
   * The distinction is the DOR-1314 review's first blocker. Dropping the
   * deferred `result` alongside the timer left the window with no terminal at
   * all whenever the timer was cancelled by something that turned out not to be
   * a continuation, so the window stayed open until the next message abandoned
   * it — a healthy turn stamped as one that never finished.
   *
   * @param record - The window whose timer is being stopped
   */
  private stopGrace(record: WindowRecord): void {
    if (record.grace !== undefined) clearTimeout(record.grace);
    record.grace = undefined;
  }

  /**
   * Let go of a window's grace state entirely, because it is being closed by
   * something that carries its own terminal.
   *
   * @param record - The window being closed
   */
  private finalizeGrace(record: WindowRecord): void {
    this.stopGrace(record);
    record.deferred = undefined;
    record.graceDeadline = undefined;
  }

  /**
   * Close a window on the real `result` it is holding, RIGHT NOW, rather than
   * leaving it for something coarser to abandon (DOR-1314).
   *
   * Shaped like {@link abandonStranded} rather than like a normal close, and
   * for the same reason: its callers are the ones that must not wait. The
   * settle-before-dispatch seam (`settle-open-turn.ts`) budgets ~2s for the
   * terminal to reach the projection, and {@link finish} would spend up to
   * `WINDOW_USAGE_TIMEOUT_MS` (~8s) on an accounting fetch first — long enough
   * for the successor's `turn_start` to mint ahead of this window's `turn_end`,
   * which is precisely the DOR-1295 ordering bug that seam exists to prevent.
   * So the accounting is sacrificed, exactly as an abandonment sacrifices it,
   * and the close is synchronous. What is NOT sacrificed is the terminal: a
   * real `result` beats a synthetic error every time, because this turn
   * genuinely ended and DorkOS was only waiting to see whether more was coming.
   *
   * @param record - The window to close
   * @returns True when a deferred close was taken, false when this window was
   *   not holding one
   */
  private settleDeferredNow(record: WindowRecord): boolean {
    const deferred = record.deferred;
    if (deferred === undefined) return false;
    this.finalizeGrace(record);
    this.current = undefined;
    record.channel.push(deferred);
    record.channel.end();
    this.opts.pump.endTurn();
    this.opts.onWindowClose?.(record.window);
    return true;
  }

  /**
   * Close a window: fetch its accounting from the still-live process, deliver
   * that, then release the `result` and end the stream. The pump's turn ends
   * last, so the next dispatch cannot start before this window is fully settled.
   *
   * **Registered in a SET, because more than one close can be in flight.** The
   * pump's read loop is synchronous, so a stray `result` — which opens AND
   * closes a runtime window — can land immediately before the `result` that
   * closes the dispatched window, with neither one's accounting back yet. A
   * single field cannot hold both: the second assignment would drop the first,
   * and whichever finished first would clear the field the other was still
   * parked in. `dispatch` would then sail past a close that had not reached
   * `pump.endTurn()`, and the pump would refuse a perfectly legitimate turn.
   *
   * A set rather than a chain so the closes stay CONCURRENT. Chaining would be
   * simpler, but it would make one window's close wait out another's control
   * fetch — up to the full accounting timeout — for two windows that have
   * nothing to do with each other.
   */
  private finish(record: WindowRecord, result: SDKMessage): void {
    const closing = this.settle(record, result)
      .catch((err: unknown) => {
        // A close that throws must not take the others with it: the windows
        // behind it still have to settle, and an unrelated dispatch must never
        // inherit somebody else's failure.
        logger.warn('[SessionTurnWindows] a window failed to settle', {
          sessionId: this.opts.sessionId,
          ids: record.ids,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.closingWindows.delete(closing);
      });
    this.closingWindows.add(closing);
  }

  /** The body of {@link finish}, kept awaitable. */
  private async settle(record: WindowRecord, result: SDKMessage): Promise<void> {
    await this.fetchUsage();
    record.channel.push(result);
    record.channel.end();
    // Only a window a dispatch opened has a pump turn behind it. A runtime
    // window can close while a dispatched one is still running, and ending the
    // pump's turn there would report the person's turn finished on the strength
    // of a `result` that had nothing to do with it.
    if (record.origin !== 'runtime') this.opts.pump.endTurn();
    this.opts.onWindowClose?.(record.window);
  }

  /**
   * Ask the live process for this window's context breakdown and subscription
   * utilization. Both are best-effort: a control channel that does not answer
   * costs the window its breakdown, never its close.
   */
  private async fetchUsage(): Promise<void> {
    const query = this.opts.pump.controlQuery;
    if (query === undefined) return;
    const timeout = this.opts.usageTimeoutMs ?? WINDOW_USAGE_TIMEOUT_MS;
    const [context, subscription] = await Promise.all([
      fetchContextBreakdown(query, timeout).catch((err: unknown) => {
        logger.debug('[SessionTurnWindows] getContextUsage failed', { err });
        return undefined;
      }),
      fetchSubscriptionUsage(query, timeout).catch((err: unknown) => {
        logger.debug('[SessionTurnWindows] get_usage failed', { err });
        return undefined;
      }),
    ]);
    if (context === undefined && subscription === undefined) return;
    this.opts.onUsage?.({
      ...(context !== undefined ? { context } : {}),
      ...(subscription !== undefined ? { subscription } : {}),
    });
  }

  /**
   * Close a window whose `result` is never coming, so the session can run
   * another turn (DOR-1294).
   *
   * Deliberately shaped like {@link onCrash}'s close rather than a normal one:
   * no accounting is fetched (the window is already over as far as the process
   * is concerned, and a control round trip would only delay the dispatch that
   * is waiting on this), the stream ends immediately behind the synthetic
   * `result`, and the pump's turn is ended — without which the dispatch this
   * unblocks would be refused one layer down and the session would stay exactly
   * as wedged.
   */
  private abandonStranded(record: WindowRecord): void {
    logger.error('[SessionTurnWindows] a turn window outlived its turn; closing it', {
      sessionId: this.opts.sessionId,
      ids: record.ids,
    });
    this.current = undefined;
    this.finalizeGrace(record);
    // And the ids go with it, exactly as {@link onCrash} drops the ledger:
    // DorkOS has DECLARED this turn over, so a `result` naming one of these
    // arriving later is no longer evidence about anything — least of all about
    // the window this abandonment is making room for, which it would otherwise
    // close through the `sentEarlier` branch.
    for (const id of record.ids) this.awaitingResult.delete(id);
    record.channel.push(strandedResult(this.opts.sessionId));
    record.channel.end();
    this.opts.pump.endTurn();
    this.opts.onWindowClose?.(record.window);
  }

  /** Remember ids that were really sent, dropping the oldest past the cap. */
  private rememberSent(ids: readonly string[]): void {
    for (const id of ids) {
      this.awaitingResult.add(id);
      if (this.awaitingResult.size <= MAX_AWAITING_IDS) continue;
      const oldest = this.awaitingResult.values().next();
      if (!oldest.done) this.awaitingResult.delete(oldest.value);
    }
  }

  /** Hold a message that belongs to no window yet, bounded. */
  private hold(message: SDKMessage): void {
    if (this.held.length >= MAX_UNATTRIBUTED_MESSAGES) {
      this.held.shift();
      logger.warn('[SessionTurnWindows] dropped a held message; no window has opened', {
        sessionId: this.opts.sessionId,
        limit: MAX_UNATTRIBUTED_MESSAGES,
      });
    }
    this.held.push(message);
  }

  /**
   * Put an abandoned window's messages back at the FRONT of the hold, ahead of
   * anything that arrived after them, so the next window reads them in the
   * order the process produced them. Bounded exactly as {@link hold} is.
   */
  private rehold(messages: SDKMessage[]): void {
    if (messages.length === 0) return;
    this.held.unshift(...messages);
    if (this.held.length <= MAX_UNATTRIBUTED_MESSAGES) return;
    this.held.splice(0, this.held.length - MAX_UNATTRIBUTED_MESSAGES);
    logger.warn('[SessionTurnWindows] dropped held messages; a dispatch was refused', {
      sessionId: this.opts.sessionId,
      limit: MAX_UNATTRIBUTED_MESSAGES,
    });
  }

  /**
   * Let go of everything on hold, because the process that said it is gone.
   * Never silent — see {@link onCrash} for why dropping is the right answer.
   */
  private discardHeld(): void {
    if (this.held.length === 0) return;
    logger.warn("[SessionTurnWindows] dropped a dead process's unattributed messages", {
      sessionId: this.opts.sessionId,
      dropped: this.held.length,
    });
    this.held.length = 0;
  }

  /** Move everything held into the window that just opened. */
  private flushHeld(record: WindowRecord): void {
    for (const message of this.held) record.channel.push(message);
    this.held.length = 0;
  }
}
