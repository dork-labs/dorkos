/**
 * The calibration ladder (§5) — the canonical, typed implementation of the
 * single most important behavior in the `/flow` engine: **uncertainty-gated
 * (not stage-gated) human involvement**.
 *
 * At every decision point the agent walks this five-row ladder top-down and
 * acts on the **first matching row**. Only three behaviors exist
 * ({@link InvolvementBehavior}); the only things that ever block the autonomous
 * loop are the floor (row 0), sticky uncertainty (row 2), and uncertainty in an
 * intent stage (row 3 routed to `ask`).
 *
 * | # | Condition | Behavior | Blocks loop? |
 * |---|-----------|----------|--------------|
 * | 0 | Floor — irreversible/destructive · outward-facing · secrets/spend/prod · scope change | stop-and-ask — even at full confidence | yes |
 * | 1 | Reversible + confident | proceed-silently | no |
 * | 2 | Sticky + not-confident | stop-and-ask | yes |
 * | 3 | Reversible + not-confident (the ambiguous middle) | routed by `stageBias` | stage-dependent |
 * | 4 | Sticky + confident | proceed-with-trail (announce) | no |
 *
 * Stage bias routes row 3 with the frozen spec as the cut line: intent stages
 * (CAPTURE/TRIAGE/IDEATE/SPECIFY → `intake`) ask; execution stages
 * (DECOMPOSE/EXECUTE/VERIFY → `execution`) proceed on the best default and log
 * the assumption. That single rule yields "IDEATE asks freely, EXECUTE asks
 * rarely" as an emergent property.
 *
 * **This module is the pinned oracle.** The v1 prose skills describe these same
 * rules in natural language, but this TypeScript is the tested source of truth
 * and the P5 promotion surface the spec is building toward — it is the library
 * core, not dead code. Every threshold is driven from the
 * {@link Calibration} config (`proceedSilentlyWhen`, `alwaysAsk`, `stageBias`,
 * `assumptionLog`) so re-tuning involvement never touches code.
 *
 * @see specs/unified-workflow-system/02-specification.md §5
 * @module @dorkos/flow/calibration
 */

import type { z } from 'zod';
import type { CalibrationSchema } from './config-schema.js';

/**
 * The resolved `involvement.calibration` config block (§5) that drives every
 * threshold in the ladder. Inferred from {@link CalibrationSchema} so the
 * config schema in `config-schema.ts` stays the single source of truth.
 */
export type Calibration = z.infer<typeof CalibrationSchema>;

/**
 * The four floor triggers (§5, ladder row 0). Any one present forces a
 * `stop-and-ask` regardless of confidence or reversibility. Mirrors the
 * `alwaysAsk` config tags ({@link Calibration.alwaysAsk}).
 */
export type FloorTrigger =
  | 'irreversible-or-destructive'
  | 'outward-facing'
  | 'secrets-or-spend'
  | 'scope-change';

/**
 * Reversibility of the decision (§5). `reversible` = cheap to undo inside the
 * loop (code edit, worktree file, draft comment). `sticky` = costly or visible
 * to undo.
 */
export type Reversibility = 'reversible' | 'sticky';

/**
 * Confidence in the decision (§5). `confident` means the answer is determined
 * by the frozen spec, an ADR/decision, a strong codebase convention, or a prior
 * human answer — not a hunch. Anything requiring guessing intent or choosing
 * between materially-different approaches with no steer is `not-confident`.
 */
export type Confidence = 'confident' | 'not-confident';

/**
 * Stage class that routes the ambiguous middle (row 3). Intent stages
 * (CAPTURE/TRIAGE/IDEATE/SPECIFY) are `intake`; execution stages
 * (DECOMPOSE/EXECUTE/VERIFY) are `execution`.
 */
export type DecisionStage = 'intake' | 'execution';

/**
 * The three — and only three — behaviors the ladder can produce (§5):
 * - `proceed-silently` — act with no trail (row 1).
 * - `proceed-with-trail` — act on the best default, then leave an
 *   `agent/assumption` trail (rows 3-proceed and 4).
 * - `stop-and-ask` — call `needsInput()` and block the loop (rows 0, 2, 3-ask).
 */
export type InvolvementBehavior = 'proceed-silently' | 'proceed-with-trail' | 'stop-and-ask';

/**
 * The ladder row that matched, top-down (first-match-wins). Exposed so callers
 * can audit, log, or branch on *why* a behavior was chosen.
 */
export enum CalibrationRow {
  /** Row 0 — a floor trigger fired. */
  Floor = 0,
  /** Row 1 — reversible + confident. */
  ReversibleConfident = 1,
  /** Row 2 — sticky + not-confident. */
  StickyNotConfident = 2,
  /** Row 3 — reversible + not-confident (the ambiguous middle, stage-routed). */
  AmbiguousMiddle = 3,
  /** Row 4 — sticky + confident. */
  StickyConfident = 4,
}

/**
 * A decision descriptor — the evidence-based facts about a single decision
 * point, fed to {@link resolveInvolvement}.
 */
export interface DecisionDescriptor {
  /**
   * Floor triggers present on this decision (§5, row 0). Any non-empty set
   * forces a `stop-and-ask`. Pass the specific triggers; an empty array (or
   * omission) means no floor trigger fired.
   */
  floorTriggers?: readonly FloorTrigger[];
  /** Whether the decision is cheap (`reversible`) or costly (`sticky`) to undo. */
  reversibility: Reversibility;
  /** Whether the answer is evidence-determined (`confident`) or a guess. */
  confidence: Confidence;
  /** Stage class, used only to route the ambiguous middle (row 3). */
  stage: DecisionStage;
}

