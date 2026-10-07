/**
 * Helpers every bridge shares: reading a raw answer against the question it
 * answers, and building the "unsure" answer that stands in for every failure.
 *
 * @module decisions/answers
 */
import type {
  DecisionAnswer,
  DecisionFailure,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from '@dorkos/shared/decision-model';

/**
 * The answer that stands in for any failure: no value, confidence 0.
 *
 * @param failure - Why there is no answer. Omit for a rule that simply abstained.
 */
export function unsureAnswer(failure?: DecisionFailure): DecisionAnswer {
  return failure === undefined
    ? { value: null, confidence: 0 }
    : { value: null, confidence: 0, failure };
}

/**
 * A whole result in which every question is unsure for the same reason.
 *
 * @param req - The request being answered.
 * @param modelId - The model that would have answered.
 * @param failure - Why nothing was answered.
 * @param latencyMs - Time spent before giving up.
 */
export function unsureResult(
  req: DecisionRequest,
  modelId: string,
  failure: DecisionFailure,
  latencyMs = 0
): DecisionResult {
  const answers: Record<string, DecisionAnswer> = {};
  for (const id of Object.keys(req.questions)) answers[id] = unsureAnswer(failure);
  return { answers, modelId, latencyMs };
}

/**
 * Read one raw value against its question, or `undefined` when it is not a
 * value that question allows: a label nobody asked for, a score off the scale,
 * a yes/no that is not one.
 *
 * Accepts the forms models actually send: a `yesno` answer may arrive as
 * `"yes"`/`"no"` or `"true"`/`"false"`, and a `score` may arrive as a level's
 * index (number or numeric string) or as a level's exact text.
 *
 * @param question - The question the value answers.
 * @param raw - The value as the model sent it.
 */
export function readValue(
  question: DecisionQuestion,
  raw: unknown
): string | number | boolean | undefined {
  switch (question.kind) {
    case 'choice':
      return typeof raw === 'string' && Object.hasOwn(question.labels, raw) ? raw : undefined;
    case 'score': {
      let n: number | undefined;
      if (typeof raw === 'number') n = raw;
      else if (typeof raw === 'string') {
        const levelIndex = question.levels.indexOf(raw);
        n = levelIndex >= 0 ? levelIndex : raw.trim() === '' ? undefined : Number(raw);
      }
      if (n === undefined || !Number.isFinite(n)) return undefined;
      return n >= 0 && n <= question.levels.length - 1 ? n : undefined;
    }
    case 'yesno':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'yes' || raw === 'true') return true;
      if (raw === 'no' || raw === 'false') return false;
      return undefined;
  }
}

/**
 * Clamp a number into [0, 1], treating anything not finite as 0 so a garbled
 * confidence can only ever make an answer less trusted, never more.
 *
 * @param n - The number to clamp.
 */
export function clamp01(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Confidence for a yes/no answer from the probability of "yes": the distance of
 * that probability from 0.5, doubled. 0.5 is a coin toss (confidence 0); 0 or 1
 * is certain (confidence 1).
 *
 * @param pYes - The probability of "yes", 0..1.
 */
export function yesNoConfidence(pYes: number): number {
  return clamp01(Math.abs(clamp01(pYes) - 0.5) * 2);
}
