/**
 * Core eval-harness types: the eval-case contract, its runtime/cost taxonomy,
 * the oracle function shape, and the machine-readable result schemas that feed
 * `results.json` and the transcript writer.
 *
 * Data-shaped types (`RuntimeTier`, `CostClass`, `OracleResult`, `EvalResult`,
 * `RunSummary`) are Zod-backed so a hand-written fixture or a `results.json`
 * on disk can be parsed and validated — stringly-typed code is banned
 * (Hard Rule). The behavioral pieces that hold functions (`Oracle`,
 * `RubricJudge`, and therefore `EvalCase`) are TypeScript interfaces layered
 * over the Zod-validated metadata.
 *
 * @module evals/types
 */
import { z } from 'zod';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { UiActionRequest } from '@dorkos/shared/schemas';

/**
 * Which backend an eval runs against.
 * - `test-mode`: the in-process deterministic runtime (no model, free).
 * - `claude-code-cheap`: real `claude-code` on a cheap (Haiku-class) model —
 *   the judgment tier that exercises tool-choice-from-natural-language.
 * - `real-provider`: real external providers (weekly deep tier).
 */
export const RuntimeTierSchema = z.enum(['test-mode', 'claude-code-cheap', 'real-provider']);

/** Inferred type for {@link RuntimeTierSchema}. */
export type RuntimeTier = z.infer<typeof RuntimeTierSchema>;

/** Rough cost envelope, used for budget planning and tier selection. */
export const CostClassSchema = z.enum(['free', 'cheap', 'standard', 'deep']);

/** Inferred type for {@link CostClassSchema}. */
export type CostClass = z.infer<typeof CostClassSchema>;

/**
 * Suite membership. `smoke` is the cheap, label-gated PR subset; `core` is the
 * nightly-full product suite; `connector` is the (quarantined until W5)
 * connector-routing subset.
 */
export const EvalTagSchema = z.enum(['smoke', 'core', 'connector']);

/** Inferred type for {@link EvalTagSchema}. */
export type EvalTag = z.infer<typeof EvalTagSchema>;

/** The isolated sandbox an eval runs inside: a fresh project cwd + `DORK_HOME`. */
export interface EvalSandbox {
  /** Fresh temporary project working directory the turn runs in. */
  projectCwd: string;
  /** Fresh temporary `DORK_HOME` the runtime and oracles read/write. */
  dorkHome: string;
}

/**
 * Everything an oracle needs to assert an outcome: the sandbox filesystem, the
 * running server's base URL, the driven session id, and every SSE frame the
 * drive loop collected. An oracle reads the sandbox, calls the API, or inspects
 * the collected stream — it never reads the assistant's prose.
 */
export interface OracleContext {
  /** The isolated sandbox (project cwd + `DORK_HOME`) the eval ran in. */
  sandbox: EvalSandbox;
  /** Base URL of the running harness server (e.g. `http://127.0.0.1:53511`). */
  baseUrl: string;
  /** The session id the prompt was driven against. */
  sessionId: string;
  /** Every SSE frame collected off `GET /api/sessions/:id/events`, in order. */
  frames: SseFrame[];
}

/** The result of one oracle: whether the intended side effect occurred, with evidence. */
export const OracleResultSchema = z.object({
  /** Human-readable label for what this oracle checked (e.g. `install-metadata exists`). */
  label: z.string(),
  /** True iff the intended side effect occurred. */
  passed: z.boolean(),
  /**
   * The concrete evidence: the asserted path, the HTTP response, the matched
   * tool frame — whatever proves (or disproves) the outcome. Kept as `unknown`
   * so any oracle can attach its own evidence shape to the transcript.
   */
  evidence: z.unknown().optional(),
  /** One-line detail on a failure (why the side effect was not observed). */
  detail: z.string().optional(),
});

/** Inferred type for {@link OracleResultSchema}. */
export type OracleResult = z.infer<typeof OracleResultSchema>;

/**
 * An outcome check: resolves `passed: true` iff the intended side effect
 * occurred. Asserts API / filesystem / stream state, never prose.
 */
export type Oracle = (ctx: OracleContext) => Promise<OracleResult>;

/** The result of a rubric judge: a normalized score and its pass decision. */
export const RubricJudgeResultSchema = z.object({
  /** Version stamp of the rubric that produced this score (a scoring change is reviewable). */
  rubricVersion: z.string(),
  /** Normalized score in [0, 1]. */
  score: z.number().min(0).max(1),
  /** True iff `score` cleared the rubric's threshold. */
  passed: z.boolean(),
  /** The judge's one-paragraph rationale, for the transcript. */
  reasoning: z.string(),
});

/** Inferred type for {@link RubricJudgeResultSchema}. */
export type RubricJudgeResult = z.infer<typeof RubricJudgeResultSchema>;

/**
 * A versioned LLM-judge rubric, used ONLY where the outcome is inherently a
 * judgment (e.g. `safety-refusal`) and even then as the SECONDARY signal behind
 * a negative outcome oracle. The `version` + `criteria` are committed so a
 * scoring change is reviewable.
 */
export interface RubricJudge {
  /** Version stamp for the rubric (bump on any criteria/threshold change). */
  version: string;
  /** The committed rubric text the judge scores against. */
  criteria: string;
  /** Pass threshold in [0, 1]; a score at or above this passes. */
  threshold: number;
  /** Score this context against the rubric. */
  evaluate: (ctx: OracleContext) => Promise<RubricJudgeResult>;
}