/** The resolved outcome of walking the calibration ladder. */
export interface InvolvementDecision {
  /** Which of the three behaviors to take. */
  behavior: InvolvementBehavior;
  /** Whether this decision blocks the autonomous loop (true for `stop-and-ask`). */
  blocks: boolean;
  /** The ladder row that produced this decision (first match, top-down). */
  row: CalibrationRow;
  /**
   * Whether a durable `agent/assumption` trail should be written for this
   * decision. True exactly for `proceed-with-trail` behaviors when
   * `assumptionLog.artifact` is enabled — the non-obvious calls that must be
   * auditable at the review gate (§5).
   */
  logAssumption: boolean;
}

/**
 * Whether a floor trigger that the config's `alwaysAsk` list recognizes is
 * present on the decision. The config drives which tags are floor triggers, so
 * an operator can narrow the floor by trimming `alwaysAsk`.
 */
function hasActiveFloorTrigger(
  floorTriggers: readonly FloorTrigger[],
  alwaysAsk: Calibration['alwaysAsk']
): boolean {
  if (floorTriggers.length === 0) return false;
  const active = new Set<string>(alwaysAsk);
  return floorTriggers.some((trigger) => active.has(trigger));
}

/**
 * Build the resolved decision for a `proceed-with-trail` outcome, deciding
 * whether to write an assumption trail from the config's `assumptionLog`.
 */
function proceedWithTrail(row: CalibrationRow, calibration: Calibration): InvolvementDecision {
  return {
    behavior: 'proceed-with-trail',
    blocks: false,
    row,
    logAssumption: calibration.assumptionLog.artifact,
  };
}

/**
 * Walk the calibration ladder (§5) top-down and return the first matching
 * behavior — the canonical involvement decision for one decision point.
 *
 * The ladder is evaluated strictly in order; the first matching row wins:
 * - **Row 0 (floor)** — any active `alwaysAsk` trigger present → `stop-and-ask`
 *   (blocks), even at full confidence.
 * - **Row 1** — reversible + confident → `proceed-silently` (no block).
 * - **Row 2** — sticky + not-confident → `stop-and-ask` (blocks).
 * - **Row 3** — reversible + not-confident → routed by `stageBias`: `intake`
 *   (`ask`) → `stop-and-ask` (blocks); `execution` (`proceed-and-log`) →
 *   `proceed-with-trail` (no block).
 * - **Row 4** — sticky + confident → `proceed-with-trail` (announce, no block).
 *
 * Every threshold is read from `calibration`, so re-tuning involvement is a
 * config edit, never a code change. The `reversible`/`confident` membership of
 * `proceedSilentlyWhen` gates row 1; `alwaysAsk` defines the floor; `stageBias`
 * routes row 3; `assumptionLog.artifact` decides whether trail rows log.
 *
 * @param decision - The evidence-based facts about the decision point.
 * @param calibration - The resolved `involvement.calibration` config block.
 * @returns The behavior to take, whether it blocks the loop, the matched row,
 *   and whether to write an assumption trail.
 */
export function resolveInvolvement(
  decision: DecisionDescriptor,
  calibration: Calibration
): InvolvementDecision {
  const floorTriggers = decision.floorTriggers ?? [];

  // Row 0 — Floor. Highest precedence: a floor trigger stops the loop even at
  // full confidence on a reversible decision.
  if (hasActiveFloorTrigger(floorTriggers, calibration.alwaysAsk)) {
    return {
      behavior: 'stop-and-ask',
      blocks: true,
      row: CalibrationRow.Floor,
      logAssumption: false,
    };
  }

  const isReversible = decision.reversibility === 'reversible';
  const isConfident = decision.confidence === 'confident';

  // Row 1 — reversible + confident → proceed silently. Both axes must be in the
  // config's proceedSilentlyWhen allow-list to qualify for the silent path.
  const silentTags = new Set<string>(calibration.proceedSilentlyWhen);
  if (isReversible && isConfident && silentTags.has('reversible') && silentTags.has('confident')) {
    return {
      behavior: 'proceed-silently',
      blocks: false,
      row: CalibrationRow.ReversibleConfident,
      logAssumption: false,
    };
  }

  // Row 2 — sticky + not-confident → stop & ask.
  if (!isReversible && !isConfident) {
    return {
      behavior: 'stop-and-ask',
      blocks: true,
      row: CalibrationRow.StickyNotConfident,
      logAssumption: false,
    };
  }

  // Row 3 — reversible + not-confident (the ambiguous middle) → routed by stage
  // bias. The frozen spec is the cut line: intake asks, execution proceeds + logs.
  if (isReversible && !isConfident) {
    const bias = calibration.stageBias[decision.stage];
    if (bias === 'ask') {
      return {
        behavior: 'stop-and-ask',
        blocks: true,
        row: CalibrationRow.AmbiguousMiddle,
        logAssumption: false,
      };
    }
    return proceedWithTrail(CalibrationRow.AmbiguousMiddle, calibration);
  }

  // Row 4 — sticky + confident → proceed, but announce (leave a trail).
  return proceedWithTrail(CalibrationRow.StickyConfident, calibration);
}
