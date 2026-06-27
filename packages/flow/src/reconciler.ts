/**
 * The typed **reconciler contract** (charter L0) — the `/flow` engine's promotion
 * surface for the autonomous loop. A reconciler is one continuous concern the
 * loop tends each tick (dispatch new work, drain the inbox, recover an orphan,
 * clear the review gate, surface starvation, run a triage pass). Each is a small,
 * **idempotent** unit: it re-derives truth, then acts.
 *
 * This module is **types + interface ONLY** (task 2.1). The generic
 * priority-ordered **scheduler** that walks a registry of reconcilers lives in
 * `./scheduler.ts` (task 2.2); the concrete baseline reconcilers that wrap the
 * existing typed oracles (`selectDispatch`, `classifyDispatchOutcome`,
 * `evaluateAutoMerge`, …) live in `./reconcilers.ts` (task 2.5). Keeping the
 * contract free of runtime logic lets every consumer — the v1 prose loop and the
 * P5 server runner alike — program against one stable, tracker-agnostic shape.
 *
 * ## Tracker-agnostic by construction
 *
 * No reconciler type names a tracker. The adapter/oracle inputs a reconciler
 * needs are injected through the generic {@link ReconcileContext.input} slot, so
 * the contract never embeds a Linear (or any other tracker) string — the adapter
 * seam stays the single audit surface.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §3 (the reconciler registry + scheduler)
 * @see ./scheduler.ts (the generic registry + priority-ordered scheduler — task 2.2)
 * @see ./reconcilers.ts (the baseline reconcilers wrapping the existing oracles — task 2.5)
 * @module @dorkos/flow/reconciler
 */

/**
 * The closed set of reconciler ids in v1. Each is one continuous concern the
 * autonomous loop tends, and is the key under which its config lives in the
 * `loops` config block (task 2.4):
 *
 * - `recovery` — re-adopt orphaned claimed work (head of the tick).
 * - `inbox` — drain the inbox / resume parked `agent/needs-input` items.
 * - `review` — clear approved PRs at the human-review gate.
 * - `dispatch` — claim the top-ranked ready item.
 * - `triage` — ready shapeable backlog that lacks `agent/ready`.
 * - `hygiene` — surface starvation + keep the queue honest (slowest cadence).
 */
export type ReconcilerId = 'triage' | 'dispatch' | 'inbox' | 'recovery' | 'hygiene' | 'review';

/**
 * The per-reconciler control knobs (charter L0). The runtime mirror of the
 * `loops.<id>` Zod block (`ReconcilerConfigSchema`, task 2.4): the schema
 * validates `config.json`, this interface is what the scheduler and reconcilers
 * program against. Loop-specific fields extend this per reconciler (the schema's
 * per-loop entries may carry extra fields without widening this base).
 */
export interface ReconcilerConfig {
  /** Whether the loop runs at all. `false` skips the reconciler every tick. */
  enabled: boolean;
  /**
   * Tick ordering + contention precedence. **Lower runs first** and **lower
   * wins** a same-item contest (recovery 10 before dispatch 30 on one item).
   */
  priority: number;
  /** Minimum wall-clock between runs, in milliseconds (the cadence floor). */
  intervalMs: number;
}

/**
 * The per-tick context handed to a reconciler's {@link Reconciler.isDue} and
 * {@link Reconciler.run}. Carries the tick clock, the cadence anchor, the
 * scheduler's contention set, and the generic injected-input slot.
 *
 * The `input` slot is how the adapter/oracle facts a reconciler needs reach it
 * (kept tracker-agnostic): the tick gathers truth once (eligible work, inbox
 * events, liveness probes) and hands it in, so the reconciler decision stays a
 * **pure** function of its inputs — the same property that lets the existing
 * oracles port verbatim to the P5 server.
 *
 * @template TInput - The shape of the injected per-tick inputs. A registry is
 *   homogeneous in `TInput`: every reconciler reads its slice from the one bag.
 */
