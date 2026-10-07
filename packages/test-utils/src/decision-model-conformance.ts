/**
 * Shared `DecisionModel` conformance suite — the behavioural gate every bridge
 * behind the port (`packages/shared/src/decision-model.ts`) clears: built-in
 * rules, OpenAI-compatible chat, Jev, and whatever comes next. The decision
 * analogue of `runtimeConformance` and `memoryConformance`.
 *
 * `decisionModelConformance(name, harness)` registers a `describe` block. The
 * harness builds a bridge whose backend behaves one way per
 * {@link DecisionConformanceScenario} — for a network bridge, by handing it a
 * stubbed fetch. **No test here touches the network**: the global `fetch` is
 * replaced with one that fails the test if anything calls it, so a bridge that
 * ignores its injected fetch is caught too.
 *
 * What it pins (research §5b, "Conformance"):
 *
 * - the shape of every answer, against the port's own schemas;
 * - an answer for every question asked, and only those;
 * - failure is "unsure": an outage, a refusal, an unknown label, a timeout and
 *   a caller's abort all resolve (never reject) with confidence 0;
 * - a kind the bridge does not declare is answered `unsupported`, not thrown.
 *
 * A scenario a bridge cannot reach (the rules bridge has no network to hang)
 * returns `undefined` from the harness, which registers a NAMED `it.skip` rather
 * than a quiet pass. Read the skips.
 *
 * Deliberately NOT asserted here, so nobody assumes a gate that is not there:
 * how confidence is computed (each bridge's own tests pin that), the circuit
 * breaker (it wraps a bridge, and is tested in `@dorkos/decisions`), and cost.
 *
 * @module test-utils/decision-model-conformance
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_QUESTION_KINDS,
  DecisionModelCapabilitiesSchema,
  DecisionResultSchema,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionQuestionKind,
  type DecisionRequest,
} from '@dorkos/shared/decision-model';

/**
 * How the harness's backend should behave for one test.
 *
 * - `answer` — answer each question with the given value, confidently.
 * - `unknown-label` — answer the choice question with a label nobody asked for.
 * - `outage` — fail as a service does (a 5xx, a dropped connection, a throw).
 * - `refusal` — decline to answer.
 * - `hang` — never answer until aborted.
 */
export type DecisionConformanceScenario =
  | { kind: 'answer'; values: Record<string, string | number | boolean> }
  | { kind: 'unknown-label' }
  | { kind: 'outage' }
  | { kind: 'refusal' }
  | { kind: 'hang' };

/** How {@link decisionModelConformance} builds the bridge under test. */
export interface DecisionModelConformanceHarness {
  /**
   * A fresh bridge whose backend behaves per `scenario`, or `undefined` when
   * this bridge cannot reach that scenario at all.
   */
  create(scenario: DecisionConformanceScenario): DecisionModel | undefined;
  /** The bridge's own time limit, as `create` configured it. Default 200 ms. */
  timeoutMs?: number;
}

/** The questions every case asks, one per kind, with neutral label codes. */
export const CONFORMANCE_QUESTIONS: Record<string, DecisionQuestion> = {
  q_choice: {
    kind: 'choice',
    instructions: 'Which kind of message is this?',
    labels: { a1: 'a greeting', b2: 'a question', c3: 'something else' },
  },
  q_score: {
    kind: 'score',
    instructions: 'How urgent is it?',
    levels: ['not urgent', 'somewhat urgent', 'very urgent'],
  },
  q_yes: { kind: 'yesno', instructions: 'Does it ask for help?' },
};

/** The values the `answer` scenario returns for {@link CONFORMANCE_QUESTIONS}. */
export const CONFORMANCE_VALUES: Record<string, string | number | boolean> = {
  q_choice: 'b2',
  q_score: 2,
  q_yes: true,
};

/** Question id per kind in {@link CONFORMANCE_QUESTIONS}. */
const QUESTION_FOR_KIND: Record<DecisionQuestionKind, string> = {
  choice: 'q_choice',
  score: 'q_score',
  yesno: 'q_yes',
};

/** A request asking `ids` of {@link CONFORMANCE_QUESTIONS}. */
function request(ids: string[]): DecisionRequest {
  return {
    useCase: 'conformance.test',
    policyVersion: 'conformance-v1',
    rules: 'Judge the message on its own words.',
    item: 'Hi, can someone help me reset my password? It is urgent.',
    context: { sender: 'someone' },
    questions: Object.fromEntries(ids.map((id) => [id, CONFORMANCE_QUESTIONS[id]!])),
  };
}

/** A signal nobody aborts. */
function idle(): AbortSignal {
  return new AbortController().signal;
}

/** Assert every answer in `result` is unsure, for every asked id. */
function expectAllUnsure(result: unknown, ids: string[]): void {
  const parsed = DecisionResultSchema.parse(result);
  expect(Object.keys(parsed.answers).sort()).toEqual([...ids].sort());
  for (const id of ids) {
    expect(parsed.answers[id]!.confidence).toBe(0);
    expect(parsed.answers[id]!.value).toBeNull();
  }
}

/**
 * Register the conformance suite for one bridge.
 *
 * @param name - The bridge's name, for the describe block.
 * @param harness - Builds the bridge per scenario. See {@link DecisionModelConformanceHarness}.
 */
