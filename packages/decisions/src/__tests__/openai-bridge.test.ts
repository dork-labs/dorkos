import { describe, expect, it } from 'vitest';
import { decisionModelConformance } from '@dorkos/test-utils/decision-model-conformance';
import type { DecisionRequest } from '@dorkos/shared/decision-model';
import { createOpenAiCompatibleModel } from '../openai-bridge.js';
import { stubFetch, type StubReply } from './stub-fetch.js';

/** A chat completion whose content is `content`, with per-character logprobs when given. */
function completion(
  content: string,
  logprob?: (token: string, index: number) => number
): StubReply {
  const choice: Record<string, unknown> = {
    message: { role: 'assistant', content },
    finish_reason: 'stop',
  };
  if (logprob) {
    choice.logprobs = {
      content: [...content].map((token, i) => ({ token, logprob: logprob(token, i) })),
    };
  }
  return {
    status: 200,
    json: { choices: [choice], usage: { prompt_tokens: 100, completion_tokens: 10 } },
  };
}

const TIMEOUT = 150;

decisionModelConformance('openai-compatible', {
  timeoutMs: TIMEOUT,
  create(scenario) {
    const reply = (): StubReply => {
      switch (scenario.kind) {
        case 'answer':
          return completion(JSON.stringify(scenario.values), () => 0);
        case 'unknown-label':
          return completion(JSON.stringify({ q_choice: 'zz9' }), () => 0);
        case 'outage':
          return { status: 503, json: { error: 'unavailable' } };
        case 'refusal':
          return {
            status: 200,
            json: {
              choices: [{ message: { content: null, refusal: 'I cannot help with that.' } }],
            },
          };
        case 'hang':
          return 'hang';
      }
    };
    return createOpenAiCompatibleModel({
      baseUrl: 'http://stub.test/v1',
      model: 'stub-model-1',
      fetch: stubFetch(reply).fetch,
      timeoutMs: TIMEOUT,
    });
  },
});

const REQ: DecisionRequest = {
  useCase: 'community.spam',
  policyVersion: 'v1',
  rules: 'No selling. No links to shops.',
  item: 'Buy cheap watches at shop.example',
  context: { sender: 'new member' },
  questions: {
    spam: {
      kind: 'choice',
      instructions: 'Which kind of post?',
      labels: { k7: 'ordinary', m2: 'selling' },
    },
    harm: { kind: 'yesno', instructions: 'Does it threaten anyone?' },
  },
};

