/**
 * The long-lived owner of one claude-code session's SDK process (spec
 * `persistent-session-runtime` §4, task 3.2).
 *
 * Today a turn IS a process: `executeSdkQuery` calls `query()`, consumes it to
 * the `result`, and closes it, so every turn pays a cold boot and a cold prompt
 * cache. The pump makes the process outlive the turn: one `query()` per
 * SESSION, fed through the held input stream from
 * {@link createHeldUserPrompt}, with turns cut out of its continuous output.
 *
 * ## What this module is, and what it is not
 *
 * The state machine and the process lifecycle, and nothing else. It is
 * deliberately NOT wired into the turn path: claude-code still runs
 * resume-per-message, byte for byte, until the opt-in lands (task 3.8). It does
 * not assemble SDK options either — those are resolved per turn inside
 * `executeSdkQuery` today and become a launch fingerprint in task 3.5, so the
 * pump asks a {@link PumpLauncher} for a live query rather than calling
 * `query()` itself. The seams the rest of P3 plugs into are named on
 * {@link SessionPumpOptions} and on {@link SessionPump.endTurn}.
 *
 * ## Acceptance is not delivery
 *
 * {@link SessionPump.dispatch} resolving means the message was ACCEPTED by the
 * input stream, never that the agent received it. The seam is amnesiac by
 * design: the SDK reads a message off the stream before testing its abort flag,
 * so an aborted turn can drop a message that `push()` accepted, and a consumer
 * that abandons the iteration in the same tick clears the queue. The durable
 * queue is the reconciliation — a row retires on correlated OUTPUT evidence
 * (the `turn_start` the projector ingests, task 3.3), never on this method
 * resolving. A `false` from `push()` is the one direction that IS definite:
 * the stream is finished, nothing was sent, and this reports it as a refusal so
 * the caller leaves the row queued.
 *
 * @module services/runtimes/claude-code/sessions/session-pump
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionWarmth } from '@dorkos/shared/agent-runtime';
import { createHeldUserPrompt, createIdlePrompt, type HeldUserPrompt } from '../sdk/sdk-utils.js';
import { createTurnLiveness, type TurnLiveness } from '../messaging/turn-liveness.js';
import { logger } from '../../../../lib/logger.js';
import {
  DRAIN_GRACE_MS,
  HOLDS_PROCESS,
  INIT_TIMEOUT_MS,
  IllegalPumpTransitionError,
  LEGAL_TRANSITIONS,
  PumpRefusedError,
  WARMTH_OF,
  type PumpControlQuery,
  type PumpDispatch,
  type PumpQuery,
  type PumpState,
  type SessionPumpOptions,
} from './session-pump-contract.js';

// Re-exported so one import site serves both the machine and its vocabulary.
export * from './session-pump-contract.js';

/** A promise plus the handles to settle it from elsewhere. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Build a {@link Deferred}. The no-op catch is load-bearing: this is awaited by
 * at most one caller (the launch) and rejected by paths that may run with
 * nobody awaiting — a crash on a session that was explicitly warmed — which
 * would otherwise surface as an unhandled rejection.
 */
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Is this SDK message the `system/init` that says the process is ready? */
function isInit(
  message: SDKMessage
): message is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
  return message.type === 'system' && message.subtype === 'init';
}

/**
 * One session's SDK process, and the state machine that owns its life.
 *
 * Drive it with {@link warm} (boot without running a turn), {@link dispatch}
 * (open a turn), {@link endTurn} (close it), {@link reap} (give the process
 * back) and {@link teardown} (unconditional, for eviction and shutdown). Every
 * other transition is something the process itself caused.
 */
