/**
 * The outbox's worker (spec `turns-survive-restarts` §6.1, DOR-5160): one per
 * process, carrying out the follow-up work a run's state change saved.
 *
 * **One pass** ends the live runs a dead boot left (as T2's launch check does
 * for one chat, so a run whose `turn_end` was seen before the kill ends with
 * that ending and its follow-ups are written), takes back the leases a dead
 * boot let lapse, expires what is past its `not_after`, settles the runs whose
 * last effect is terminal (transition 13), then takes due effects one at a
 * time and runs each one's handler until none is due. It wakes on any insert
 * (an in-process signal), when the next open effect falls due (no sooner
 * than a second, no later than 30), and once more when every lease of the
 * boot before has run out; with nothing open it sleeps until the next insert. What follows a dead run beyond its
 * ending (a continuation, a person's line) stays recovery's to decide (T15).
 *
 * **Leases.** Taking an effect is one conditional update, so two workers never
 * both run it. A lease lasts 60 seconds and is renewed every 20 while the
 * handler works. A lease another boot let run out is taken back:
 * `repeatable` to `pending`, `once` to `unknown` (§6.2, rule 1). This boot's
 * own leases are never taken back by itself.
 *
 * **Answers.** A handler answers `done`, `wait(retryAt)`, `drop(reason)` or
 * `await`. `await` keeps the effect leased, renewed by this boot's heartbeat
 * (every 20 seconds, every lease it holds), until a fact ends it in its own
 * transaction: only `start_turn` uses it, waiting for its run's `started`,
 * `superseded` or `cancelled` (§6.2). A throw on a `repeatable` effect retries after 1 s, 5 s, 30 s, 2 min,
 * then every 10 min, and is `dropped` after its eighth attempt; a throw on a
 * `once` effect is `unknown`. A handler whose work is a write to `dork.db`
 * does that write and calls {@link EffectContext.markDone} inside the same
 * transaction (§6.4), which is what makes that write happen exactly once.
 *
 * **One effect at a time.** A pass awaits each handler before it takes the
 * next, bounded by {@link EFFECT_HANDLER_TIMEOUT_MS}, so a handler that never
 * settles cannot stall the outbox. Past the bound, a handler that declares
 * `onTimeout: 'await'` (`start_turn`, whose hand-over can wait on a runtime's
 * own launch) keeps its lease and finishes on its own; any other is treated
 * as a throw.
 *
 * **Deadlines.** A pending effect past its `not_after` is `expired`, and its
 * kind's `onExpired` runs in the same transaction (a `start_turn` cancels its
 * run). An effect this boot holds past its deadline is offered to its kind's
 * `expireHeld` (a `start_turn` waiting in the dispatcher is withdrawn there,
 * unless its launch is under way).
 *
 * **Shutdown** stops the wake-ups and nothing else: an effect still pending
 * stays pending, and one whose handler was cut short is taken back by the
 * next boot when its lease lapses.
 *
 * @module services/runs/effects/worker
 */
import { logger } from '../../../lib/logger.js';
import { isUndecided, RUN_LEASE_MS, type RunStore } from '../run-store.js';
import type {
  EffectKind,
  EffectLease,
  EffectStore,
  TerminalEffectState,
  TurnEffect,
} from './effect-store.js';

/** How long a lease lasts after each renewal (§6.1). */
export const EFFECT_LEASE_MS = 60_000;

/** How often a held lease is renewed while its handler works (§6.1). */
export const EFFECT_LEASE_RENEW_MS = 20_000;

/**
 * The shortest wait between passes while something is open but not yet
 * taken (§6.1): an effect behind an earlier one of its run, or held by a
 * live boot, is looked at again no sooner than this.
 */
export const EFFECT_TICK_MS = 1_000;

/** The longest wait between passes while anything is open. */
export const EFFECT_MAX_IDLE_MS = 30_000;

/** The waits between a `repeatable` effect's failed attempts; the last repeats. */
export const EFFECT_RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;

/** A `repeatable` effect is dropped after this many failed attempts. */
export const EFFECT_MAX_ATTEMPTS = 8;

/**
 * How many of an effect's attempts threw, as its last outcome counted. Kept
 * apart from `attempts`, which counts every lease: a `start_turn` that waited
 * for a busy chat leased and let go without failing.
 *
 * @param effect - The effect.
 */
export function failuresOf(effect: Pick<TurnEffect, 'outcome'>): number {
  const outcome = effect.outcome as { failures?: unknown } | null | undefined;
  return typeof outcome?.failures === 'number' ? outcome.failures : 0;
}