describe('createOpenAiCompatibleModel', () => {
  it('posts a forced JSON schema with the item in its own user message, never in the rules', async () => {
    const stub = stubFetch(() => completion('{"spam":"m2","harm":false}', () => 0));
    const model = createOpenAiCompatibleModel({
      baseUrl: 'http://stub.test/v1/',
      model: 'm',
      apiKey: 'sk-test',
      fetch: stub.fetch,
    });
    await model.decide(REQ, new AbortController().signal);
    const call = stub.calls[0]!;
    expect(call.url).toBe('http://stub.test/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-test');
    const messages = call.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('No selling.');
    expect(messages[0]!.content).not.toContain('cheap watches');
    expect(JSON.parse(messages[1]!.content)).toEqual({ item: REQ.item, context: REQ.context });
    expect(call.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'decision',
        strict: true,
        schema: {
          type: 'object',
          properties: { spam: { type: 'string', enum: ['k7', 'm2'] }, harm: { type: 'boolean' } },
          required: ['spam', 'harm'],
          additionalProperties: false,
        },
      },
    });
    expect(call.body.logprobs).toBe(true);
  });

  it('reads confidence from the tokens that spell each answer', async () => {
    const content = '{"spam":"m2","harm":false}';
    const spamStart = content.indexOf('"m2"');
    const harmStart = content.indexOf('false');
    // The answer "m2" spans 4 characters; give each ln(0.9)/4 so their joint is 0.9.
    // "false" gets a joint of 0.8, so yes/no confidence is 2*0.8-1 = 0.6.
    const stub = stubFetch(() =>
      completion(content, (_t, i) => {
        if (i >= spamStart && i < spamStart + 4) return Math.log(0.9) / 4;
        if (i >= harmStart && i < harmStart + 5) return Math.log(0.8) / 5;
        return 0;
      })
    );
    const model = createOpenAiCompatibleModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: stub.fetch,
    });
    const result = await model.decide(REQ, new AbortController().signal);
    expect(stub.calls).toHaveLength(1);
    expect(result.answers.spam!.value).toBe('m2');
    expect(result.answers.spam!.confidence).toBeCloseTo(0.9, 6);
    expect(result.answers.harm!.value).toBe(false);
    expect(result.answers.harm!.confidence).toBeCloseTo(0.6, 6);
    expect(result.answers.harm!.probabilities).toEqual({
      false: expect.closeTo(0.8, 6),
      true: expect.closeTo(0.2, 6),
    });
  });

  it('asks twice when no logprobs come back, and lowers confidence where the answers disagree', async () => {
    const stub = stubFetch((n) =>
      completion(n === 0 ? '{"spam":"m2","harm":false}' : '{"spam":"k7","harm":false}')
    );
    const model = createOpenAiCompatibleModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: stub.fetch,
      costMicroUsd: (u) => u.promptTokens + u.completionTokens,
    });
    const result = await model.decide(REQ, new AbortController().signal);
    expect(stub.calls).toHaveLength(2);
    expect(result.answers.spam).toEqual({ value: 'm2', confidence: 0.4 });
    expect(result.answers.harm).toEqual({ value: false, confidence: 0.8 });
    expect(result.costMicroUsd).toBe(220);
  });

  it('keeps the first answer at the lowered confidence when the second ask fails', async () => {
    const stub = stubFetch((n) => (n === 0 ? completion('{"spam":"m2","harm":true}') : 'throw'));
    const model = createOpenAiCompatibleModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: stub.fetch,
    });
    const result = await model.decide(REQ, new AbortController().signal);
    expect(result.answers.spam).toEqual({ value: 'm2', confidence: 0.4 });
  });

  it('treats a content filter stop, unreadable JSON and a missing answer as unsure', async () => {
    const filtered = createOpenAiCompatibleModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: stubFetch(() => ({
        status: 200,
        json: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] },
      })).fetch,
    });
    expect((await filtered.decide(REQ, new AbortController().signal)).answers.spam).toMatchObject({
      confidence: 0,
      failure: 'refused',
    });

    const garbled = createOpenAiCompatibleModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: stubFetch(() => completion('not json', () => 0)).fetch,
    });
    expect((await garbled.decide(REQ, new AbortController().signal)).answers.harm).toMatchObject({
      confidence: 0,
      failure: 'invalid-answer',
    });

    const partial = createOpenAiCompatibleModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: stubFetch(() => completion('{"spam":"m2"}', () => 0)).fetch,
    });
    const result = await partial.decide(REQ, new AbortController().signal);
    expect(result.answers.spam).toMatchObject({ value: 'm2', confidence: 1 });
    expect(result.answers.harm).toMatchObject({
      value: null,
      confidence: 0,
      failure: 'invalid-answer',
    });
  });

  it('is wrapped in a circuit breaker by default', async () => {
    const stub = stubFetch(() => ({ status: 500, json: {} }));
    const model = createOpenAiCompatibleModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: stub.fetch,
    });
    for (let i = 0; i < 3; i++) await model.decide(REQ, new AbortController().signal);
    const result = await model.decide(REQ, new AbortController().signal);
    expect(stub.calls).toHaveLength(3);
    expect(result.answers.spam!.failure).toBe('circuit-open');
  });

  it('can declare that it runs on this computer', () => {
    const model = createOpenAiCompatibleModel({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
      fetch: stubFetch(() => 'throw').fetch,
      runsLocally: true,
    });
    expect(model.capabilities.runsLocally).toBe(true);
    expect(model.id).toBe('openai-compatible:llama3');
  });
});
