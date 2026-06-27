/**
 * The canonical typed **dispatch policy** (§4) — the `/flow` engine's answer to
 * "what should I work on next?". Two passes, both config-driven:
 *
 * 1. **Eligibility** ({@link filterEligible}) — filter OUT items that cannot be
 *    dispatched right now (wrong state, not ready, blocked, in a dead project,
 *    over the WIP cap, or not claimable per the ownership policy).
 * 2. **Ranking** ({@link rankEligible}) — order the survivors by the 7-tier
 *    ladder, with later tiers breaking ties left by earlier ones.
 *
 * {@link selectDispatch} runs both passes and returns the ordered, eligible
 * survivors.
 *
 * ## This is the library core, not dead code
 *
 * The prose `/flow` stage skills describe the *same* rules in natural language
 * (the dispatched session ranks inline, §4 "Resolved direction"). This module is
 * the **pinned typed oracle** for those rules and the **P5 promotion surface** —
 * when the P5 server build replaces the skill-driven loop with a typed engine,
 * it calls this function directly. The skill prose and this code must stay in
 * lockstep; this is the single executable definition of the ladder.
 *
 * ## Ownership is consumed as INPUT (the task 3.1 integration point)
 *
 * The eligibility filter needs each item's {@link OwnershipClass}, but the
 * `classifyOwnership` primitive itself is built later (task 3.1, §7). This
 * module therefore accepts ownership as an **injected input**: callers pass a
 * `classifyOwnership` callback (or a precomputed `ownershipOf` map) via
 * {@link DispatchOptions}. Task 3.1 supplies the real callback; tests inject a
 * stub. This module never classifies ownership itself.
 *
 * ## Graceful degradation
 *
 * Missing {@link WorkItem.priority} / {@link WorkItem.size} / {@link
 * WorkItem.createdAt} are treated as **NEUTRAL** in their respective tiers —
 * never fabricated into a real value. A neutral value sorts *after* every
 * concrete value, so a real estimate always outranks a missing one.
 *
 * @see specs/unified-workflow-system/02-specification.md §4 (dispatch policy)
 * @see .agents/flow/skills/linear-adapter/SKILL.md (the WorkItem contract + degradation rules)
 * @module @dorkos/flow/dispatch
 */

import type { DispatchSchema, OwnershipSchema, WipCapSchema } from './config-schema.js';
import type { z } from 'zod';
import type { OwnershipClass, WorkItem } from './work-item.js';

/** Resolved {@link DispatchSchema} config — the ranking factors + size order. */
export type DispatchConfig = z.infer<typeof DispatchSchema>;
/** Resolved {@link OwnershipSchema} config — which classes may be claimed. */
export type OwnershipConfig = z.infer<typeof OwnershipSchema>;
/** Resolved {@link WipCapSchema} config — global + per-project WIP caps. */
export type WipCap = z.infer<typeof WipCapSchema>;

/** A single ranking factor (mirrors `DispatchRankSchema`). */
export type RankFactor = DispatchConfig['rank'][number];

/**
 * State categories an item may be dispatched FROM. An item that is already
 * `completed` or `canceled` is terminal; the engine never picks it up.
 */
const DISPATCHABLE_STATE_CATEGORIES = new Set(['backlog', 'unstarted', 'started']);

/** Project state categories that make every item under them un-dispatchable. */
const DEAD_PROJECT_STATE_CATEGORIES = new Set(['completed', 'canceled']);

/** The durable `agent/ready` label that gates dispatch in PM-driven mode. */
const AGENT_READY_LABEL = 'agent/ready';

/**
 * Lenient ordinal scale for the size tier. Maps both t-shirt sizes and Fibonacci
 * estimate points onto a single ascending ordinal (smaller index = smaller
 * work). Any unrecognized estimate is treated as NEUTRAL (see {@link sizeRank}).
 */
const SIZE_SCALE: Record<string, number> = {
  xs: 0,
  '1': 0,
  sm: 1,
  small: 1,
  '2': 1,
  md: 2,
  medium: 2,
  '3': 2,
  lg: 3,
  large: 3,
  '5': 3,
  xl: 4,
  '8': 4,
  xxl: 5,
  '13': 5,
};

/** Priority ordinal: lower sorts first. Urgent (1) → high (2) → … → none (0/∞). */
const PRIORITY_RANK: Record<number, number> = {
  1: 0, // urgent
  2: 1, // high
  3: 2, // medium
  4: 3, // low
  0: 4, // none — explicitly last among concrete values
};

/** A neutral rank: sorts AFTER every concrete value in a tier. */
const NEUTRAL = Number.POSITIVE_INFINITY;