/** The longest a pass waits on one handler before it takes the next (see the module doc). */
export const EFFECT_HANDLER_TIMEOUT_MS = 30_000;

/** How many `ended` runs one pass reads to settle. */
const SETTLE_BATCH = 100;

/** What a handler answers once its work is done or deferred. */
export type EffectAnswer =
  | { kind: 'done'; outcome?: unknown }
  | { kind: 'wait'; retryAt: number; outcome?: unknown }
  | { kind: 'drop'; reason: string }
  /** Keep the lease until a fact ends the effect in its own transaction (`start_turn` only). */
  | { kind: 'await' };

/** Thrown by {@link EffectContext.markDone} when the lease is no longer this worker's. */
export class EffectLeaseLostError extends Error {
  /**
   * Name the effect whose lease was lost.
   *
   * @param effectId - The effect.
   */
  constructor(readonly effectId: string) {
    super(`The lease on effect ${effectId} is no longer held`);
    this.name = 'EffectLeaseLostError';
  }
}

/** What a handler is given beside its effect. */
export interface EffectContext {
  /** The clock, epoch ms. */
  now: () => number;
  /**
   * Mark the effect `done`, and settle its run if this was the run's last open
   * effect. Call it inside the transaction that writes the handler's own row,
   * so the two commit or roll back together (§6.4). Throws
   * {@link EffectLeaseLostError} when another worker has taken the effect, which
   * rolls that transaction back.
   */
  markDone: (outcome?: unknown) => void;
  /**
   * Hand the effect back to `pending`, due at `retryAt`, from a handler that
   * finishes after the worker stopped waiting on it. A no-op once the lease
   * is gone.
   */
  release: (retryAt: number, outcome?: unknown) => void;
}

/** One kind's handler (§6.2). */
export interface EffectHandler {
  /**
   * Do the effect's work.
   *
   * @param effect - The effect, leased to this worker.
   * @param ctx - The clock and the in-transaction finish.
   */
  handle(effect: TurnEffect, ctx: EffectContext): Promise<EffectAnswer> | EffectAnswer;
  /** What a handler still working past {@link EFFECT_HANDLER_TIMEOUT_MS} is taken to answer. */
  onTimeout?: 'await';
  /**
   * The effect passed its `not_after` while pending and is now `expired`.
   * Runs inside that transaction.
   *
   * @param effect - The effect, as expired.
   */
  onExpired?(effect: TurnEffect): void;
  /**
   * This boot holds the effect past its `not_after` (it answered `await`).
   *
   * @param effect - The effect, still leased.
   */
  expireHeld?(effect: TurnEffect): void;
  /**
   * This boot holds the effect between passes (it answered `await`): a chance
   * to hand it back when what it waited on is gone.
   *
   * @param effect - The effect, still leased.
   */
  checkHeld?(effect: TurnEffect): void;
}

/** The handler registry: one per kind that has one. */
export type EffectHandlers = Partial<Record<EffectKind, EffectHandler>>;

/** What {@link EffectWorker} needs. */
export interface EffectWorkerOptions {
  effects: EffectStore;
  runs: RunStore;
  handlers: EffectHandlers;
  /** This boot's epoch (§6.1): the owner named on every lease it takes. */
  epoch: string;
  /** The clock, epoch ms. Injected by tests. */
  now?: () => number;
}

/**
 * How long a `repeatable` effect waits after its `attempts`-th failed attempt.
 *
 * @param attempts - How many attempts it has had, at least 1.
 */
export function retryDelayMs(attempts: number): number {
  return EFFECT_RETRY_BACKOFF_MS[Math.min(attempts, EFFECT_RETRY_BACKOFF_MS.length) - 1]!;
}

/** The outbox's worker. */
export class EffectWorker {
  private readonly now: () => number;
  private running = false;
  /** Set for the whole of {@link loop}, so a wake during it asks for one more pass, not a second loop. */
  private looping = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private afterLapse: ReturnType<typeof setTimeout> | undefined;
  private stopListening: (() => void) | undefined;