export interface ReconcileContext<TInput = unknown> {
  /** Wall-clock time of this tick, in epoch milliseconds (the cadence clock). */
  now: number;
  /**
   * When this reconciler last ran, in epoch milliseconds, or `undefined` if it
   * has not run before (or no durable last-run is tracked — the v1 case). The
   * cadence gate compares `now - lastRunAt` against the resolved `intervalMs`.
   */
  lastRunAt?: number;
  /**
   * The item identifiers already acted on **earlier this tick** by
   * higher-priority reconcilers — the scheduler's contention set, threaded in so
   * a lower-priority reconciler skips an item a higher-priority one already
   * claimed (recovery before dispatch). Populated by the scheduler; a bare
   * context (no scheduler) leaves it `undefined`, read as "nothing claimed yet".
   */
  claimedItemIds?: ReadonlySet<string>;
  /**
   * The injected adapter/oracle inputs this reconciler needs, tracker-agnostic.
   * Each reconciler reads only its slice; an absent slice means "not gathered
   * this tick", which a well-behaved {@link Reconciler.isDue} reports as not due.
   */
  input: TInput;
}

/**
 * The outcome of one reconciler run — what it did and to which item, for the
 * scheduler's contention dedupe and the loop's audit log. Deliberately small and
 * tracker-agnostic: the side-effecting "act" (claim, comment, merge) is performed
 * by the runtime that consumes the result, not encoded here.
 */
export interface ReconcileResult {
  /** Which reconciler produced this result. */
  id: ReconcilerId;
  /**
   * Whether the reconciler took a real action this tick (claimed, resumed,
   * merged, surfaced). `false` is a benign no-op (nothing was due to act on).
   */
  acted: boolean;
  /**
   * The item the reconciler acted on, when the action is item-scoped. Feeds the
   * scheduler's same-item contention dedupe; absent for backlog-wide actions
   * (e.g. a triage pass) and for no-ops.
   */
  itemId?: string;
  /** Human-readable one-line summary of the decision, for the audit log. */
  summary: string;
}

/**
 * One **reconciler** — a continuous concern the autonomous loop tends each tick.
 * `isDue` gates the run (cadence + a cheap predicate); `run` re-derives truth and
 * acts, returning a {@link ReconcileResult}. Both must be **idempotent**: a tick
 * may re-run them, and re-running must not double-act (events are triggers, not
 * truth — re-read current state before acting).
 *
 * The concrete reconcilers wrap the existing typed oracles with **no new
 * decision logic** (task 2.5): the oracle is the decision, the reconciler is the
 * cadence + plumbing around it.
 *
 * @template TInput - The shape of {@link ReconcileContext.input} this reconciler
 *   reads. Defaults to `unknown` for fakes/tests that ignore the input slot.
 */
export interface Reconciler<TInput = unknown> {
  /** The reconciler's stable id (also its `loops.<id>` config key). */
  id: ReconcilerId;
  /**
   * The built-in default config (priority + interval + enabled), used when the
   * `loops` block does not override it. Matches the task-2.4 calibration so the
   * registry orders correctly with no config present.
   */
  defaultConfig: ReconcilerConfig;
  /**
   * Whether the reconciler should run this tick — the cadence gate AND a cheap
   * predicate over its injected inputs ("is there anything to do?"). Pure; no
   * I/O. Returning `false` skips {@link run} entirely.
   *
   * @param ctx - The per-tick context (clock, cadence anchor, contention set, inputs).
   * @returns `true` when the reconciler is both on-cadence and has work.
   */
  isDue(ctx: ReconcileContext<TInput>): boolean;
  /**
   * Re-derive truth and act, returning what was done. Idempotent and
   * contention-aware (skip an item already in {@link ReconcileContext.claimedItemIds}).
   *
   * @param ctx - The per-tick context (clock, cadence anchor, contention set, inputs).
   * @returns The reconcile result (acted? on which item? a summary).
   */
  run(ctx: ReconcileContext<TInput>): Promise<ReconcileResult>;
}
