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
 * ## Three kinds of `result`, and why the third is not positional
 *
 * | The `result` carries                       | What it means                          | What happens                                                     |
 * | ------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------- |
 * | a `user_message_uuid` the open window holds | it answers this dispatch               | the window closes — one `turn_end`                                |
 * | a `user_message_uuid` nobody dispatched     | the CLI answered something we never sent | a synthetic `origin: 'runtime'` window; the open window is UNTOUCHED |
 * | no `user_message_uuid` at all               | the SDK does not carry one here        | it terminates whatever window is open, else a runtime window      |
 *
 * The third row is reality winning over the spec's phrasing, and it is
 * load-bearing: `SDKResultError` — every `error_during_execution`,
 * `error_max_turns`, `error_max_budget_usd` result — has NO `user_message_uuid`
 * field at all (`sdk.d.ts`, `SDKResultSuccess` declares it, `SDKResultError`
 * does not). Treating an unnamed result as uncorrelated would strand the open
 * window forever on every failed turn, which is precisely the bug windowing
 * exists to prevent. It is not positional guessing either: an unnamed result
 * closes the ONE open window whole, ids and all, which is the same answer
 * coalescing gives — no ordinal is ever counted.
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
import { fetchContextBreakdown } from '../sdk/context-usage.js';
import { fetchSubscriptionUsage } from '../sdk/subscription-usage.js';
import {
  IllegalPumpTransitionError,
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
   * A window opened. **Task 3.7 arms the stall watchdog here** — per window, not
   * per process, because a WARM session sitting legitimately silent for ten
   * minutes must not be interrupted for it.
   */
  onWindowOpen?: (window: TurnWindow) => void;
  /**
   * A window closed and its stream has ended. **Task 3.7 disarms the stall
   * watchdog here**, and task 3.4 arms the process-idle timer.
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
}

/** Build a window record and the public handle onto it. */
function createRecord(ids: string[], origin: TurnOrigin): WindowRecord {
  const channel = new WindowChannel();
  return { ids, origin, channel, window: { ids, origin, messages: channel.drain() } };
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
   * Build a windower over one pump.
   *
   * @param opts - The pump, the window observers, and the accounting seam
   */
  constructor(opts: SessionTurnWindowsOptions) {
    this.opts = opts;
  }

  /** The window that is open right now, if any — what task 3.7's watchdog guards. */
  get openWindow(): TurnWindow | undefined {
    return this.current?.window;
  }

  /**
   * Open a window for one dequeued batch and dispatch it.
   *
   * **This is the single ingress for a pump-driven turn**, which is what makes
   * the pump's honor-system dispatch mutex enforceable: a caller cannot open a
   * second window while one is open, and a dispatch that arrives while the
   * previous window is still settling its accounting waits for it rather than
   * racing it. **Task 3.9 validates the turn's boundary here**, on the batch,
   * before anything is sent.
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
   * @param batch - The messages dequeued together, to run as one turn
   * @returns The window this dispatch opened
   * @throws PumpRefusedError When the batch is empty, or the pump refuses it
   * @throws IllegalPumpTransitionError When a window is already open
   */
  async dispatch(batch: readonly PumpDispatch[]): Promise<TurnWindow> {
    if (batch.length === 0) {
      throw new PumpRefusedError(
        'empty-dispatch',
        `session ${this.opts.sessionId} was dispatched an empty batch; there is no turn to open`
      );
    }
    // A window is not over until its accounting has been fetched, its `result`
    // released, and the pump's turn ended; dispatching into that gap would
    // attribute the tail of one turn to the next, or be refused by a pump still
    // RUNNING the turn nobody told it had finished.
    //
    // EVERY close in flight, and looped rather than awaited once: a stray
    // `result` can open and close a runtime window while we wait here, and that
    // close has to be waited for too.
    while (this.closingWindows.size > 0) {
      await Promise.all([...this.closingWindows]);
    }
    if (this.current !== undefined) {
      throw new IllegalPumpTransitionError('running', 'running');
    }
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
   * **Task 3.6 also owns the held buffer across a relaunch.** A crash with NO
   * window open leaves whatever the dying process said still on hold, and the
   * next window — belonging to a DIFFERENT process — is where it currently
   * flushes. That is bounded and never silent, but attributing a dead process's
   * words to a live process's turn is a call about relaunch semantics, not about
   * windowing, so 3.6 decides it: carry them, or retire them into a closing
   * runtime window of their own.
   *
   * @param crash - What the pump observed
   */
  onCrash(crash: PumpCrash): void {
    const record = this.current;
    if (record === undefined) return;
    this.current = undefined;
    record.channel.push(crashResult(crash));
    record.channel.end();
    this.opts.onWindowClose?.(record.window);
  }

  /** Route a `result` by the id it answers. See the module doc's table. */
  private onResult(result: SDKMessage): void {
    const answered = readAnsweredId(result);
    const record = this.current;
    if (record !== undefined && (answered === undefined || record.ids.includes(answered))) {
      this.current = undefined;
      this.finish(record, result);
      return;
    }
    if (record !== undefined) {
      logger.debug('[SessionTurnWindows] a result answered a message this session never sent', {
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

  /** Move everything held into the window that just opened. */
  private flushHeld(record: WindowRecord): void {
    for (const message of this.held) record.channel.push(message);
    this.held.length = 0;
  }
}
