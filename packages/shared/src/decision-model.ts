/**
 * The `DecisionModel` port — one contract for answering a small, typed question
 * about one item: "is this post spam?", "which of these rules does it break?",
 * "does this conversation look stuck?". Built-in rules, a chat model asked for a
 * forced JSON answer, and decision models such as Jev all answer through it, so
 * a use case never knows which one it is talking to.
 *
 * The design is `research/20261006_decision-models.md` §5, and decision D15 of
 * `specs/official-community-space/02-specification.md`. The bridges (which make
 * network calls) live in `@dorkos/decisions`; this module holds schemas and
 * types only, so the server and the Community app can both import it with no
 * network code attached.
 *
 * Four rules hold for every bridge:
 *
 * 1. **Three question kinds, nothing else.** `choice` (pick one label), `score`
 *    (place the item on an ordered scale) and `yesno`. They cover every use case
 *    in the research, and every model family can be bent to fit them.
 * 2. **Failure is just "unsure".** A timeout, an outage, a refusal, or an answer
 *    naming a label nobody asked for all come back as an answer with
 *    `confidence: 0` and `value: null`. {@link DecisionModel.decide} never
 *    rejects; the use case's "when unsure" default then applies.
 * 3. **A decision can only narrow, never widen.** A result may hide, hold, tag
 *    or suggest. It never reaches a permission or tool check — a stranger who
 *    talks a model into a confident answer gets nothing a stranger would not
 *    already get. `scripts/__tests__/decision-narrow-only.test.ts` pins this.
 * 4. **The item travels in its own field.** It is never pasted into the rules
 *    or the instructions, because the item is the part a hostile sender writes.
 *
 * @module shared/decision-model
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Questions
// ---------------------------------------------------------------------------

/** The three question kinds every bridge speaks. */
export const DECISION_QUESTION_KINDS = ['choice', 'score', 'yesno'] as const;

/** One of {@link DECISION_QUESTION_KINDS}. */
export type DecisionQuestionKind = (typeof DECISION_QUESTION_KINDS)[number];

/**
 * Pick exactly one label. Label names should be short, neutral codes (`a1`,
 * `b2`): models of Jev's kind follow an option's NAME more than its description,
 * so a name like `spam` leaks an answer into the question.
 */
export const ChoiceQuestionSchema = z.object({
  kind: z.literal('choice'),
  /** What to decide, in plain words. */
  instructions: z.string().min(1),
  /** Label code to description. At least two, at most 255 (Jev's ceiling). */
  labels: z.record(z.string().min(1), z.string()).refine(
    (labels) => {
      const n = Object.keys(labels).length;
      return n >= 2 && n <= 255;
    },
    { message: 'A choice question needs between 2 and 255 labels' }
  ),
});

/**
 * Place the item on an ordered scale of 2 to 10 levels, lowest first. The
 * answer is a level INDEX, and may fall between two levels (a model that
 * returns a probability per level reports their weighted mean).
 */
export const ScoreQuestionSchema = z.object({
  kind: z.literal('score'),
  /** What to score, in plain words. */
  instructions: z.string().min(1),
  /** Level descriptions, lowest first. */
  levels: z.array(z.string().min(1)).min(2).max(10),
});

/** A yes or no question. `yes` and `no` optionally say what each answer means. */
export const YesNoQuestionSchema = z.object({
  kind: z.literal('yesno'),
  /** The question, in plain words. */
  instructions: z.string().min(1),
  /** What a "yes" means, when it needs saying. */
  yes: z.string().optional(),
  /** What a "no" means, when it needs saying. */
  no: z.string().optional(),
});

/** One question to answer about one item. */
export const DecisionQuestionSchema = z.discriminatedUnion('kind', [
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  YesNoQuestionSchema,
]);
/** One question to answer about one item. See {@link DecisionQuestionSchema}. */
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;

/** Question id to question. At least one. */
export const DecisionQuestionsSchema = z
  .record(z.string().min(1), DecisionQuestionSchema)
  .refine((questions) => Object.keys(questions).length > 0, {
    message: 'At least one question is required',
  });

// ---------------------------------------------------------------------------
// 2. Requests and answers
// ---------------------------------------------------------------------------

/** The thing being judged, or its context: plain text or a JSON object. */
const DecisionPayloadSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

/** One call: one item, one or more questions about it. */
export const DecisionRequestSchema = z.object({
  /** Which use case is asking, e.g. `community.spam` or `loop.stuck`. */
  useCase: z.string().min(1),
  /** A hash of the rules and questions, so an audit row names exactly what was asked. */
  policyVersion: z.string().min(1),
  /**
   * The plain-words policy text a model reads, when the use case has one.
   * Never contains the item.
   */
  rules: z.string().optional(),
  /** The thing being judged. Kept in its own field, never pasted into the rules. */
  item: DecisionPayloadSchema,
  /** Who sent it, recent history, anything else the judge may weigh. */
  context: DecisionPayloadSchema.optional(),
  /** Question id to question. */
  questions: DecisionQuestionsSchema,
});
/** One call: one item, one or more questions about it. */
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/**
 * Why an answer is unsure when a bridge could not produce a real one. Every one
 * of these comes with `confidence: 0` and `value: null`.
 *
 * - `timeout` — the bridge's own time limit passed.
 * - `aborted` — the caller's signal fired.
 * - `outage` — the service could not be reached or answered with an error.
 * - `refused` — the model declined to answer.
 * - `unknown-label` — the answer named a label (or value) nobody asked for.
 * - `invalid-answer` — the answer could not be read at all.
 * - `unsupported` — this bridge cannot answer this kind of question.
 * - `circuit-open` — the bridge failed several times in a row and is resting.
 * - `error` — a built-in check threw.
 */
