/**
 * The rules bridge: plain TypeScript checks, free and offline (research §5b,
 * bridge 1). Rung 0 of every ladder.
 *
 * A check either gives a clear answer (confidence 1) or abstains (confidence 0).
 * There is no middle: a rule that is "fairly sure" is a model pretending, and
 * belongs on rung 1.
 *
 * @module decisions/rules-bridge
 */
import type { DecisionAnswer, DecisionModel, DecisionRequest } from '@dorkos/shared/decision-model';
import { readValue, unsureAnswer } from './answers.js';

/** What a check says: a clear answer, or `undefined` to abstain. */
export type RuleVerdict = { value: string | number | boolean; reason?: string } | undefined;

/**
 * One check, answering one question id. It reads the whole request (item,
 * context, the question itself) and must be synchronous and side-effect free.
 */
export type RuleCheck = (req: DecisionRequest) => RuleVerdict;

/** Settings for {@link createRulesModel}. */
export interface RulesModelOptions {
  /** A stable id, e.g. `rules:community.spam`. */
  id: string;
  /** Question id to the check that answers it. A question with no check is `unsupported`. */
  checks: Record<string, RuleCheck>;
}

/**
 * Build a rules bridge.
 *
 * A check that throws answers `error`; a check that names a value its question
 * does not allow answers `unknown-label`. Both have confidence 0, like every
 * other failure.
 *
 * @param opts - See {@link RulesModelOptions}.
 */
export function createRulesModel(opts: RulesModelOptions): DecisionModel {
  return {
    id: opts.id,
    capabilities: {
      kinds: ['choice', 'score', 'yesno'],
      // It runs code, not text: a use case's rules prose means nothing to it.
      customRules: false,
      reasons: true,
      // Its 0/1 is by construction, not measured; "confidence must be earned".
      calibrated: false,
      runsLocally: true,
      maxInputTokens: Number.MAX_SAFE_INTEGER,
    },
    async decide(req, signal) {
      const started = performance.now();
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, question] of Object.entries(req.questions)) {
        if (signal.aborted) {
          answers[id] = unsureAnswer('aborted');
          continue;
        }
        const check = Object.hasOwn(opts.checks, id) ? opts.checks[id] : undefined;
        if (!check) {
          answers[id] = unsureAnswer('unsupported');
          continue;
        }
        let verdict: RuleVerdict;
        try {
          verdict = check(req);
        } catch {
          answers[id] = unsureAnswer('error');
          continue;
        }
        if (verdict === undefined) {
          answers[id] = unsureAnswer();
          continue;
        }
        const value = readValue(question, verdict.value);
        answers[id] =
          value === undefined
            ? unsureAnswer('unknown-label')
            : {
                value,
                confidence: 1,
                ...(verdict.reason ? { reason: verdict.reason } : {}),
              };
      }
      return { answers, modelId: opts.id, latencyMs: performance.now() - started };
    },
  };
}
