/**
 * The ladder (research §5c): free rules first, then the decision model a person
 * picked, then a frontier model, then a person or agent with authority.
 *
 * {@link runLadder} is pure logic over the bridges it is handed. It decides
 * nothing about what happens to the item: its {@link LadderOutcome} says what
 * the policy recommends, and the caller — in watch-only mode, nothing at all —
 * acts on it. That is also why the outcome can only ever narrow: there is no
 * field in it that grants anything.
 *
 * How one rung's answer is read, using the request's LEAST confident answer:
 *
 * - any answer naming a `serious` label at a confidence of at least
 *   `escalateBelow` → `person`: a person or agent with authority decides,
 *   however confident the model was. A serious label below `escalateBelow` is
 *   just an unsure answer and goes up a rung like any other, so a model that
 *   barely leans toward "threat" cannot by itself page a person;
 * - confidence at or above `actAbove` → `act` on this rung's answers;
 * - confidence below `escalateBelow` → go up one rung;
 * - in between → `review`: a PERSON decides, with this rung's answers as a
 *   hint, and the rungs above (the frontier model included) are skipped. The
 *   middle band is "a model leaned but not enough to act", and a costlier model
 *   leaning the same way would not change who has to look.
 *
 * A rung whose least confident answer is 0 (a failure or an abstention) always
 * goes up, whatever the thresholds. When every rung is unsure, or a rung's daily
 * call cap is reached, the policy's `whenUnsure` default applies. Rung 0 (rules)
 * is free and has no cap; a cap of 0 switches a rung off. When the caller's
 * signal has fired, the ladder stops before the next rung without calling it or
 * counting it against a cap.
 *
 * @module decisions/ladder
 */
import { createHash } from 'node:crypto';
import {
  DecisionPolicySchema,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionPolicy,
  type DecisionRequest,
  type DecisionResult,
} from '@dorkos/shared/decision-model';
import { unsureResult } from './answers.js';

/** The three rungs a model can stand on; rung 3 is a person. */
export type LadderRung = 0 | 1 | 2;

/** The bridges for each rung. Any may be absent; an absent rung is skipped. */
export interface LadderBridges {
  /** Rung 0: built-in rules. */
  rules?: DecisionModel;
  /** Rung 1: the decision model a person picked. */
  decision?: DecisionModel;
  /** Rung 2: a frontier model. */
  frontier?: DecisionModel;
}

/** What the ladder is asked to judge. The policy supplies the questions. */
export interface LadderRequest {
  /** The thing being judged. Kept in its own field, never pasted into the rules. */
  item: DecisionRequest['item'];
  /** Who sent it, recent history. */
  context?: DecisionRequest['context'];
}

/** Counts calls per use case, per rung, per UTC day, so a daily cap holds across calls. */
export interface DailyCallCounter {
  /** Calls already made today on this rung for this use case. */
  count(useCase: string, rung: 1 | 2, day: string): number;
  /** Record one more call. */
  increment(useCase: string, rung: 1 | 2, day: string): void;
}

/** Settings for {@link runLadder}. */
export interface LadderOptions {
  /**
   * Where daily call counts live. Required: a cap only holds if the counter
   * outlives one call, so the caller owns one per process (or a shared store).
   */
  counter: DailyCallCounter;
  /** Clock, for the UTC day key. Default `Date.now`. */
  now?: () => number;
  /** The caller's signal, passed to every bridge. */
  signal?: AbortSignal;
}

/** One rung the ladder reached. */
export type LadderStep =
  | {
      rung: LadderRung;
      modelId: string;
      result: DecisionResult;
      /** The least confident answer's confidence. */
      confidence: number;
    }
  | { rung: 1 | 2; modelId: string; skipped: 'cap-reached' };

/** What the policy recommends. */
export type LadderVerdict =
  | { kind: 'act'; rung: LadderRung; answers: Record<string, DecisionAnswer> }
  /** A person decides, with these answers as a hint; the rungs above were skipped. */
  | { kind: 'review'; rung: LadderRung; answers: Record<string, DecisionAnswer> }
  | { kind: 'person'; reason: 'serious'; rung: LadderRung; answers: Record<string, DecisionAnswer> }
  | {
      kind: 'unsure';
      whenUnsure: DecisionPolicy['whenUnsure'];
      reason: 'every-rung-unsure' | 'cap-reached' | 'no-rungs' | 'aborted';
    };

/** Everything one run of the ladder did, for the audit row. */
export interface LadderOutcome {
  /** The exact request each bridge saw. */
  request: DecisionRequest;
  /** One entry per rung reached, in order. */
  steps: LadderStep[];
  /** What the policy recommends. */
  verdict: LadderVerdict;
}

/**
 * A short, stable hash of a policy's rules and questions, so an audit row names
 * exactly what was asked and an old decision can be replayed against it.
 *
 * @param policy - The policy to hash.
 */
