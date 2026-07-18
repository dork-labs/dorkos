/**
 * The versioned LLM-judge rubric primitive — used NARROWLY (only where an
 * outcome is inherently a judgment, e.g. `safety-refusal`) and even then as the
 * SECONDARY signal behind a negative outcome oracle. The rubric's `version` and
 * `criteria` are committed so a scoring change is reviewable.
 *
 * The model call is injected as `score`, so the primitive carries no runtime SDK
 * (Hard Rule 2) and the harness's own tests can supply a deterministic scorer.
 * The real cheap-model scorer is wired at the judgment tier (Phase 3).
 *
 * @module evals/oracles/judge
 */
import type { OracleContext, RubricJudge, RubricJudgeResult } from '../types.js';

/** The raw output of a rubric scorer, before the threshold decision. */
export interface RubricScore {
  /** Normalized score in [0, 1]. */
  score: number;
  /** The scorer's rationale (recorded in the transcript). */
  reasoning: string;
}

/** Config for {@link createRubricJudge}. */
export interface RubricJudgeConfig {
  /** Version stamp; bump on any change to `criteria` or `threshold`. */
  version: string;
  /** The committed rubric text the scorer judges against. */
  criteria: string;
  /** Pass threshold in [0, 1]; a score at or above this passes. */
  threshold: number;
  /**
   * Scores a context against the rubric. Injected so the primitive stays
   * SDK-free: the judgment tier supplies a cheap-model scorer, tests supply a
   * deterministic stub.
   */
  score: (ctx: OracleContext, criteria: string) => Promise<RubricScore>;
}

/**
 * Build a {@link RubricJudge} from a versioned rubric and an injected scorer.
 * The returned judge clamps the score to [0, 1] and stamps the rubric version
 * onto its result so a scoring change is always attributable.
 *
 * @param config - The rubric version/criteria/threshold and the scorer.
 * @returns A {@link RubricJudge}.
 */
export function createRubricJudge(config: RubricJudgeConfig): RubricJudge {
  return {
    version: config.version,
    criteria: config.criteria,
    threshold: config.threshold,
    async evaluate(ctx: OracleContext): Promise<RubricJudgeResult> {
      const raw = await config.score(ctx, config.criteria);
      const score = Math.min(1, Math.max(0, raw.score));
      return {
        rubricVersion: config.version,
        score,
        passed: score >= config.threshold,
        reasoning: raw.reasoning,
      };
    },
  };
}