  /**
   * Build a worker; it does nothing until {@link start}.
   *
   * @param opts - The stores, the handlers, the boot epoch and the clock.
   */
  constructor(private readonly opts: EffectWorkerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Whether the worker is started: what lets the emitter hand a turn to the outbox. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start: hear inserts, run a pass now, and another once every lease the boot
   * before held has run out, so its runs and effects are taken back without
   * waiting for their chats to be used.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopListening = this.opts.effects.onWork(() => this.wake());
    this.afterLapse = setTimeout(
      () => this.wake(),
      Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + EFFECT_TICK_MS
    );
    this.afterLapse.unref?.();
    // Every lease this boot holds, an awaited `start_turn`'s included, lives
    // as long as this process does.
    this.heartbeat = setInterval(() => {
      try {
        this.opts.effects.renewOwned(this.opts.epoch, EFFECT_LEASE_MS);
      } catch (err) {
        logger.warn('[runs] could not renew this boot’s effect leases', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, EFFECT_LEASE_RENEW_MS);
    this.heartbeat.unref?.();
    this.wake();
  }

  /** Stop waking. A pass under way finishes the effect it holds; nothing is released. */
  stop(): void {
    this.running = false;
    this.stopListening?.();
    this.stopListening = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.afterLapse) clearTimeout(this.afterLapse);
    this.afterLapse = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * Ask for a pass soon, after the current synchronous step (and any
   * transaction it is inside) has finished. A no-op while stopped.
   */
  wake(): void {
    if (!this.running) return;
    if (this.looping) {
      this.again = true;
      return;
    }
    this.arm(0);
  }

  /** Arm the one timer that starts the next loop, clearing any armed before it. */
  private arm(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.loop();
    }, delayMs);
    this.timer.unref?.();
  }

  /**
   * One pass, run to the end: what the wake-ups run, and what tests drive with
   * their own clock.
   *
   * @returns How many effects it took.
   */
  async runOnce(): Promise<number> {
    // Its own guard: a housekeeping failure must not keep due effects waiting.
    try {
      this.housekeep();
    } catch (err) {
      logger.error('[runs] the effects worker could not tidy up before its pass', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    let taken = 0;
    for (
      let effect = this.opts.effects.leaseNext(this.opts.epoch, EFFECT_LEASE_MS);
      effect;
      effect = this.opts.effects.leaseNext(this.opts.epoch, EFFECT_LEASE_MS)
    ) {
      taken += 1;
      await this.carryOut(effect);
    }
    return taken;
  }

  /** Passes until no wake arrived during the last, then the tick if anything is open. */
  private async loop(): Promise<void> {
    if (!this.running || this.looping) return;
    this.looping = true;
    try {
      do {
        this.again = false;
        try {
          await this.runOnce();
        } catch (err) {
          logger.error('[runs] the effects worker pass failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } while (this.again && this.running);
      if (this.running) this.armForNextWork();
    } finally {
      this.looping = false;
    }
  }

  /**
   * Arm the next pass for when something falls due: the earliest
   * `available_at`, `not_after` or lapsing lease, between
   * {@link EFFECT_TICK_MS} and {@link EFFECT_MAX_IDLE_MS} from now. Nothing
   * open, nothing armed. A store that cannot answer is asked again on the
   * shortest tick, never left to throw out of the loop.
   */
  private armForNextWork(): void {
    let at: number | undefined;
    try {
      at = this.opts.effects.nextWorkAt(this.opts.epoch);
    } catch (err) {
      logger.warn('[runs] could not read when the outbox next has work', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.arm(EFFECT_TICK_MS);
      return;
    }
    if (at === undefined) return;
    this.arm(Math.min(EFFECT_MAX_IDLE_MS, Math.max(EFFECT_TICK_MS, at - this.now())));
  }

  /** End dead boots' runs, take back lapsed leases, expire what is late, and settle what can. */
  private housekeep(): void {
    const { effects, runs } = this.opts;
    runs.retireDeadRuns();
    for (const effect of effects.reclaimLapsed(this.opts.epoch)) {
      logger.warn('[runs] an effect another boot was running ended unknown', {
        effectId: effect.id,
        kind: effect.kind,
      });
    }
    const { handlers } = this.opts;
    for (const effect of effects.expireDue((expired) =>
      handlers[expired.kind]?.onExpired?.(expired)
    )) {
      // Whoever asked is told by the kind that asked (§6.1); a notice that
      // itself expires is recorded and tells nobody.
      logger.info('[runs] an effect expired', { effectId: effect.id, kind: effect.kind });
    }
    for (const effect of effects.heldPastDeadline(this.opts.epoch)) {
      handlers[effect.kind]?.expireHeld?.(effect);
    }
    for (const effect of effects.heldBy(this.opts.epoch))
      handlers[effect.kind]?.checkHeld?.(effect);
    for (const run of runs.endedRunsToSettle(SETTLE_BATCH)) {
      effects.transaction(() => this.settleRun(run.id));
    }
  }

  /**
   * Move a run from `ended` to `settled` (transition 13) when nothing it caused
   * is still open. Inside the caller's transaction.
   */
  private settleRun(runId: string | null): void {
    if (runId === null) return;
    const { effects, runs } = this.opts;
    const run = runs.get(runId);
    if (run?.status !== 'ended' || isUndecided(run)) return;
    if (effects.openCountForRun(runId) > 0) return;
    runs.move(run, 'settled', { settledAt: runs.stamp() });
  }

  /** End a held effect, and settle its run with it, in one transaction. */
  private end(effect: TurnEffect, state: TerminalEffectState, outcome?: unknown): boolean {
    const lease: EffectLease = { id: effect.id, owner: this.opts.epoch };
    return this.opts.effects.transaction(() => {
      if (!this.opts.effects.finish(lease, state, outcome)) return false;
      this.settleRun(effect.runId);
      return true;
    });
  }

  /** Whether this worker still holds the effect's lease. */
  private holds(effect: TurnEffect): boolean {
    const now = this.opts.effects.get(effect.id);
    return now?.state === 'leased' && now.leaseOwner === this.opts.epoch;
  }

  /** Run one effect's handler and write what it answered. */
  private async carryOut(effect: TurnEffect): Promise<void> {
    const lease: EffectLease = { id: effect.id, owner: this.opts.epoch };
    const handler = this.opts.handlers[effect.kind];
    if (!handler) {
      this.end(effect, 'dropped', { reason: 'no_handler', kind: effect.kind });
      logger.error('[runs] an effect has no handler', { effectId: effect.id, kind: effect.kind });
      return;
    }
    const renew = setInterval(() => {
      try {
        if (!this.opts.effects.renew(lease, EFFECT_LEASE_MS)) clearInterval(renew);
      } catch (err) {
        // A busy or failing store: the next tick tries again before the lease ends.
        logger.warn('[runs] could not renew an effect’s lease', {
          effectId: effect.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, EFFECT_LEASE_RENEW_MS);
    renew.unref?.();
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      const working = Promise.resolve(
        handler.handle(effect, {
          now: this.now,
          markDone: (outcome) => {
            if (!this.end(effect, 'done', outcome)) throw new EffectLeaseLostError(effect.id);
          },
          release: (retryAt, outcome) => {
            this.opts.effects.release(lease, retryAt, outcome);
          },
        })
      );
      const timedOut = new Promise<'timeout'>((resolve) => {
        bound = setTimeout(() => resolve('timeout'), EFFECT_HANDLER_TIMEOUT_MS);
        bound.unref?.();
      });
      const answer = await Promise.race([working, timedOut]);
      if (answer === 'timeout') {
        // Still working: it finishes on its own, or is treated as a throw.
        working.catch((err: unknown) => this.failed(effect, err));
        if (handler.onTimeout === 'await') return;
        throw new Error(
          `the ${effect.kind} handler took longer than ${EFFECT_HANDLER_TIMEOUT_MS} ms`
        );
      }
      if (!this.holds(effect)) return; // marked done in its own transaction, or taken back
      if (answer.kind === 'await') return; // a fact ends it
      if (answer.kind === 'done') this.end(effect, 'done', answer.outcome);
      else if (answer.kind === 'drop') this.end(effect, 'dropped', { reason: answer.reason });
      else this.opts.effects.release(lease, answer.retryAt, answer.outcome);
    } catch (err) {
      this.failed(effect, err);
    } finally {
      clearTimeout(bound);
      clearInterval(renew);
    }
  }

  /** A handler threw: retry a `repeatable` effect with backoff, or end it. */
  private failed(effect: TurnEffect, err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    if (!this.holds(effect)) return;
    if (effect.delivery === 'once') {
      // Its outcome is unknown, so it is never run again (§6.2, rule 2).
      this.end(effect, 'unknown', { error });
      logger.warn('[runs] a once-only effect failed; its outcome is unknown', {
        effectId: effect.id,
        kind: effect.kind,
        error,
      });
      return;
    }
    const failures = failuresOf(effect) + 1;
    if (failures >= EFFECT_MAX_ATTEMPTS) {
      this.end(effect, 'dropped', {
        reason: 'attempts_exhausted',
        attempts: effect.attempts,
        failures,
        error,
      });
      logger.error('[runs] an effect was dropped after its last attempt', {
        effectId: effect.id,
        kind: effect.kind,
        error,
      });
      return;
    }
    this.opts.effects.release(
      { id: effect.id, owner: this.opts.epoch },
      this.now() + retryDelayMs(failures),
      { error, attempt: effect.attempts, failures }
    );
  }
}