export const DECISION_FAILURES = [
  'timeout',
  'aborted',
  'outage',
  'refused',
  'unknown-label',
  'invalid-answer',
  'unsupported',
  'circuit-open',
  'error',
] as const;

/** One of {@link DECISION_FAILURES}. */
export type DecisionFailure = (typeof DECISION_FAILURES)[number];

/**
 * The answer to one question.
 *
 * `value` is a label code for `choice`, a level index for `score` and a boolean
 * for `yesno`. `null` means no answer at all — an abstaining rule or a failure —
 * and always comes with `confidence: 0`.
 */
export const DecisionAnswerSchema = z
  .object({
    /** The answer, or `null` when there is none. */
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    /** Probability per label (or per level index, or `true`/`false`), when the model gives them. */
    probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
    /** How sure, from 0 to 1. Only trusted once our own test set shows it means what it says. */
    confidence: z.number().min(0).max(1),
    /** A short reason, only from models that can write one. */
    reason: z.string().optional(),
    /** Why there is no real answer, when there is not. */
    failure: z.enum(DECISION_FAILURES).optional(),
  })
  .refine((answer) => answer.value !== null || answer.confidence === 0, {
    message: 'An answer with no value must have confidence 0',
  })
  .refine((answer) => answer.failure === undefined || answer.confidence === 0, {
    message: 'A failed answer must have confidence 0',
  });
/** The answer to one question. See {@link DecisionAnswerSchema}. */
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

/** What one bridge said about one request. */
export const DecisionResultSchema = z.object({
  /** Question id to answer. Every asked question has exactly one entry. */
  answers: z.record(z.string().min(1), DecisionAnswerSchema),
  /** The pinned model that answered, e.g. `typesafe/jev-1.13`. */
  modelId: z.string().min(1),
  /** Wall time the call took. */
  latencyMs: z.number().min(0),
  /** What the call cost, in millionths of a US dollar, when known. */
  costMicroUsd: z.number().min(0).optional(),
});
/** What one bridge said about one request. */
export type DecisionResult = z.infer<typeof DecisionResultSchema>;

// ---------------------------------------------------------------------------
// 3. The port
// ---------------------------------------------------------------------------

/** What a bridge can do, declared up front so a picker can say so plainly. */
export const DecisionModelCapabilitiesSchema = z.object({
  /** The question kinds this bridge answers. Any other kind comes back `unsupported`. */
  kinds: z.array(z.enum(DECISION_QUESTION_KINDS)).min(1),
  /** Whether it reads a use case's own rules text (false for fixed-list moderation APIs). */
  customRules: z.boolean(),
  /** Whether it can write a reason. */
  reasons: z.boolean(),
  /** True only where the vendor shows evidence, or our own evals do. */
  calibrated: z.boolean(),
  /** Nothing leaves the computer. */
  runsLocally: z.boolean(),
  /** The largest input it accepts, in tokens. */
  maxInputTokens: z.number().int().positive(),
});
/** What a bridge can do. See {@link DecisionModelCapabilitiesSchema}. */
export type DecisionModelCapabilities = z.infer<typeof DecisionModelCapabilitiesSchema>;

/**
 * One bridge to one decision maker.
 *
 * `decide` never rejects and never throws: every failure is an answer with
 * `confidence: 0` (see {@link DECISION_FAILURES}). It answers every question in
 * the request, and stops promptly when `signal` aborts.
 */
export interface DecisionModel {
  /** A stable id for this bridge and model, e.g. `jev:typesafe/jev-1.13`. */
  readonly id: string;
  /** What this bridge can do. */
  readonly capabilities: DecisionModelCapabilities;
  /** Answer every question in `req` about its item. */
  decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}

// ---------------------------------------------------------------------------
// 4. Policy
// ---------------------------------------------------------------------------

/**
 * One use case's policy: the questions, and the thresholds that decide what the
 * ladder does with each answer (research §5c).
 */
export const DecisionPolicySchema = z
  .object({
    /** Which use case this is, e.g. `community.spam`. */
    useCase: z.string().min(1),
    /** The plain-words policy text the model reads. */
    rules: z.string(),
    /** Question id to question. */
    questions: DecisionQuestionsSchema,
    /** At or above this confidence, act without anyone looking. */
    actAbove: z.number().min(0).max(1),
    /** Below this confidence, go up one rung. Between the two, ask for review. */
    escalateBelow: z.number().min(0).max(1),
    /** What happens once every rung is unsure, or a call cap is reached. */
    whenUnsure: z.enum(['allow', 'hold']),
    /** Labels that always go to a person or agent with authority, however confident. */
    serious: z.array(z.string().min(1)),
    /** Calls per UTC day, per rung. Past it, the ladder behaves as unsure. */
    dailyCallCap: z.object({
      rung1: z.number().int().min(0),
      rung2: z.number().int().min(0),
    }),
  })
  .refine((policy) => policy.escalateBelow <= policy.actAbove, {
    message: 'escalateBelow must not be above actAbove',
    path: ['escalateBelow'],
  });
/** One use case's policy. See {@link DecisionPolicySchema}. */
export type DecisionPolicy = z.infer<typeof DecisionPolicySchema>;