export class SessionPump {
  private readonly opts: SessionPumpOptions;
  private currentState: PumpState = 'cold';
  private query: PumpQuery | undefined;
  private held: HeldUserPrompt | undefined;
  private consumed: Promise<void> | undefined;
  private launchInFlight: Promise<void> | undefined;
  private initReady: Deferred | undefined;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private cachedCapabilities: readonly string[] = [];
  /**
   * What this process's background subagents are doing, per the SDK's
   * `background_tasks_changed` level signal (DOR-1238).
   *
   * The pump's reason for caring is {@link reap}: closing stdin under a live
   * subagent EOFs the CLI's control stream, which cancels every hook-matched
   * tool the agent runs afterwards. Replaced on every launch, because the level
   * signal is per-process and is not replayed at startup.
   */
  private liveness: TurnLiveness = createTurnLiveness();
  private disposed = false;
  /**
   * A `result` closed this turn's window before {@link dispatch} reached
   * RUNNING. Set by {@link endTurn} — which is a no-op against a pump that is
   * not yet RUNNING — and consumed by {@link openTurn}, which then settles the
   * turn to WARM instead of stranding it in RUNNING with no window left to close
   * it (DOR-1187). Reset at the top of every dispatch, so it can only ever
   * describe the turn currently opening.
   */
  private turnClosedWhileOpening = false;

  /**
   * Build a pump for one session. Nothing is booted until it is warmed or
   * dispatched to.
   *
   * @param opts - The session, its launcher, and the seams the rest of P3 uses
   */
  constructor(opts: SessionPumpOptions) {
    this.opts = opts;
  }

  /** The session this pump belongs to. */
  get sessionId(): string {
    return this.opts.sessionId;
  }

  /** Where the machine is right now, including the two internal states. */
  get state(): PumpState {
    return this.currentState;
  }

  /** What `getSessionWarmth` reports for this session. */
  get warmth(): SessionWarmth {
    return WARMTH_OF[this.currentState];
  }

  /** True while a subprocess exists or is being booted — what the ceiling counts. */
  get holdsProcess(): boolean {
    return HOLDS_PROCESS.includes(this.currentState);
  }

  /**
   * The live process's control channel, or `undefined` when there is no process.
   *
   * This is what makes WARM worth having: between turns the subprocess is still
   * there and still answers, so the windower can fetch a window's context and
   * subscription accounting at every close instead of only at the one close
   * that used to end the process. Never cache it across a relaunch — a crash
   * replaces the query, and the old one answers nothing.
   */
  get controlQuery(): PumpControlQuery | undefined {
    return this.query;
  }

  /**
   * Protocol capabilities the CLI reported at `system/init`, cached for this
   * process's life. Empty until init arrives, and empty on a CLI old enough not
   * to report any — which is the point: feature-detect what you are about to
   * use, never version-sniff, so an older CLI degrades honestly.
   */
  get capabilities(): readonly string[] {
    return this.cachedCapabilities;
  }

  /**
   * Does this process advertise `capability`? Always false before init, because
   * an unanswered question is not a yes.
   *
   * @param capability - A `system/init` capability name, e.g. `interrupt_receipt_v1`
   */
  supports(capability: string): boolean {
    return this.cachedCapabilities.includes(capability);
  }

  /**
   * Boot the process without running a turn: `COLD → WARMING → WARM`, or
   * `CRASHED → RESUMING → WARMING → WARM`. Resolves once `system/init` has
   * arrived; rejects if the process dies or never initializes.
   *
   * Concurrent calls share one launch, so two callers cannot boot two processes
   * for one session. Already warm (or running) is a no-op.
   *
   * Like {@link dispatch}, this asks nothing about the directory boundary: it
   * boots a process in whatever cwd the launcher resolves, and no turn runs
   * until something dispatches. Pre-warming a session whose cwd the boundary
   * would refuse therefore starts a subprocess that can never be given work —
   * so whoever adds pre-warming should ask the gate first rather than leave the
   * refusal to the first dispatch.
   */
  async warm(): Promise<void> {
    this.assertUsable();
    if (this.currentState === 'warm' || this.currentState === 'running') return;
    await this.launch();
  }

