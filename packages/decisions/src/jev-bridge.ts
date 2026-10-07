/**
 * The Jev bridge (research §5b, bridge 3): TypeSafe's decision model through its
 * System One endpoint, reached through OpenRouter today (`/api/v1/systemone`)
 * or TypeSafe directly later — only the base URL and model id change.
 *
 * **The wire format** is Jev's own, not the chat format (research §1). A request
 * carries `model`, the item as `state`, and named `questions`; each question has
 * a `type` (`choice`, `score` or `noul`, Jev's yes/no) and `instructions`, plus
 * `criteria` (label to description) for a choice and `levels` for a score. The
 * reply carries `answers`, one entry per question, and `usage.input_tokens`.
 *
 * The research names the answer's parts (the pick, a probability per option, a
 * confidence; a single probability for yes/no) but not every field name, so the
 * reader below accepts the plausible spellings and pins the ones it chose in
 * `__tests__/jev-bridge.test.ts`. Anything it cannot read is confidence 0.
 *
 * **Confidence.** A choice or score answer carries Jev's own confidence; when it
 * is missing the bridge uses the chosen option's probability. A yes/no answer
 * carries only the probability of "yes", so the bridge derives one: the
 * distance of that probability from 0.5, doubled.
 *
 * **The item stays in its own field.** It goes in `state`; the use case's rules
 * go into each question's instructions. Jev has no third place to put them.
 *
 * The key is passed in by the caller. This module never reads the environment.
 *
 * @module decisions/jev-bridge
 */
import type {
  DecisionAnswer,
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from '@dorkos/shared/decision-model';
import { clamp01, readValue, unsureAnswer, unsureResult, yesNoConfidence } from './answers.js';
import { withCircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { isRecord, postJson, type FetchLike } from './http.js';

/** OpenRouter's API root, where Jev is offered with no waitlist. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/** The pinned Jev model id on OpenRouter. Pin, so an audit row names the exact version. */
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';

/** Settings for {@link createJevModel}. */
export interface JevModelOptions {
  /** API root; the bridge posts to `<baseUrl>/systemone`. Default {@link OPENROUTER_API_BASE}. */
  baseUrl?: string;
  /** Model id. Default {@link DEFAULT_JEV_MODEL}. */
  model?: string;
  /** Bearer key. Passed in; never read from the environment. */
  apiKey: string;
  /** The fetch to call. Injected so tests never touch the network. */
  fetch: FetchLike;
  /** Give up after this many milliseconds. Default 5000 (Jev answers in well under a second). */
  timeoutMs?: number;
  /** Cost of one call in millionths of a dollar, from its input tokens, when known. */
  costMicroUsd?: (inputTokens: number) => number;
  /** Circuit breaker settings, or `false` to call through every time. */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** Override the bridge id. Default `jev:<model>`. */
  id?: string;
}

/** One question in Jev's format. Rules, when present, lead the instructions. */
function toJevQuestion(
  question: DecisionQuestion,
  rules: string | undefined
): Record<string, unknown> {
  const lead = rules ? `${rules}\n\n` : '';
  switch (question.kind) {
    case 'choice':
      return {
        type: 'choice',
        instructions: lead + question.instructions,
        criteria: question.labels,
      };
    case 'score':
      return { type: 'score', instructions: lead + question.instructions, levels: question.levels };
    case 'yesno': {
      const meaning = [
        question.yes ? `Yes means: ${question.yes}` : '',
        question.no ? `No means: ${question.no}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        type: 'noul',
        instructions: lead + question.instructions + (meaning ? `\n${meaning}` : ''),
      };
    }
  }
}

/** The item, plus its context when there is one, as Jev's `state`. */
function toState(req: DecisionRequest): unknown {
  return req.context === undefined ? req.item : { item: req.item, context: req.context };
}

/** Probabilities, kept only when every entry is a number. */
function readProbabilities(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out[k] = clamp01(v);
  }
  return out;
}

/** Read one of Jev's answers against its question. */
function readJevAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) return unsureAnswer('invalid-answer');
  const probabilities = readProbabilities(raw.probabilities);

  if (question.kind === 'yesno') {
    const p = raw.probability ?? raw.value;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      return unsureAnswer(typeof p === 'boolean' ? 'invalid-answer' : 'unknown-label');
    }
    return {
      value: p >= 0.5,
      confidence: yesNoConfidence(p),
      probabilities: { true: p, false: 1 - p },
    };
  }

  const picked = question.kind === 'choice' ? (raw.choice ?? raw.value) : (raw.score ?? raw.value);
  if (picked === undefined) return unsureAnswer('invalid-answer');
  const value = readValue(question, picked);
  if (value === undefined) return unsureAnswer('unknown-label');
  const ownConfidence = typeof raw.confidence === 'number' ? clamp01(raw.confidence) : undefined;
  const confidence = ownConfidence ?? clamp01(probabilities?.[String(picked)]);
  return { value, confidence, ...(probabilities ? { probabilities } : {}) };
}

/**
 * Build a Jev bridge, wrapped in a circuit breaker unless `circuitBreaker: false`.
 *
 * @param opts - See {@link JevModelOptions}.
 */
export function createJevModel(opts: JevModelOptions): DecisionModel {
  const model = opts.model ?? DEFAULT_JEV_MODEL;
  const id = opts.id ?? `jev:${model}`;
  const url = `${(opts.baseUrl ?? OPENROUTER_API_BASE).replace(/\/+$/, '')}/systemone`;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const bridge: DecisionModel = {
    id,
    capabilities: {
      kinds: ['choice', 'score', 'yesno'],
      customRules: true,
      reasons: false,
      // Calibration is TypeSafe's claim; nobody outside has shown it yet (research §1).
      calibrated: false,
      runsLocally: false,
      maxInputTokens: 32_000,
    },
    async decide(req, signal): Promise<DecisionResult> {
      const started = performance.now();
      const questions: Record<string, unknown> = {};
      for (const [qid, q] of Object.entries(req.questions))
        questions[qid] = toJevQuestion(q, req.rules);
      const outcome = await postJson({
        fetch: opts.fetch,
        url,
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: { model, state: toState(req), questions },
        timeoutMs,
        signal,
      });
      const elapsed = () => performance.now() - started;
      if (!outcome.ok) return unsureResult(req, model, outcome.failure, elapsed());
      const body = outcome.body;
      if (isRecord(body) && (body.refusal !== undefined || body.error !== undefined)) {
        return unsureResult(
          req,
          model,
          body.refusal !== undefined ? 'refused' : 'outage',
          elapsed()
        );
      }
      if (!isRecord(body) || !isRecord(body.answers)) {
        return unsureResult(req, model, 'invalid-answer', elapsed());
      }
      const raw = body.answers;
      const answers: Record<string, DecisionAnswer> = {};
      for (const [qid, q] of Object.entries(req.questions)) {
        answers[qid] = Object.hasOwn(raw, qid)
          ? readJevAnswer(q, raw[qid])
          : unsureAnswer('invalid-answer');
      }
      const result: DecisionResult = {
        answers,
        modelId: typeof body.model === 'string' && body.model.length > 0 ? body.model : model,
        latencyMs: elapsed(),
      };
      const usage = isRecord(body.usage) ? body.usage : undefined;
      if (opts.costMicroUsd && usage && typeof usage.input_tokens === 'number') {
        result.costMicroUsd = opts.costMicroUsd(usage.input_tokens);
      }
      return result;
    },
  };
  return opts.circuitBreaker === false ? bridge : withCircuitBreaker(bridge, opts.circuitBreaker);
}
