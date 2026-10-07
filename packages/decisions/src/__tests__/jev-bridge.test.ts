import { describe, expect, it } from 'vitest';
import {
  decisionModelConformance,
  CONFORMANCE_QUESTIONS,
} from '@dorkos/test-utils/decision-model-conformance';
import type { DecisionRequest } from '@dorkos/shared/decision-model';
import { createJevModel, DEFAULT_JEV_MODEL } from '../jev-bridge.js';
import { stubFetch, type StubReply } from './stub-fetch.js';

/**
 * Jev's answer for one value, in the reply shape this bridge reads (research
 * §1): the pick plus probabilities and a confidence for choice and score, a
 * single probability of "yes" for yes/no.
 */
function jevAnswer(questionId: string, value: string | number | boolean): Record<string, unknown> {
  const question = CONFORMANCE_QUESTIONS[questionId]!;
  if (question.kind === 'yesno') return { probability: value ? 0.95 : 0.05 };
  if (question.kind === 'choice')
    return { choice: value, probabilities: { [String(value)]: 0.9 }, confidence: 0.9 };
  return { score: value, confidence: 0.85 };
}

const TIMEOUT = 150;

decisionModelConformance('jev', {
  timeoutMs: TIMEOUT,
  create(scenario) {
    const reply = (_n: number, call: { body: Record<string, unknown> }): StubReply => {
      const asked = Object.keys(call.body.questions as Record<string, unknown>);
      switch (scenario.kind) {
        case 'answer':
          return {
            status: 200,
            json: {
              model: 'typesafe/jev-1.13.0',
              answers: Object.fromEntries(
                asked.map((id) => [id, jevAnswer(id, scenario.values[id]!)])
              ),
              usage: { input_tokens: 40 },
            },
          };
        case 'unknown-label':
          return {
            status: 200,
            json: { answers: { q_choice: { choice: 'zz9', confidence: 0.99 } } },
          };
        case 'outage':
          return 'throw';
        case 'refusal':
          return { status: 200, json: { refusal: 'This input cannot be judged.' } };
        case 'hang':
          return 'hang';
      }
    };
    return createJevModel({ apiKey: 'or-test', fetch: stubFetch(reply).fetch, timeoutMs: TIMEOUT });
  },
});

const REQ: DecisionRequest = {
  useCase: 'community.spam',
  policyVersion: 'v1',
  rules: 'No selling.',
  item: 'Buy cheap watches',
  questions: {
    spam: {
      kind: 'choice',
      instructions: 'Which kind of post?',
      labels: { k7: 'ordinary', m2: 'selling' },
    },
    urgency: { kind: 'score', instructions: 'How urgent?', levels: ['low', 'mid', 'high'] },
    harm: {
      kind: 'yesno',
      instructions: 'Does it threaten anyone?',
      yes: 'a threat',
      no: 'no threat',
    },
  },
};