  /**
   * Open a turn with `batch`: `WARM → RUNNING`, booting the process first when
   * there is none.
   *
   * **A batch, not a message, because a batch is what one turn is.** The CLI
   * dequeues whatever is waiting on its input stream and coalesces it into ONE
   * assistant turn answered by ONE `result` — so the messages the durable queue
   * dequeues together are one dispatch, one window, and several correlation
   * ids. Each message is stamped with its own `messageId` as the SDK `uuid`, so
   * the single `result` can still be matched back by id.
   *
   * **Resolving is an ACCEPTANCE, not a receipt** — see the module doc. The
   * caller keeps the durable queue rows until correlated output evidence says
   * the turn began, and puts them back in line if this rejects.
   *
   * The caller holds the dispatch mutex; this refuses to be re-entered rather
   * than serializing on its own, because a second dispatch arriving mid-turn is
   * a caller bug: opening a turn is not how you reach one already open. Joining
   * the running turn is {@link steer}, this pump's half of `deliverIntoTurn`,
   * and it deliberately leaves the state machine alone. The windower is what
   * makes that mutex more than honor-system for pump-driven turns.
   *
   * **This method asks nothing about the directory boundary, and that is not an
   * oversight — it is why `SessionTurnWindows.dispatch` is the only supported
   * way in.** The boundary gate (task 3.9) lives one layer up, on the windower,
   * because that is the layer that knows which cwd this turn was resolved for;
   * a pump takes a batch and no directory at all. Reaching past the windower to
   * call this directly runs the turn ungated, so production code must not: go
   * through `SessionTurnWindows.dispatch(batch, cwd)`, or through
   * `SessionCrashRecovery.dispatch(batch, cwd)`, which delegates to it. Tests
   * that drive the pump alone are the deliberate exception.
   *
   * @param batch - The messages to run as one turn, in delivery order
   * @throws PumpRefusedError When the batch is empty, when the session is parked
   *   on a person, when the warm ceiling has no slot, or when the input stream
   *   has ended
   * @throws IllegalPumpTransitionError When a turn is already open
   */
  async dispatch(batch: readonly PumpDispatch[]): Promise<void> {
    this.assertUsable();
    const [first, ...rest] = batch;
    if (first === undefined) {
      // Moving to RUNNING with nothing sent would open a window no `result`
      // could ever close, which is the failure this whole layer exists to stop.
      throw new PumpRefusedError(
        'empty-dispatch',
        `session ${this.sessionId} was dispatched an empty batch; there is no turn to open`
      );
    }
    if (this.currentState === 'running') {
      throw new IllegalPumpTransitionError('running', 'running');
    }
    if (this.opts.hasPendingInteraction?.()) {
      throw new PumpRefusedError(
        'pending-interaction',
        `session ${this.sessionId} is waiting on a person; dispatching now would answer nobody`
      );
    }
    // Fresh for the turn about to open: a tombstone left by a previous close
    // must not settle this one.
    this.turnClosedWhileOpening = false;
    if (this.currentState === 'cold' || this.currentState === 'crashed') {
      // The first message rides the launch rather than being pushed after it:
      // it is in the stream from construction, so there is no window in which
      // the process is up and the message is merely "accepted".
      await this.launch(first);
      this.pushRest(rest);
      this.openTurn();
      return;
    }
    // A launch somebody else started (an explicit `warm()`) has to finish
    // before this can push into its stream.
    if (this.launchInFlight) await this.launchInFlight;
    if (this.currentState !== 'warm') {
      throw new IllegalPumpTransitionError(this.currentState, 'running');
    }
    this.pushOrFail(first);
    this.pushRest(rest);
    this.openTurn();
  }