/**
 * Maps a config {@link OwnershipClass} onto the {@link OwnershipConfig} flag that
 * declares whether the agent may claim it. `'mine'` is always claimable (the
 * agent's own work); the other three are policy-gated.
 *
 * @param cls - The item's ownership class.
 * @param ownership - The resolved ownership claim policy.
 * @returns `true` if the agent may claim an item of this class.
 */
export function isClaimable(cls: OwnershipClass, ownership: OwnershipConfig): boolean {
  switch (cls) {
    case 'mine':
      return ownership.claimAssignedToAgent;
    case 'unassigned':
      return ownership.claimUnassigned;
    case 'reviewer':
      return ownership.claimAssignedToHuman;
    case 'other':
      return ownership.claimAssignedToOthers;
  }
}

/**
 * Options for the dispatch passes. Supplies the runtime inputs the policy cannot
 * derive from a {@link WorkItem} alone: ownership classification (task 3.1) and
 * the live in-progress WIP counts.
 */
export interface DispatchOptions {
  /**
   * Resolves an item's {@link OwnershipClass}. The task 3.1 integration point —
   * pass the real `classifyOwnership`; tests pass a stub. Either this or
   * {@link ownershipOf} must be provided.
   */
  classifyOwnership?: (item: WorkItem) => OwnershipClass;
  /**
   * Precomputed ownership by item `identifier`, used when ownership was resolved
   * upstream. Takes precedence over {@link classifyOwnership} for a given item.
   */
  ownershipOf?: Record<string, OwnershipClass>;
  /**
   * Count of items already in progress (claimed), keyed by project id, used for
   * the per-project WIP cap. Defaults to all-zero. The candidate items
   * themselves are NOT pre-counted — the cap measures existing load.
   */
  inProgressByProject?: Record<string, number>;
  /**
   * Total count of items already in progress across all projects, for the global
   * WIP cap. Defaults to `0`.
   */
  inProgressTotal?: number;
}

/**
 * Resolves an item's ownership class from {@link DispatchOptions}, preferring a
 * precomputed entry over the callback.
 *
 * @throws If neither `ownershipOf[id]` nor `classifyOwnership` is available.
 */
function resolveOwnership(item: WorkItem, opts: DispatchOptions): OwnershipClass {
  const precomputed = opts.ownershipOf?.[item.identifier];
  if (precomputed !== undefined) return precomputed;
  if (opts.classifyOwnership) return opts.classifyOwnership(item);
  throw new Error(
    `dispatch: no ownership for "${item.identifier}" — provide classifyOwnership or ownershipOf`
  );
}

/**
 * Whether an item's `blockedBy` set contains any item that is still open
 * (present in the candidate set with a non-terminal state). A blocker that is
 * `completed`/`canceled` (or absent from the set) does not block.
 *
 * @param item - The item under evaluation.
 * @param openIdentifiers - Identifiers of all open candidate items.
 */
function hasOpenBlocker(item: WorkItem, openIdentifiers: Set<string>): boolean {
  return item.relations.blockedBy.some((id) => openIdentifiers.has(id));
}

/**
 * **Pass 1 — Eligibility.** Filters OUT every item that cannot be dispatched
 * right now (§4). An item survives only if ALL hold: its `stateCategory` is
 * dispatchable; it carries the `agent/ready` label (PM-driven mode); it is not
 * `blockedBy` any open item; its `project.stateCategory` is not
 * completed/canceled; admitting it would not exceed the global or per-project
 * WIP cap; and its ownership class is claimable per the `ownership` policy.
 *
 * The WIP cap is enforced **greedily in input order**: items are admitted until
 * a cap is hit, after which further items for that project (or globally) are
 * filtered. Caller should pass items in a stable order if cap-edge determinism
 * matters; {@link selectDispatch} ranks survivors afterward regardless.
 *
 * @param items - The candidate work items.
 * @param ownership - The resolved ownership claim policy.
 * @param wipCap - The resolved global + per-project WIP caps.
 * @param opts - Ownership resolution + live in-progress counts.
 * @returns The eligible survivors, in input order.
 */