describe('createJevModel', () => {
  it("posts Jev's System One format to OpenRouter by default, with the item as the state", async () => {
    const stub = stubFetch(() => ({ status: 200, json: { answers: {} } }));
    const model = createJevModel({ apiKey: 'or-test', fetch: stub.fetch });
    await model.decide(REQ, new AbortController().signal);
    const call = stub.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(call.headers.authorization).toBe('Bearer or-test');
    expect(call.body).toEqual({
      model: DEFAULT_JEV_MODEL,
      state: 'Buy cheap watches',
      questions: {
        spam: {
          type: 'choice',
          instructions: 'No selling.\n\nWhich kind of post?',
          criteria: { k7: 'ordinary', m2: 'selling' },
        },
        urgency: {
          type: 'score',
          instructions: 'No selling.\n\nHow urgent?',
          levels: ['low', 'mid', 'high'],
        },
        harm: {
          type: 'noul',
          instructions:
            'No selling.\n\nDoes it threaten anyone?\nYes means: a threat\nNo means: no threat',
        },
      },
    });
  });

  it('takes a configurable model id and base URL, and keeps context beside the item', async () => {
    const stub = stubFetch(() => ({ status: 200, json: { answers: {} } }));
    const model = createJevModel({
      apiKey: 'k',
      fetch: stub.fetch,
      baseUrl: 'https://api.typesafe.test/v1/',
      model: 'jev-1.13.0',
    });
    await model.decide({ ...REQ, context: { sender: 'new' } }, new AbortController().signal);
    expect(stub.calls[0]!.url).toBe('https://api.typesafe.test/v1/systemone');
    expect(stub.calls[0]!.body.model).toBe('jev-1.13.0');
    expect(stub.calls[0]!.body.state).toEqual({
      item: 'Buy cheap watches',
      context: { sender: 'new' },
    });
    expect(model.id).toBe('jev:jev-1.13.0');
  });

  it('derives yes/no confidence as the distance from 0.5, doubled', async () => {
    const answers = (p: number) =>
      stubFetch(() => ({
        status: 200,
        json: { answers: { harm: { probability: p } } },
      })).fetch;
    const req = { ...REQ, questions: { harm: REQ.questions.harm! } };
    const at = async (p: number) =>
      (
        await createJevModel({ apiKey: 'k', fetch: answers(p) }).decide(
          req,
          new AbortController().signal
        )
      ).answers.harm!;
    expect(await at(0.5)).toMatchObject({ value: true, confidence: 0 });
    expect((await at(0.9)).confidence).toBeCloseTo(0.8, 6);
    expect(await at(0.1)).toMatchObject({ value: false });
    expect((await at(0.1)).confidence).toBeCloseTo(0.8, 6);
    expect(await at(1)).toMatchObject({
      value: true,
      confidence: 1,
      probabilities: { true: 1, false: 0 },
    });
    expect(await at(1.2)).toMatchObject({ value: null, confidence: 0, failure: 'unknown-label' });
  });

  it("uses Jev's own confidence, falling back to the pick's probability, and reports the cost", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      json: {
        model: 'typesafe/jev-1.13.0',
        answers: {
          spam: { choice: 'm2', probabilities: { m2: 0.7, k7: 0.3 } },
          urgency: { score: 1.4, probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 }, confidence: 0.55 },
          harm: { probability: 0.02 },
        },
        usage: { input_tokens: 1000 },
      },
    }));
    const model = createJevModel({
      apiKey: 'k',
      fetch: stub.fetch,
      costMicroUsd: (t) => t * 0.042,
    });
    const result = await model.decide(REQ, new AbortController().signal);
    expect(result.modelId).toBe('typesafe/jev-1.13.0');
    expect(result.answers.spam).toEqual({
      value: 'm2',
      confidence: 0.7,
      probabilities: { m2: 0.7, k7: 0.3 },
    });
    expect(result.answers.urgency).toMatchObject({ value: 1.4, confidence: 0.55 });
    expect(result.answers.harm!.value).toBe(false);
    expect(result.costMicroUsd).toBeCloseTo(42, 6);
  });

  it('treats an error body, a missing answer and an off-scale score as unsure', async () => {
    const errored = createJevModel({
      apiKey: 'k',
      fetch: stubFetch(() => ({ status: 200, json: { error: { message: 'overloaded' } } })).fetch,
    });
    expect((await errored.decide(REQ, new AbortController().signal)).answers.spam).toMatchObject({
      confidence: 0,
      failure: 'outage',
    });
    const partial = createJevModel({
      apiKey: 'k',
      circuitBreaker: false,
      fetch: stubFetch(() => ({
        status: 200,
        json: { answers: { urgency: { score: 7, confidence: 1 } } },
      })).fetch,
    });
    const result = await partial.decide(REQ, new AbortController().signal);
    expect(result.answers.spam).toMatchObject({
      value: null,
      confidence: 0,
      failure: 'invalid-answer',
    });
    expect(result.answers.urgency).toMatchObject({
      value: null,
      confidence: 0,
      failure: 'unknown-label',
    });
  });

  it('declares itself cloud-only and uncalibrated', () => {
    const model = createJevModel({ apiKey: 'k', fetch: stubFetch(() => 'throw').fetch });
    expect(model.capabilities).toMatchObject({
      runsLocally: false,
      calibrated: false,
      customRules: true,
    });
  });
});
