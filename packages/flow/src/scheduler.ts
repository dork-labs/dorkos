/**
 * The generic **reconciler registry + priority-ordered scheduler** (charter L0,
 * task 2.2) — the engine that walks a set of {@link Reconciler}s each tick. It is
 * deliberately **dumb**: it only orders by priority, gates by `enabled` + `isDue`,
 * dedupes same-item contention by priority, and collects results. Re-deriving
 * truth and deciding what to do is each reconciler's job, never the scheduler's.
 *
 * ## Priority is the one ordering axis
 *
 * Reconcilers run in **ascending priority** (lower first). The same number
 * resolves contention: when a higher-priority reconciler acts on an item this
 * tick, every lower-priority reconciler **skips** that item — that is what makes
 * `recovery` (10) re-adopt an orphan before `dispatch` (30) tries to claim the
 * same one. The scheduler threads the set of already-claimed ids through
 * {@link ReconcileContext.claimedItemIds}; a contention-aware reconciler reads it
 * in `isDue`/`run` and stands down.
 *
 * ## Cadence lives in `isDue`, not here
 *
 * Per §3 the scheduler "orders, gates by enabled/isDue, and dedupes by itemId".
 * The cadence floor (`intervalMs`) is part of each reconciler's `isDue` (via
 * {@link isCadenceDue}), so the scheduler never re-implements timing. The
 * scheduler only resolves the `loops` config override and reads `enabled`.
 *
 * The continuous unattended runner that actually calls {@link runTick} on a timer
 * is the deferred P5 server build; v1 mirrors this order in prose (`/flow auto` +
 * `flow-drain`). This typed registry + scheduler are the promotion surface landed
 * and tested now.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §3
 * @see ./reconciler.ts (the typed contract — task 2.1)
 * @see ./reconcilers.ts (the baseline reconcilers + `defaultRegistry` — task 2.5)
 * @module @dorkos/flow/scheduler
 */

import type {
  ReconcileContext,
  ReconcileResult,
  Reconciler,
  ReconcilerConfig,
  ReconcilerId,
} from './reconciler.js';

/**
 * A registry of reconcilers exposing them in priority order. Construct one with
 * {@link createReconcilerRegistry}; drive it with {@link runTick}.
 *
 * @template TInput - The shared injected-input shape every reconciler reads.
 */
export interface ReconcilerRegistry<TInput = unknown> {
  /**
   * The registered reconcilers sorted by **ascending** `defaultConfig.priority`
   * (lower first). A new array each call — never the internal store.
   */
  list(): Reconciler<TInput>[];
}

/**
 * Per-reconciler config overrides, keyed by {@link ReconcilerId} — the runtime
 * shape of the `loops` config block (task 2.4). Each entry is merged OVER the
 * reconciler's `defaultConfig`, so a partial override (just `enabled`, just
 * `priority`) leaves the rest at the default.
 */
export type LoopConfigOverrides = Partial<Record<ReconcilerId, Partial<ReconcilerConfig>>>;

/**
 * Whether enough wall-clock has elapsed for a reconciler to run again — the
 * cadence half of `isDue`. A reconciler that has never run (`lastRunAt`
 * undefined, the v1 default) is always due; otherwise it is due once
 * `now - lastRunAt` reaches `intervalMs`.
 *
 * @param ctx - The per-tick context (supplies `now` + `lastRunAt`).
 * @param intervalMs - The reconciler's resolved cadence floor.
 * @returns `true` when the reconciler is on or past its cadence.
 */
export function isCadenceDue(ctx: ReconcileContext<unknown>, intervalMs: number): boolean {
  if (ctx.lastRunAt === undefined) return true;
  return ctx.now - ctx.lastRunAt >= intervalMs;
}

/**
 * Build a {@link ReconcilerRegistry} over the given reconcilers. The registry is
 * immutable: {@link ReconcilerRegistry.list} returns a fresh, priority-sorted
 * copy each call, so callers cannot mutate the registration order.
 *
 * @template TInput - The shared injected-input shape every reconciler reads.
 * @param reconcilers - The reconcilers to register (any order; sorted on read).
 * @returns A registry exposing the reconcilers in ascending-priority order.
 */
export function createReconcilerRegistry<TInput>(
  reconcilers: readonly Reconciler<TInput>[]
): ReconcilerRegistry<TInput> {
  const stored = [...reconcilers];
  return {
    list(): Reconciler<TInput>[] {
      return [...stored].sort((a, b) => a.defaultConfig.priority - b.defaultConfig.priority);
    },
  };
}

/**
 * Merge a reconciler's `defaultConfig` with its `loops` override (if any),
 * yielding the resolved config the tick runs on.
 */
function resolveConfig(
  reconciler: Reconciler<unknown>,
  overrides: LoopConfigOverrides | undefined
): ReconcilerConfig {
  return { ...reconciler.defaultConfig, ...(overrides?.[reconciler.id] ?? {}) };
}

/**
 * Run **one tick** of the autonomous loop over a registry (task 2.2).
 *
 * For each reconciler, in **ascending resolved priority** order, the scheduler:
 * 1. resolves its config (`defaultConfig` merged with the `loops` override) and
 *    **skips** it when `enabled === false`;
 * 2. **skips** it when `isDue(ctx) === false` (cadence + predicate live in the
 *    reconciler, not here);
 * 3. otherwise `await`s `run(ctx)`, collecting the {@link ReconcileResult};
 * 4. records the acted-on `itemId` so any **lower-priority** reconciler later
 *    this tick sees it in {@link ReconcileContext.claimedItemIds} and stands down
 *    (same-item contention resolved by priority).
 *
 * The scheduler stays pure of decision logic: it orders, gates, dedupes, and
 * returns the results in the order they ran (ascending priority). Resolved
 * priority (not just `defaultConfig.priority`) drives the order, so a `loops`
 * priority override re-orders the tick.
 *
 * @template TInput - The shared injected-input shape every reconciler reads.
 * @param registry - The registry of reconcilers to walk.
 * @param ctx - The base per-tick context (clock, cadence anchor, inputs). The
 *   scheduler re-threads {@link ReconcileContext.claimedItemIds} per reconciler;
 *   any value on the base context is the contention seed.
 * @param configByLoop - The `loops` config overrides (task 2.4), or `undefined`
 *   to run every reconciler at its `defaultConfig`.
 * @returns The results of the reconcilers that ran, in ascending-priority order.
 */
export async function runTick<TInput>(
  registry: ReconcilerRegistry<TInput>,
  ctx: ReconcileContext<TInput>,
  configByLoop?: LoopConfigOverrides
): Promise<ReconcileResult[]> {
  // Resolve configs once, then order by RESOLVED priority so a loops override of
  // `priority` re-orders the tick (registry.list() only knows defaultConfig).
  const ordered = registry
    .list()
    .map((reconciler) => ({ reconciler, config: resolveConfig(reconciler, configByLoop) }))
    .sort((a, b) => a.config.priority - b.config.priority);

  const results: ReconcileResult[] = [];
  // Seed the contention set from the base context, then accumulate this tick's claims.
  const claimed = new Set<string>(ctx.claimedItemIds ?? []);

  for (const { reconciler, config } of ordered) {
    if (!config.enabled) continue;

    const perCtx: ReconcileContext<TInput> = { ...ctx, claimedItemIds: claimed };
    if (!reconciler.isDue(perCtx)) continue;

    const result = await reconciler.run(perCtx);
    results.push(result);

    // Record the claim so lower-priority reconcilers skip this item this tick.
    if (result.acted && result.itemId !== undefined) {
      claimed.add(result.itemId);
    }
  }

  return results;
}