/**
 * Serializable metadata for an eval case — everything except the oracle/rubric
 * functions. Zod-backed so a hand-written or on-disk case manifest validates.
 */
export const EvalCaseMetaSchema = z.object({
  /** Stable id, e.g. `marketplace-install`. */
  id: z.string().min(1),
  /** One-line intent. */
  title: z.string().min(1),
  /**
   * The natural-language prompt(s) sent to the session. An empty string marks a
   * structural (boot-only) case that asserts server/sandbox state without
   * driving a turn — the Phase 1 in-process harness registers no runtime, so a
   * real turn belongs to the credentialed tiers (Phase 2+).
   */
  prompt: z.union([z.string(), z.array(z.string())]),
  /** Backend tier. */
  runtimeTier: RuntimeTierSchema,
  /** Cost envelope. */
  costClass: CostClassSchema,
  /** Suite membership; `smoke` is the label-gated PR subset. */
  tags: z.array(EvalTagSchema),
  /** When true, the eval runs and reports but never gates (flake/quarantine, W5). */
  quarantined: z.boolean().optional(),
  /** Per-eval cost ceiling in USD; a single turn exceeding this fails the eval. */
  perEvalCeilingUsd: z.number().nonnegative().optional(),
});

/** Inferred type for {@link EvalCaseMetaSchema}. */
export type EvalCaseMeta = z.infer<typeof EvalCaseMetaSchema>;

/**
 * A full eval case: the Zod-validated {@link EvalCaseMeta} plus the oracle
 * function(s) that assert the outcome and an optional rubric judge. ALL oracles
 * must pass (and the rubric, when present, must clear its threshold) for the
 * eval to pass.
 */
export interface EvalCase extends EvalCaseMeta {
  /** The outcome oracle(s) — ALL must pass. Asserts API/FS/stream state, never prose. */
  oracles: Oracle[];
  /** Optional rubric judge, only where the outcome is inherently a judgment. */
  rubric?: RubricJudge;
  /**
   * Optional widget action driven AFTER the prompt(s) establish the session —
   * the `widget-round-trip` structural eval's mechanism. When set, the runner
   * drives the prompt(s) to create the session, then POSTs this action to
   * `/api/sessions/:id/ui-action` (a fresh turn, runtime-agnostic, so it runs on
   * `test-mode` with no model), collecting the resulting turn. The oracle then
   * asserts the injected `<ui_action>` trigger content on the collected stream.
   */
  widgetAction?: UiActionRequest;
}

/**
 * Terminal status of one eval run:
 * - `pass` — every oracle passed (and the rubric cleared its threshold).
 * - `fail` — an oracle failed, or the rubric fell below threshold.
 * - `error` — a runner/infra error (a `409 SESSION_LOCKED`, a boot timeout, a
 *   thrown exception) distinct from a product regression.
 * - `skipped-over-budget` — the per-run budget cap was hit before this eval ran.
 */
export const EvalStatusSchema = z.enum(['pass', 'fail', 'error', 'skipped-over-budget']);

/** Inferred type for {@link EvalStatusSchema}. */
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

/** Machine-readable result for one eval, written into `results.json`. */
export const EvalResultSchema = z.object({
  /** The eval's stable id. */
  id: z.string(),
  /** The eval's one-line title. */
  title: z.string(),
  /** Terminal status. */
  status: EvalStatusSchema,
  /** The tier this eval ran on. */
  runtimeTier: RuntimeTierSchema,
  /** The eval's cost class. */
  costClass: CostClassSchema,
  /** Cumulative USD cost the runtime reported for this eval (0 for `test-mode`). */
  costUsd: z.number().nonnegative(),
  /** Wall-clock duration in milliseconds. */
  durationMs: z.number().nonnegative(),
  /** Per-oracle results with their evidence. */
  oracleResults: z.array(OracleResultSchema),
  /** The rubric judge's result, when the eval carried a rubric. */
  rubricResult: RubricJudgeResultSchema.optional(),
  /**
   * True when the eval is quarantined: it still runs and reports but never gates
   * (the landing state for flaky evals and the connector evals until W5).
   */
  quarantined: z.boolean().default(false),
  /** True when the eval was retried once (flake policy) before this result. */
  retried: z.boolean().default(false),
  /** Runner/infra error message when `status` is `error`. */
  error: z.string().optional(),
  /** Path to this eval's JSONL transcript, relative to the run directory. */
  transcript: z.string().optional(),
});

/** Inferred type for {@link EvalResultSchema}. */
export type EvalResult = z.infer<typeof EvalResultSchema>;

/** The top-level machine-readable run report (`results.json`). */
export const RunSummarySchema = z.object({
  /** Unique id for this run (also the transcript directory name). */
  runId: z.string(),
  /** ISO timestamp the run started. */
  startedAt: z.string(),
  /** The tier the run was launched on. */
  tier: RuntimeTierSchema,
  /** The per-run budget cap in USD. */
  budgetUsd: z.number().nonnegative(),
  /** Total USD cost accumulated across every eval in the run. */
  totalCostUsd: z.number().nonnegative(),
  /** Per-eval results. */
  results: z.array(EvalResultSchema),
});

/** Inferred type for {@link RunSummarySchema}. */
export type RunSummary = z.infer<typeof RunSummarySchema>;