export function policyVersion(policy: Pick<DecisionPolicy, 'rules' | 'questions'>): string {
  const canonical = JSON.stringify({ rules: policy.rules, questions: sortKeys(policy.questions) });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Recursively sort object keys so the hash does not depend on insertion order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/** An in-memory {@link DailyCallCounter}. One per process is enough for a single server. */
export function createMemoryCallCounter(): DailyCallCounter {
  const counts = new Map<string, number>();
  const key = (useCase: string, rung: number, day: string) => `${day}\u0000${rung}\u0000${useCase}`;
  return {
    count: (useCase, rung, day) => counts.get(key(useCase, rung, day)) ?? 0,
    increment(useCase, rung, day) {
      const k = key(useCase, rung, day);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    },
  };
}

/** The least confident answer's confidence; 0 when there are none. */
function minConfidence(result: DecisionResult, req: DecisionRequest): number {
  let min = 1;
  for (const id of Object.keys(req.questions)) {
    const answer = result.answers[id];
    min = Math.min(min, answer ? answer.confidence : 0);
  }
  return Object.keys(req.questions).length === 0 ? 0 : min;
}

/** True when any answer names one of the policy's serious labels at a confidence of at least `floor`. */
function namesSerious(result: DecisionResult, serious: readonly string[], floor: number): boolean {
  return Object.values(result.answers).some(
    (a) =>
      typeof a.value === 'string' &&
      serious.includes(a.value) &&
      a.confidence > 0 &&
      a.confidence >= floor
  );
}

/**
 * Run one item up the ladder.
 *
 * Never throws for a bridge's sake: a bridge that throws anyway (breaking the
 * port's contract) counts as unsure on its rung.
 *
 * @throws When `policy` fails {@link DecisionPolicySchema} — thresholds out of
 *   order, or a `serious` label no choice question offers. That is a
 *   configuration mistake, and a silent pass would mean a serious label that can
 *   never fire.
 * @param policy - The use case's policy: questions, thresholds, caps.
 * @param bridges - The bridge for each rung; absent rungs are skipped.
 * @param request - The item and its context.
 * @param opts - See {@link LadderOptions}.
 */
export async function runLadder(
  policy: DecisionPolicy,
  bridges: LadderBridges,
  request: LadderRequest,
  opts: LadderOptions
): Promise<LadderOutcome> {
  DecisionPolicySchema.parse(policy);
  const req: DecisionRequest = {
    useCase: policy.useCase,
    policyVersion: policyVersion(policy),
    rules: policy.rules,
    item: request.item,
    ...(request.context !== undefined ? { context: request.context } : {}),
    questions: policy.questions,
  };
  const counter = opts.counter;
  const day = new Date((opts.now ?? Date.now)()).toISOString().slice(0, 10);
  const signal = opts.signal ?? new AbortController().signal;
  const steps: LadderStep[] = [];
  const rungs: Array<[LadderRung, DecisionModel | undefined]> = [
    [0, bridges.rules],
    [1, bridges.decision],
    [2, bridges.frontier],
  ];

  for (const [rung, model] of rungs) {
    if (!model) continue;
    if (signal.aborted) {
      return {
        request: req,
        steps,
        verdict: { kind: 'unsure', whenUnsure: policy.whenUnsure, reason: 'aborted' },
      };
    }
    if (rung !== 0) {
      const cap = rung === 1 ? policy.dailyCallCap.rung1 : policy.dailyCallCap.rung2;
      if (counter.count(policy.useCase, rung, day) >= cap) {
        steps.push({ rung, modelId: model.id, skipped: 'cap-reached' });
        // Past the cap the ladder stops calling models altogether.
        return {
          request: req,
          steps,
          verdict: { kind: 'unsure', whenUnsure: policy.whenUnsure, reason: 'cap-reached' },
        };
      }
      counter.increment(policy.useCase, rung, day);
    }

    let result: DecisionResult;
    try {
      result = await model.decide(req, signal);
    } catch {
      result = unsureResult(req, model.id, 'error');
    }
    const confidence = minConfidence(result, req);
    steps.push({ rung, modelId: model.id, result, confidence });

    if (namesSerious(result, policy.serious, policy.escalateBelow)) {
      return {
        request: req,
        steps,
        verdict: { kind: 'person', reason: 'serious', rung, answers: result.answers },
      };
    }
    // Confidence 0 is a failure or an abstention, never an answer to act on or
    // review, whatever the thresholds say (a policy may set either to 0).
    if (confidence === 0) continue;
    if (confidence >= policy.actAbove) {
      return { request: req, steps, verdict: { kind: 'act', rung, answers: result.answers } };
    }
    if (confidence >= policy.escalateBelow) {
      return { request: req, steps, verdict: { kind: 'review', rung, answers: result.answers } };
    }
  }

  return {
    request: req,
    steps,
    verdict: {
      kind: 'unsure',
      whenUnsure: policy.whenUnsure,
      reason: signal.aborted ? 'aborted' : steps.length === 0 ? 'no-rungs' : 'every-rung-unsure',
    },
  };
}