export function decisionModelConformance(
  name: string,
  harness: DecisionModelConformanceHarness
): void {
  const timeoutMs = harness.timeoutMs ?? 200;

  describe(`DecisionModel conformance: ${name}`, () => {
    const globalFetch = vi.fn(() => {
      throw new Error('decisionModelConformance: a bridge reached the global fetch');
    });
    beforeEach(() => {
      vi.stubGlobal('fetch', globalFetch);
    });
    afterEach(() => {
      expect(globalFetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
      globalFetch.mockClear();
    });

    const probe = harness.create({ kind: 'answer', values: CONFORMANCE_VALUES });
    if (!probe)
      throw new Error(`${name}: the harness must build a bridge for the 'answer' scenario`);
    const kinds = probe.capabilities.kinds;
    const supportedIds = kinds.map((k) => QUESTION_FOR_KIND[k]);
    const unsupportedKinds = DECISION_QUESTION_KINDS.filter((k) => !kinds.includes(k));

    /** Register `title` against `scenario`, or a named skip when the harness cannot reach it. */
    function scenarioIt(
      title: string,
      scenario: DecisionConformanceScenario,
      body: (model: DecisionModel) => Promise<void>
    ): void {
      const model = harness.create(scenario);
      if (!model) {
        it.skip(`${title} (the harness cannot reach the '${scenario.kind}' scenario)`, () => {});
        return;
      }
      it(title, () => body(model), timeoutMs + 5_000);
    }

    it('declares a non-empty id and capabilities that match the schema', () => {
      expect(probe.id.length).toBeGreaterThan(0);
      expect(() => DecisionModelCapabilitiesSchema.parse(probe.capabilities)).not.toThrow();
    });

    scenarioIt(
      'answers every asked question with a value the question allows',
      { kind: 'answer', values: CONFORMANCE_VALUES },
      async (model) => {
        const result = DecisionResultSchema.parse(
          await model.decide(request(supportedIds), idle())
        );
        expect(Object.keys(result.answers).sort()).toEqual([...supportedIds].sort());
        for (const id of supportedIds) {
          const answer = result.answers[id]!;
          expect(answer.value).toEqual(CONFORMANCE_VALUES[id]);
          expect(answer.confidence).toBeGreaterThan(0);
          expect(answer.confidence).toBeLessThanOrEqual(1);
          expect(answer.failure).toBeUndefined();
        }
        expect(result.modelId.length).toBeGreaterThan(0);
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      }
    );

    scenarioIt(
      'answers only the questions asked',
      { kind: 'answer', values: CONFORMANCE_VALUES },
      async (model) => {
        const one = [supportedIds[0]!];
        const result = DecisionResultSchema.parse(await model.decide(request(one), idle()));
        expect(Object.keys(result.answers)).toEqual(one);
      }
    );

    if (kinds.includes('choice')) {
      scenarioIt(
        'treats a label nobody asked for as unsure (confidence 0)',
        { kind: 'unknown-label' },
        async (model) => {
          const result = DecisionResultSchema.parse(
            await model.decide(request(['q_choice']), idle())
          );
          expect(result.answers.q_choice).toMatchObject({
            value: null,
            confidence: 0,
            failure: 'unknown-label',
          });
        }
      );
    } else {
      it.skip('treats a label nobody asked for as unsure (the bridge answers no choice questions)', () => {});
    }

    scenarioIt(
      'resolves an outage as unsure, never rejecting',
      { kind: 'outage' },
      async (model) => {
        const result = await model.decide(request(supportedIds), idle());
        expectAllUnsure(result, supportedIds);
        for (const id of supportedIds) expect(result.answers[id]!.failure).toBeDefined();
      }
    );

    scenarioIt('resolves a refusal as unsure', { kind: 'refusal' }, async (model) => {
      const result = await model.decide(request(supportedIds), idle());
      expectAllUnsure(result, supportedIds);
      for (const id of supportedIds) expect(result.answers[id]!.failure).toBeDefined();
    });

    scenarioIt('gives up at its own time limit, as unsure', { kind: 'hang' }, async (model) => {
      const started = Date.now();
      const result = await model.decide(request(supportedIds), idle());
      expect(Date.now() - started).toBeLessThan(timeoutMs + 2_000);
      expectAllUnsure(result, supportedIds);
      for (const id of supportedIds) expect(result.answers[id]!.failure).toBe('timeout');
    });

    scenarioIt(
      "stops promptly when the caller's signal aborts",
      { kind: 'hang' },
      async (model) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10);
        const result = await model.decide(request(supportedIds), controller.signal);
        expectAllUnsure(result, supportedIds);
        for (const id of supportedIds) expect(result.answers[id]!.failure).toBe('aborted');
      }
    );

    scenarioIt(
      'answers an already-aborted request as unsure',
      { kind: 'answer', values: CONFORMANCE_VALUES },
      async (model) => {
        const controller = new AbortController();
        controller.abort();
        const result = await model.decide(request(supportedIds), controller.signal);
        expectAllUnsure(result, supportedIds);
      }
    );

    if (unsupportedKinds.length > 0) {
      scenarioIt(
        'answers a kind it does not declare as unsupported',
        { kind: 'answer', values: CONFORMANCE_VALUES },
        async (model) => {
          const ids = unsupportedKinds.map((k) => QUESTION_FOR_KIND[k]);
          const result = DecisionResultSchema.parse(await model.decide(request(ids), idle()));
          for (const id of ids) {
            expect(result.answers[id]).toMatchObject({
              value: null,
              confidence: 0,
              failure: 'unsupported',
            });
          }
        }
      );
    } else {
      it.skip('answers a kind it does not declare as unsupported (the bridge declares every kind)', () => {});
    }
  });
}