  /**
   * Flip to RUNNING, then honor a `result` that closed this turn before we got
   * here.
   *
   * On the cold and crashed paths the pump awaits its launch before opening the
   * turn, and a fast turn's `result` can be answered — and its window closed via
   * {@link endTurn} — during that await, while the pump is still WARM. `endTurn`
   * is a no-op against a pump that is not yet RUNNING, so without this the pump
   * would move to RUNNING here with no window left to close it and strand there;
   * the next dispatch would then throw an illegal transition. `fetchUsage`'s IPC
   * round trip is what USUALLY orders that close safely behind this flip, but a
   * safety that rides on microtask timing is not one — so the settle is made
   * explicit here instead (DOR-1187).
   */
  private openTurn(): void {
    this.setState('running');
    if (this.turnClosedWhileOpening) {
      this.turnClosedWhileOpening = false;
      this.setState('warm');
    }
  }

  /**
   * Push the rest of a batch behind its opening message. Ordering is what makes
   * these one turn: the CLI reads them off the stream together and answers all
   * of them with one `result`.
   */
  private pushRest(rest: readonly PumpDispatch[]): void {
    for (const message of rest) this.pushOrFail(message);
  }

  /** Push one message into the held stream, or report the process gone. */
  private pushOrFail(message: PumpDispatch): void {
    if (this.held?.push(message.content, message.messageId) === true) return;
    // `false` is the one answer the seam gives that is definite: the stream
    // is finished and nothing was sent. Report the process gone so the caller
    // leaves the message queued for the relaunch.
    this.noteProcessGone(undefined);
    throw new PumpRefusedError(
      'process-gone',
      `session ${this.sessionId} lost its process before the message was sent`
    );
  }

  /**
   * Push a message into the turn that is ALREADY open, without opening one of
   * its own — the steer half of P4's `deliverIntoTurn` (spec §2.3).
   *
   * Unlike {@link dispatch}, this does not touch the state machine: a steer
   * joins the running turn rather than starting a new one, so the pump stays
   * `RUNNING` and the message rides the same held stream the opening message
   * did, delivered by the CLI within the live turn. The windower correlates the
   * turn's single `result` back by adding this message's id to the open window,
   * which is the caller's job — this method only reaches the input stream.
   *
   * Amnesiac exactly as {@link dispatch} is: a `'delivered'` means the stream
   * accepted the message, never that the agent received it (see the module
   * doc). The durable queue is not involved — a steer is not a queued row — so
   * there is nothing to reconcile against; the receipt is the whole of it.
   *
   * @param content - The message text, already enriched with any context bag
   * @param messageId - The server-minted correlation id, stamped as the SDK
   *   message's `uuid` so the turn's `result` can be matched back to it
   * @returns `'no-open-turn'` when no turn is running to join, `'stream-closed'`
   *   when the process's input stream has already ended, and `'delivered'`
   *   when the message was accepted onto it
   */
  steer(content: string, messageId: string): 'delivered' | 'no-open-turn' | 'stream-closed' {
    this.assertUsable();
    if (this.currentState !== 'running') return 'no-open-turn';
    // `held` is set for the life of a launched process and cleared the instant
    // it goes away (`noteProcessGone`, `drain`), so its absence — or a `false`
    // from `push`, the one definite answer the seam gives — is the stream being
    // gone out from under a turn that has not yet been told.
    if (this.held?.push(content, messageId) === true) return 'delivered';
    return 'stream-closed';
  }