export function filterEligible(
  items: readonly WorkItem[],
  ownership: OwnershipConfig,
  wipCap: WipCap,
  opts: DispatchOptions
): WorkItem[] {
  const openIdentifiers = new Set(
    items
      .filter((it) => DISPATCHABLE_STATE_CATEGORIES.has(it.stateCategory))
      .map((it) => it.identifier)
  );

  // Running WIP budget seeded from existing in-progress load.
  let globalCount = opts.inProgressTotal ?? 0;
  const perProjectCount: Record<string, number> = { ...(opts.inProgressByProject ?? {}) };

  const survivors: WorkItem[] = [];
  for (const item of items) {
    if (!DISPATCHABLE_STATE_CATEGORIES.has(item.stateCategory)) continue;
    if (!item.labels.includes(AGENT_READY_LABEL)) continue;
    if (hasOpenBlocker(item, openIdentifiers)) continue;
    if (
      item.project?.stateCategory &&
      DEAD_PROJECT_STATE_CATEGORIES.has(item.project.stateCategory)
    )
      continue;
    if (!isClaimable(resolveOwnership(item, opts), ownership)) continue;

    // WIP cap — enforced last so it only counts otherwise-eligible items.
    const projectId = item.project?.id;
    const projectCount = projectId ? (perProjectCount[projectId] ?? 0) : 0;
    if (globalCount >= wipCap.global) continue;
    if (projectId && projectCount >= wipCap.perProject) continue;

    survivors.push(item);
    globalCount += 1;
    if (projectId) perProjectCount[projectId] = projectCount + 1;
  }

  return survivors;
}

/** A pre-resolved set of open candidate identifiers, for the unblockers tier. */
function buildOpenSet(items: readonly WorkItem[]): Set<string> {
  return new Set(
    items
      .filter((it) => DISPATCHABLE_STATE_CATEGORIES.has(it.stateCategory))
      .map((it) => it.identifier)
  );
}

/** Tier 1 — how many OPEN items this item blocks (more = ranks first). */
function unblockerScore(item: WorkItem, openIdentifiers: Set<string>): number {
  return item.relations.blocks.filter((id) => openIdentifiers.has(id)).length;
}

/** Tier 2 — priority ordinal; missing priority is NEUTRAL (sorts last). */
function priorityRank(item: WorkItem): number {
  if (item.priority === undefined) return NEUTRAL;
  return PRIORITY_RANK[item.priority] ?? NEUTRAL;
}

/** Tier 3 — `started` projects (in progress) before `unstarted`/`backlog`. */
function projectStatusRank(item: WorkItem): number {
  return item.project?.stateCategory === 'started' ? 0 : 1;
}

/** Tier 5 — size ordinal honoring `sizeOrder`; missing/unknown size is NEUTRAL. */
function sizeRank(item: WorkItem, sizeOrder: DispatchConfig['sizeOrder']): number {
  if (item.size === undefined) return NEUTRAL;
  const ordinal = SIZE_SCALE[item.size.toLowerCase()];
  if (ordinal === undefined) return NEUTRAL;
  // large-first inverts the ascending scale; NEUTRAL stays last either way.
  return sizeOrder === 'large-first' ? -ordinal : ordinal;
}

/** Tier 6 — creation time ordinal (oldest first); missing time is NEUTRAL. */
function ageRank(item: WorkItem): number {
  if (item.createdAt === undefined) return NEUTRAL;
  const ms = Date.parse(item.createdAt);
  return Number.isNaN(ms) ? NEUTRAL : ms;
}

/**
 * Resolves the per-type weight for tier 4 from the `dispatch.rank` config. v1
 * config carries no per-type weighting (the `type` factor is a placeholder in
 * the ladder), so every type weighs equally (`0`) and the tier is a no-op tie.
 * Kept as a seam: when per-type weights land in config, only this returns change.
 */
function typeRank(_item: WorkItem): number {
  return 0;
}

/**
 * Comparator for two items under one ranking factor. Returns a negative number
 * if `a` should rank before `b`, positive if after, `0` if tied (deferred to a
 * later tier).
 */
function compareByFactor(
  factor: RankFactor,
  a: WorkItem,
  b: WorkItem,
  openIdentifiers: Set<string>,
  config: DispatchConfig
): number {
  switch (factor) {
    case 'unblockers':
      // More blocked-open-items first → descending score.
      return unblockerScore(b, openIdentifiers) - unblockerScore(a, openIdentifiers);
    case 'priority':
      return priorityRank(a) - priorityRank(b);
    case 'projectStatus':
      return projectStatusRank(a) - projectStatusRank(b);
    case 'type':
      return typeRank(a) - typeRank(b);
    case 'size':
      return sizeRank(a, config.sizeOrder) - sizeRank(b, config.sizeOrder);
    case 'age':
      return ageRank(a) - ageRank(b);
  }
}

/**
 * **Pass 2 — Ranking.** Orders eligible survivors by the configured tier ladder
 * (`config.rank`), with later tiers breaking ties left by earlier ones (§4). A
 * final deterministic `identifier` tiebreak (tier 7) guarantees a total,
 * stable order regardless of input order.
 *
 * Ranking is non-destructive: it copies before sorting and never mutates the
 * input. Tier weights live entirely in {@link DispatchConfig} — re-prioritizing
 * is a config edit, never a code change.
 *
 * @param items - The eligible survivors (output of {@link filterEligible}).
 * @param config - The resolved dispatch config (`rank` order + `sizeOrder`).
 * @returns A new array ordered by the ladder.
 */
