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
import { logger } from '../../../../lib/logger.js';
import {
  DRAIN_GRACE_MS,
  HOLDS_PROCESS,
  INIT_TIMEOUT_MS,
  IllegalPumpTransitionError,
  LEGAL_TRANSITIONS,
  PumpRefusedError,
  WARMTH_OF,
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
  private disposed = false;

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
   */
  async warm(): Promise<void> {
    this.assertUsable();
    if (this.currentState === 'warm' || this.currentState === 'running') return;
    await this.launch();
  }

  /**
   * Open a turn with `input`: `WARM → RUNNING`, booting the process first when
   * there is none.
   *
   * **Resolving is an ACCEPTANCE, not a receipt** — see the module doc. The
   * caller keeps the durable queue row until correlated output evidence says
   * the turn began, and puts it back in line if this rejects.
   *
   * The caller holds the dispatch mutex; this refuses to be re-entered rather
   * than serializing on its own, because a second dispatch arriving mid-turn is
   * a caller bug today (steering into an open turn is task P4's
   * `deliverIntoTurn`, a different verb).
   *
   * @param input - The message to run
   * @throws PumpRefusedError When the session is parked on a person, when the
   *   warm ceiling has no slot, or when the input stream has ended
   * @throws IllegalPumpTransitionError When a turn is already open
   */
  async dispatch(input: PumpDispatch): Promise<void> {
    this.assertUsable();
    if (this.currentState === 'running') {
      throw new IllegalPumpTransitionError('running', 'running');
    }
    if (this.opts.hasPendingInteraction?.()) {
      throw new PumpRefusedError(
        'pending-interaction',
        `session ${this.sessionId} is waiting on a person; dispatching now would answer nobody`
      );
    }
    if (this.currentState === 'cold' || this.currentState === 'crashed') {
      // The first message rides the launch rather than being pushed after it:
      // it is in the stream from construction, so there is no window in which
      // the process is up and the message is merely "accepted".
      await this.launch(input.content);
      this.setState('running');
      return;
    }
    // A launch somebody else started (an explicit `warm()`) has to finish
    // before this can push into its stream.
    if (this.launchInFlight) await this.launchInFlight;
    if (this.currentState !== 'warm') {
      throw new IllegalPumpTransitionError(this.currentState, 'running');
    }
    if (this.held?.push(input.content) !== true) {
      // `false` is the one answer the seam gives that is definite: the stream
      // is finished and nothing was sent. Report the process gone so the caller
      // leaves the message queued for the relaunch.
      this.noteProcessGone(undefined);
      throw new PumpRefusedError(
        'process-gone',
        `session ${this.sessionId} lost its process before the message was sent`
      );
    }
    this.setState('running');
  }

  /**
   * Close the open turn window: `RUNNING → WARM`. The process stays up.
   *
   * Task 3.3 calls this from the demux when the `result` correlated to the open
   * window arrives. Idempotent, and a no-op when no window is open — a second
   * `result` must be harmless, exactly as task 0.1's `closeTurn` guard makes it.
   */
  endTurn(): void {
    if (this.currentState !== 'running') return;
    this.setState('warm');
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
   *   (not warm, or parked on a person)
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
  private launch(firstMessage?: string): Promise<void> {
    this.launchInFlight ??= this.launchOnce(firstMessage).finally(() => {
      this.launchInFlight = undefined;
    });
    return this.launchInFlight;
  }

  /** Claim a slot, boot the process, and wait for it to say it is ready. */
  private async launchOnce(firstMessage?: string): Promise<void> {
    await this.opts.reserveSlot?.();
    // A teardown can land while the slot is being claimed, and a launch that
    // carried on from here would boot a process nothing is left to close.
    this.assertUsable();
    if (this.currentState === 'crashed') this.setState('resuming');
    const resuming = this.currentState === 'resuming';
    this.setState('warming');
    this.cachedCapabilities = [];
    const held =
      firstMessage === undefined ? createIdlePrompt() : createHeldUserPrompt(firstMessage);
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