  /**
   * Stage a message onto the held stream WITHOUT opening a turn — the claude-code
   * half of P4's `deliverIntoTurn(mode: 'stage')` (spec §2.5, task 4.2).
   *
   * Unlike {@link steer}, this does not require an open turn: it rides
   * `shouldQuery: false`, which the SDK appends to the transcript and runs no
   * assistant turn for, merging it into the next user message that does query
   * (`sdk.d.ts:4764`). So it is legal whenever there is a live process to append
   * to — WARM (idle) or RUNNING alike — and it leaves the state machine untouched
   * either way: no window opens, and no `result` is expected, because a staged
   * message provokes none.
   *
   * A COLD session has no held stream to append to; warming one is the caller's
   * job ({@link PersistentDispatch.stage} boots the process first), so this
   * reports `no-process` rather than warming implicitly — a pump takes a message,
   * never a launch plan.
   *
   * Amnesiac exactly as {@link steer} is: a `'delivered'` means the stream
   * accepted the message, never that the model received it.
   *
   * @param content - The message text, already enriched with any context bag
   * @param messageId - The server-minted correlation id, stamped as the SDK
   *   message's `uuid`
   * @returns `'no-process'` when the session is cold with no stream to append to,
   *   `'stream-closed'` when the process's input stream has already ended, and
   *   `'delivered'` when the staged message was accepted onto it
   */
  stage(content: string, messageId: string): 'delivered' | 'no-process' | 'stream-closed' {
    this.assertUsable();
    // WARM or RUNNING both hold a live stream; COLD, CRASHED and WARMING-before-
    // ready hold none. The held stream's own `false` covers the amnesiac race
    // where the process went away after this check.
    if (this.currentState !== 'warm' && this.currentState !== 'running') return 'no-process';
    if (this.held?.stage(content, messageId) === true) return 'delivered';
    return 'stream-closed';
  }

  /**
   * Close the open turn window: `RUNNING → WARM`. The process stays up.
   *
   * The windower (`session-turn-windows.ts`) calls this once the `result`
   * correlated to the open window has been released, not the instant it
   * arrives: a window is not over until its accounting has been fetched from
   * the still-live process. Idempotent, and a no-op when no window is open — a
   * second `result` must be harmless, exactly as task 0.1's `closeTurn` guard
   * makes it.
   */
  endTurn(): void {
    if (this.currentState === 'running') {
      this.setState('warm');
      return;
    }
    // A close that raced its own dispatch: on the cold and crashed paths a fast
    // turn's `result` can arrive while the launch is still awaited and the pump
    // is only WARM. Settling to WARM here would be wrong (there is nothing to
    // settle yet), so the close is tombstoned for `openTurn` to honor the
    // instant the turn opens — the robust half of DOR-1187. Bounded to the turn
    // being opened: `turnClosedWhileOpening` is reset at the top of every
    // dispatch, so a stray `result` against a settled pump stays a no-op.
    this.turnClosedWhileOpening = true;
  }

  /**
   * Give the process back, politely: `WARM → REAPED`.
   *
   * Invisible to the person — the session record and its transcript are
   * untouched, and the next message resumes. Refuses rather than throwing,
   * because the callers are timers and sweeps: a reap that cannot happen right
   * now is a normal outcome. Reap through the registry, which drops the spent
   * pump; a pump reaped directly is left in `reaped`, which is terminal.
   *
   * @returns True when the process was closed, false when the pump declined
   *   (not warm, parked on a person, or still running background subagents)
   */
  async reap(): Promise<boolean> {
    if (this.currentState === 'cold' || this.currentState === 'reaped') return false;
    if (this.currentState === 'crashed') {
      // Nothing left to close; retiring the record is the whole of it.
      this.setState('reaped');
      return true;
    }
    if (this.currentState !== 'warm') {
      logger.debug('[SessionPump] declined to reap a session that is not warm', {
        sessionId: this.sessionId,
        state: this.currentState,
      });
      return false;
    }
    if (this.opts.hasPendingInteraction?.()) {
      logger.warn('[SessionPump] declined to reap a session parked on a person', {
        sessionId: this.sessionId,
      });
      return false;
    }
    // A turn ends at its `result`, but a background subagent the turn launched
    // outlives it. Reaping now closes stdin under that subagent, and the CLI
    // answers an EOF'd control stream by cancelling every hook-matched tool it
    // then tries to run — the agent's work is thrown away and it is told the
    // person refused (DOR-1238). The registry asks again a window later.
    const liveAgents = this.liveness.liveAgentCount();
    if (liveAgents > 0) {
      logger.warn('[SessionPump] declined to reap a session running background agents', {
        sessionId: this.sessionId,
        liveAgents,
      });
      return false;
    }
    // Before the close, so the stream ending is read as "we asked for this"
    // rather than as a crash.
    this.setState('reaped');
    await this.drain();
    return true;
  }

