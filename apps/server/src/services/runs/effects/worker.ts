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
 * (an in-process signal), on a 1-second tick while anything is still open,
 * and once more when every lease of the boot before has run out; with nothing
 * open it sleeps until the next insert. What follows a dead run beyond its
 * ending (a continuation, a person's line) stays recovery's to decide (T15).
 *
 * **Leases.** Taking an effect is one conditional update, so two workers never
 * both run it. A lease lasts 60 seconds and is renewed every 20 while the
 * handler works. A lease another boot let run out is taken back:
 * `repeatable` to `pending`, `once` to `unknown` (§6.2, rule 1). This boot's
 * own leases are never taken back by itself.
 *
 * **Answers.** A handler answers `done`, `wait(retryAt)` or `drop(reason)`; the
 * spec's fourth answer, `await(fact)`, arrives with `start_turn` (T5), its only
 * user. A throw on a `repeatable` effect retries after 1 s, 5 s, 30 s, 2 min,
 * then every 10 min, and is `dropped` after its eighth attempt; a throw on a
 * `once` effect is `unknown`. A handler whose work is a write to `dork.db`
 * does that write and calls {@link EffectContext.markDone} inside the same
 * transaction (§6.4), which is what makes that write happen exactly once.
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

/** The tick while anything is open (§6.1). */
export const EFFECT_TICK_MS = 1_000;

/** The waits between a `repeatable` effect's failed attempts; the last repeats. */
export const EFFECT_RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;

/** A `repeatable` effect is dropped after this many failed attempts. */
export const EFFECT_MAX_ATTEMPTS = 8;

/** How many `ended` runs one pass reads to settle. */
const SETTLE_BATCH = 100;

/** What a handler answers once its work is done or deferred. */
export type EffectAnswer =
  | { kind: 'done'; outcome?: unknown }
  | { kind: 'wait'; retryAt: number; outcome?: unknown }
  | { kind: 'drop'; reason: string };

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
  private passing: Promise<void> | undefined;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
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
  }

  /**
   * Ask for a pass soon, after the current synchronous step (and any
   * transaction it is inside) has finished. A no-op while stopped.
   */
  wake(): void {
    if (!this.running) return;
    if (this.passing) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.loop();
    }, 0);
    this.timer.unref?.();
  }

  /**
   * One pass, run to the end: what the wake-ups run, and what tests drive with
   * their own clock.
   *
   * @returns How many effects it took.
   */
  async runOnce(): Promise<number> {
    this.housekeep();
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
    do {
      this.again = false;
      this.passing = this.runOnce().then(
        () => undefined,
        (err: unknown) => {
          logger.error('[runs] the effects worker pass failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      );
      await this.passing;
      this.passing = undefined;
    } while (this.again && this.running);
    if (this.running && this.opts.effects.hasOpen()) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.loop();
      }, EFFECT_TICK_MS);
      this.timer.unref?.();
    }
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
    for (const effect of effects.expireDue()) {
      // Whoever asked is told by the kind that asked (§6.1); a notice that
      // itself expires is recorded and tells nobody.
      logger.info('[runs] an effect expired', { effectId: effect.id, kind: effect.kind });
    }
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
      if (!this.opts.effects.renew(lease, EFFECT_LEASE_MS)) clearInterval(renew);
    }, EFFECT_LEASE_RENEW_MS);
    renew.unref?.();
    try {
      const answer = await handler.handle(effect, {
        now: this.now,
        markDone: (outcome) => {
          if (!this.end(effect, 'done', outcome)) throw new EffectLeaseLostError(effect.id);
        },
      });
      if (!this.holds(effect)) return; // marked done in its own transaction, or taken back
      if (answer.kind === 'done') this.end(effect, 'done', answer.outcome);
      else if (answer.kind === 'drop') this.end(effect, 'dropped', { reason: answer.reason });
      else this.opts.effects.release(lease, answer.retryAt, answer.outcome);
    } catch (err) {
      this.failed(effect, err);
    } finally {
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
    if (effect.attempts >= EFFECT_MAX_ATTEMPTS) {
      this.end(effect, 'dropped', {
        reason: 'attempts_exhausted',
        attempts: effect.attempts,
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
      this.now() + retryDelayMs(effect.attempts),
      { error, attempt: effect.attempts }
    );
  }
}