export function rankEligible(items: readonly WorkItem[], config: DispatchConfig): WorkItem[] {
  const openIdentifiers = buildOpenSet(items);
  return [...items].sort((a, b) => {
    for (const factor of config.rank) {
      const delta = compareByFactor(factor, a, b, openIdentifiers, config);
      if (delta !== 0) return delta;
    }
    // Tier 7 — deterministic final tiebreak on the human identifier.
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}

/**
 * Run the full dispatch policy: {@link filterEligible} then {@link rankEligible}.
 * Returns the eligible survivors ordered by the 7-tier ladder — the engine's
 * pick list (head = "work on this next").
 *
 * @param items - The candidate work items (from the adapter's `getEligibleWork`).
 * @param config - The resolved `dispatch`, `ownership`, and `wipCap` config.
 * @param opts - Ownership resolution (the task 3.1 seam) + live WIP counts.
 * @returns The ordered, eligible survivors.
 */
export function selectDispatch(
  items: readonly WorkItem[],
  config: { dispatch: DispatchConfig; ownership: OwnershipConfig; wipCap: WipCap },
  opts: DispatchOptions
): WorkItem[] {
  const eligible = filterEligible(items, config.ownership, config.wipCap, opts);
  return rankEligible(eligible, config.dispatch);
}

/**
 * The result of {@link classifyDispatchOutcome} — the dispatch pick plus the two
 * signals the loop needs to tell **"genuinely done"** from **"starved behind the
 * readiness gate"** (the charter G3 "never starve silently" contract).
 */
export interface DispatchOutcome {
  /** The ranked, eligible survivors (the output of {@link selectDispatch}). */
  picked: WorkItem[];
  /** `picked.length` — how many items are dispatchable right now. */
  eligibleCount: number;
  /**
   * `true` when nothing is eligible **but** shapeable work sits behind the
   * `agent/ready` gate: the queue is starved, not done. Defined as
   * `eligibleCount === 0 && shapeableCount > 0`. A triage / decompose pass could
   * ready that work, so the loop surfaces it rather than stopping silently.
   */
  starved: boolean;
  /**
   * Count of dispatchable-category items (`backlog` / `unstarted` / `started`, in
   * a non-dead project) that LACK the `agent/ready` label: the lever a triage
   * pass pulls. This is a readiness / category fact (ownership is not consulted),
   * and it deliberately does NOT count blocked or WIP-capped ready items: those
   * are a different fix than readying more work.
   */
  shapeableCount: number;
}

/**
 * Classify the dispatch outcome: run the full policy AND report whether an empty
 * pick means **done** or **starved**. This is the charter G3 contract: the loop
 * must never set `ready: 0` and stop silently while shapeable work waits behind
 * the `agent/ready` gate.
 *
 * `shapeableCount` counts dispatchable-category items (in a non-dead project) that
 * are missing the `agent/ready` label: the readiness lever a triage / decompose
 * pass pulls. It reuses the same module constants as {@link filterEligible}
 * ({@link DISPATCHABLE_STATE_CATEGORIES}, {@link DEAD_PROJECT_STATE_CATEGORIES},
 * {@link AGENT_READY_LABEL}) so "shapeable" stays the exact inverse of the
 * readiness gate dispatch enforces.
 *
 * @param items - The candidate work items (from the adapter's `getEligibleWork`).
 * @param config - The resolved `dispatch`, `ownership`, and `wipCap` config.
 * @param opts - Ownership resolution (the task 3.1 seam) + live WIP counts.
 * @returns The pick list plus the starvation signals.
 */
export function classifyDispatchOutcome(
  items: readonly WorkItem[],
  config: { dispatch: DispatchConfig; ownership: OwnershipConfig; wipCap: WipCap },
  opts: DispatchOptions
): DispatchOutcome {
  const picked = selectDispatch(items, config, opts);
  const eligibleCount = picked.length;
  const shapeableCount = items.filter(
    (item) =>
      DISPATCHABLE_STATE_CATEGORIES.has(item.stateCategory) &&
      !(
        item.project?.stateCategory && DEAD_PROJECT_STATE_CATEGORIES.has(item.project.stateCategory)
      ) &&
      !item.labels.includes(AGENT_READY_LABEL)
  ).length;

  return {
    picked,
    eligibleCount,
    starved: eligibleCount === 0 && shapeableCount > 0,
    shapeableCount,
  };
}