  /**
   * End this pump for good: `any → COLD`, no guards.
   *
   * The unconditional counterpart to {@link reap}, for the two callers that
   * cannot take no for an answer — session eviction, and server shutdown.
   * Idempotent, and safe while a launch is in flight: the launch sees the
   * teardown when it returns and closes whatever it got, so a process cannot
   * outlive the shutdown that raced it.
   */
  async teardown(): Promise<void> {
    if (this.disposed) {
      await this.consumed?.catch(() => {});
      return;
    }
    this.disposed = true;
    if (this.currentState !== 'cold') this.setState('cold');
    this.initReady?.reject(
      new PumpRefusedError('process-gone', `session ${this.sessionId} was torn down`)
    );
    await this.drain();
  }

  /** Refuse anything asked of a pump that has been torn down or spent. */
  private assertUsable(): void {
    if (this.disposed) {
      throw new PumpRefusedError('process-gone', `session ${this.sessionId}'s pump is torn down`);
    }
    if (this.currentState === 'reaped') throw new IllegalPumpTransitionError('reaped', 'warming');
  }

  /**
   * Move the machine, refusing any edge {@link LEGAL_TRANSITIONS} does not have
   * — so an impossible state is caught where it is caused rather than three
   * seams downstream.
   */
  private setState(to: PumpState): void {
    const from = this.currentState;
    if (from === to) return;
    if (!LEGAL_TRANSITIONS[from].includes(to)) throw new IllegalPumpTransitionError(from, to);
    this.currentState = to;
    try {
      this.opts.onStateChange?.({ from, to });
    } catch (err) {
      logger.warn('[SessionPump] a state-change observer threw', {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * One launch at a time, whoever asks. The memo is assigned synchronously, so
   * a second caller in the same tick joins the first launch rather than booting
   * a second process.
   */
  private launch(firstMessage?: PumpDispatch): Promise<void> {
    this.launchInFlight ??= this.launchOnce(firstMessage).finally(() => {
      this.launchInFlight = undefined;
    });
    return this.launchInFlight;
  }

  /** Claim a slot, boot the process, and wait for it to say it is ready. */
  private async launchOnce(firstMessage?: PumpDispatch): Promise<void> {
    await this.opts.reserveSlot?.();
    // A teardown can land while the slot is being claimed, and a launch that
    // carried on from here would boot a process nothing is left to close.
    this.assertUsable();
    if (this.currentState === 'crashed') this.setState('resuming');
    const resuming = this.currentState === 'resuming';
    this.setState('warming');
    this.cachedCapabilities = [];
    // A fresh process has no background work, and the level signal is not
    // replayed at startup — so the old set must not carry over (DOR-1238).
    this.liveness = createTurnLiveness();
    const held =
      firstMessage === undefined
        ? createIdlePrompt()
        : createHeldUserPrompt(firstMessage.content, firstMessage.messageId);
    this.held = held;
    const ready = deferred();
    this.initReady = ready;
    this.initTimer = setTimeout(() => {
      this.noteProcessGone(
        new Error(
          `session ${this.sessionId} never reported system/init within ${this.initTimeout}ms`
        )
      );
    }, this.initTimeout);
    this.initTimer.unref?.();
    let live: PumpQuery;
    try {
      live = await this.opts.launch({ sessionId: this.sessionId, prompt: held.prompt, resuming });
    } catch (err) {
      held.close();
      this.held = undefined;
      this.noteProcessGone(err);
      throw err;
    }
    if (this.disposed) {
      // A teardown landed while the launcher was booting. Close what it handed
      // back rather than letting it become the orphan shutdown was meant to
      // prevent — stdin alone would not do it.
      held.close();
      live.close();
      throw new PumpRefusedError(
        'process-gone',
        `session ${this.sessionId} was torn down while launching`
      );
    }
    this.query = live;
    this.consumed = this.consume(live);
    await ready.promise;
  }

  /** The configured init bound, or the module default. */
  private get initTimeout(): number {
    return this.opts.initTimeoutMs ?? INIT_TIMEOUT_MS;
  }

  /**
   * Read the process's whole output for its life: cache what `system/init`
   * reports, hand every message to the demux, and treat the stream ending as
   * the process ending.
   */
  private async consume(live: PumpQuery): Promise<void> {
    try {
      for await (const message of live) {
        if (isInit(message)) this.noteInit(message.capabilities ?? []);
        try {
          // Before the demux, so a reap racing this message decides on the
          // newest membership rather than the one before it (DOR-1238). Inside
          // the guard with the demux, because ANY throw from this loop body
          // leaves the `for await` and is reported as the process dying — a
          // malformed frame must not be able to fake a crash.
          this.liveness.observe(message);
          this.opts.onMessage?.(message);
        } catch (err) {
          logger.warn('[SessionPump] a message observer threw; the process is unaffected', {
            sessionId: this.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.noteProcessGone(undefined);
    } catch (err) {
      this.noteProcessGone(err);
    }
  }

  /** `WARMING → WARM`: the CLI is up and its control methods are usable. */
  private noteInit(capabilities: readonly string[]): void {
    this.cachedCapabilities = [...capabilities];
    this.clearInitTimer();
    // A re-initialize on a live process refreshes the capabilities and nothing
    // else: there is no turn to open and no state to leave.
    if (this.currentState === 'warming') this.setState('warm');
    this.initReady?.resolve();
  }

  /**
   * The process is no longer there. A death we asked for (`reaped`, `cold`) is
   * silence; any other is a crash, reported once to task 3.6's seam.
   */
  private noteProcessGone(error: unknown): void {
    this.clearInitTimer();
    this.query = undefined;
    this.held = undefined;
    if (this.currentState === 'reaped' || this.currentState === 'cold') return;
    if (this.currentState === 'crashed') return;
    const stateAtCrash = this.currentState;
    this.setState('crashed');
    this.initReady?.reject(
      error ??
        new PumpRefusedError(
          'process-gone',
          `session ${this.sessionId}'s process ended before it was ready`
        )
    );
    try {
      this.opts.onCrash?.({
        sessionId: this.sessionId,
        stateAtCrash,
        ...(error !== undefined ? { error } : {}),
      });
    } catch (err) {
      logger.warn('[SessionPump] a crash observer threw', {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private clearInitTimer(): void {
    if (this.initTimer) clearTimeout(this.initTimer);
    this.initTimer = undefined;
  }

  /**
   * Close the process: stdin first so it drains what it accepted, then the
   * query itself once the drain has had its grace window.
   *
   * Both halves are load-bearing. Skipping the close would drop messages the
   * person was told had been accepted; skipping the query close would leave the
   * CLI child running, because closing stdin alone does not terminate it.
   */
  private async drain(): Promise<void> {
    const held = this.held;
    const live = this.query;
    const consumed = this.consumed;
    this.held = undefined;
    this.query = undefined;
    this.clearInitTimer();
    held?.close();
    if (!live) return;
    const grace = this.opts.drainGraceMs ?? DRAIN_GRACE_MS;
    if (consumed) await settleWithin(consumed, grace);
    live.close();
    // Bounded again rather than awaited outright: a child wedged badly enough
    // to ignore the forceful close must not take the shutdown down with it.
    if (consumed) await settleWithin(consumed, grace);
  }
}

/**
 * Wait for `work` to settle, giving up after `ms`. Never rejects: the caller is
 * tearing something down and a failure in the thing being torn down is not news.
 */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  await Promise.race([work.catch(() => {}), expiry]);
  if (timer) clearTimeout(timer);
}
