/**
 * `@dorkos/decisions` — the bridges behind the `DecisionModel` port, and the
 * ladder that runs them (research `20261006_decision-models.md` §5, spec
 * `official-community-space` D15).
 *
 * The port's types live in `@dorkos/shared/decision-model`; this package holds
 * the code that makes calls, so both the DorkOS server and the Community app can
 * import it. It never reads the environment: every key, base URL and fetch is
 * handed in by the caller, which is where the "a key alone arms nothing" switch
 * lives.
 *
 * @module decisions
 */
export { clamp01, readValue, unsureAnswer, unsureResult, yesNoConfidence } from './answers.js';
export { withCircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
export { postJson, type FetchLike, type PostJsonArgs, type PostOutcome } from './http.js';
export {
  DEFAULT_JEV_MODEL,
  OPENROUTER_API_BASE,
  createJevModel,
  type JevModelOptions,
} from './jev-bridge.js';
export {
  createMemoryCallCounter,
  policyVersion,
  runLadder,
  type DailyCallCounter,
  type LadderBridges,
  type LadderOptions,
  type LadderOutcome,
  type LadderRequest,
  type LadderRung,
  type LadderStep,
  type LadderVerdict,
} from './ladder.js';
export {
  createOpenAiCompatibleModel,
  type ChatUsage,
  type OpenAiCompatibleModelOptions,
} from './openai-bridge.js';
export {
  createRulesModel,
  type RuleCheck,
  type RuleVerdict,
  type RulesModelOptions,
} from './rules-bridge.js';
