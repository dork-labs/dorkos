import { describe, expect, it, vi } from 'vitest';
import {
  DecisionPolicySchema,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionPolicy,
  type DecisionRequest,
} from '@dorkos/shared/decision-model';
import { createMemoryCallCounter, policyVersion, runLadder } from '../ladder.js';

const POLICY: DecisionPolicy = DecisionPolicySchema.parse({
  useCase: 'community.spam',
  rules: 'No selling.',
  questions: {
    kind: {
      kind: 'choice',
      instructions: 'Which kind of post?',
      labels: { k7: 'ordinary', m2: 'selling', x9: 'a threat' },
    },
  },
  actAbove: 0.95,
  escalateBelow: 0.7,
  whenUnsure: 'hold',
  serious: ['x9'],
  dailyCallCap: { rung1: 2, rung2: 1 },
});

/** A bridge that always answers `value` at `confidence` (or abstains when value is null). */
function fixed(id: string, value: string | null, confidence: number) {
  const answer: DecisionAnswer =
    value === null ? { value: null, confidence: 0 } : { value, confidence };
  const decide = vi.fn(async (req: DecisionRequest) => ({
    answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, answer])),
    modelId: id,
    latencyMs: 1,
  }));
  const model: DecisionModel = {
    id,
    capabilities: {
      kinds: ['choice', 'score', 'yesno'],
      customRules: true,
      reasons: false,
      calibrated: false,
      runsLocally: true,
      maxInputTokens: 1000,
    },
    decide,
  };
  return Object.assign(model, { decide });
}

/** Options with a fresh call counter, for cases that do not test the cap. */
const fresh = () => ({ counter: createMemoryCallCounter() });

const ITEM = { item: 'Buy cheap watches', context: { sender: 'new member' } };

describe('runLadder', () => {
  it('acts on rung 0 when a rule is sure, and calls nothing above it', async () => {
    const rules = fixed('rules', 'm2', 1);
    const decision = fixed('jev', 'k7', 0.99);
    const outcome = await runLadder(POLICY, { rules, decision }, ITEM, fresh());
    expect(outcome.verdict).toMatchObject({
      kind: 'act',
      rung: 0,
      answers: { kind: { value: 'm2' } },
    });
    expect(decision.decide).not.toHaveBeenCalled();
    expect(outcome.steps).toHaveLength(1);
  });

  it('builds the request from the policy, with the item in its own field', async () => {
    const rules = fixed('rules', 'm2', 1);
    const outcome = await runLadder(POLICY, { rules }, ITEM, fresh());
    expect(outcome.request).toEqual({
      useCase: 'community.spam',
      policyVersion: policyVersion(POLICY),
      rules: 'No selling.',
      item: 'Buy cheap watches',
      context: { sender: 'new member' },
      questions: POLICY.questions,
    });
    expect(rules.decide.mock.calls[0]![0]).toEqual(outcome.request);
  });

  it('goes up a rung when a rung is below escalateBelow, and acts where one is sure', async () => {
    const outcome = await runLadder(
      POLICY,
      {
        rules: fixed('rules', null, 0),
        decision: fixed('jev', 'm2', 0.5),
        frontier: fixed('fable', 'm2', 0.97),
      },
      ITEM,
      fresh()
    );
    expect(outcome.steps.map((s) => s.rung)).toEqual([0, 1, 2]);
    expect(outcome.verdict).toMatchObject({ kind: 'act', rung: 2 });
  });

  it('stops for review in the band between escalateBelow and actAbove', async () => {
    const frontier = fixed('fable', 'm2', 0.99);
    const outcome = await runLadder(
      POLICY,
      { decision: fixed('jev', 'm2', 0.8), frontier },
      ITEM,
      fresh()
    );
    expect(outcome.verdict).toMatchObject({
      kind: 'review',
      rung: 1,
      answers: { kind: { value: 'm2' } },
    });
    expect(frontier.decide).not.toHaveBeenCalled();
  });

  it('treats the boundaries as inclusive: actAbove acts, escalateBelow reviews', async () => {
    expect(
      (await runLadder(POLICY, { decision: fixed('a', 'm2', 0.95) }, ITEM, fresh())).verdict.kind
    ).toBe('act');
    expect(
      (await runLadder(POLICY, { decision: fixed('a', 'm2', 0.7) }, ITEM, fresh())).verdict.kind
    ).toBe('review');
    expect(
      (await runLadder(POLICY, { decision: fixed('a', 'm2', 0.69) }, ITEM, fresh())).verdict.kind
    ).toBe('unsure');
  });

  it('sends a serious label to a person, however confident', async () => {
    const frontier = fixed('fable', 'k7', 1);
    const outcome = await runLadder(
      POLICY,
      { rules: fixed('rules', 'x9', 1), frontier },
      ITEM,
      fresh()
    );
    expect(outcome.verdict).toMatchObject({ kind: 'person', reason: 'serious', rung: 0 });
    expect(frontier.decide).not.toHaveBeenCalled();
  });

  it("applies the policy's whenUnsure default once every rung is unsure", async () => {
    const outcome = await runLadder(
      { ...POLICY, whenUnsure: 'allow' },
      { rules: fixed('rules', null, 0), decision: fixed('jev', 'm2', 0.3) },
      ITEM,
      fresh()
    );
    expect(outcome.verdict).toEqual({
      kind: 'unsure',
      whenUnsure: 'allow',
      reason: 'every-rung-unsure',
    });
  });

  it('never acts on or reviews a confidence-0 answer, even when the thresholds are 0', async () => {
    const outcome = await runLadder(
      { ...POLICY, actAbove: 0, escalateBelow: 0 },
      { decision: fixed('jev', null, 0) },
      ITEM,
      fresh()
    );
    expect(outcome.verdict.kind).toBe('unsure');
  });

  it('says so when there are no rungs at all', async () => {
    expect((await runLadder(POLICY, {}, ITEM, fresh())).verdict).toEqual({
      kind: 'unsure',
      whenUnsure: 'hold',
      reason: 'no-rungs',
    });
  });

  it('stops calling models past the daily cap, per rung, and resets the next UTC day', async () => {
    const counter = createMemoryCallCounter();
    let now = Date.parse('2026-10-07T23:00:00Z');
    const decision = fixed('jev', 'm2', 0.3);
    const frontier = fixed('fable', 'm2', 0.3);
    const run = () => runLadder(POLICY, { decision, frontier }, ITEM, { counter, now: () => now });

    await run(); // rung1 1/2, rung2 1/1
    const second = await run(); // rung1 2/2, rung2 capped
    expect(second.verdict).toEqual({ kind: 'unsure', whenUnsure: 'hold', reason: 'cap-reached' });
    expect(second.steps.at(-1)).toEqual({ rung: 2, modelId: 'fable', skipped: 'cap-reached' });
    const third = await run(); // rung1 capped: nothing called
    expect(third.steps).toEqual([{ rung: 1, modelId: 'jev', skipped: 'cap-reached' }]);
    expect(decision.decide).toHaveBeenCalledTimes(2);
    expect(frontier.decide).toHaveBeenCalledTimes(1);

    now = Date.parse('2026-10-08T00:00:01Z');
    await run();
    expect(decision.decide).toHaveBeenCalledTimes(3);
  });

  it('never caps the free rules rung', async () => {
    const counter = createMemoryCallCounter();
    const rules = fixed('rules', 'm2', 1);
    const capped = { ...POLICY, dailyCallCap: { rung1: 0, rung2: 0 } };
    for (let i = 0; i < 5; i++) await runLadder(capped, { rules }, ITEM, { counter });
    expect(rules.decide).toHaveBeenCalledTimes(5);
  });

  it('counts a bridge that throws, against the contract, as unsure on its rung', async () => {
    const broken = fixed('broken', 'm2', 1);
    broken.decide.mockRejectedValueOnce(new Error('boom'));
    const outcome = await runLadder(
      POLICY,
      { decision: broken, frontier: fixed('fable', 'k7', 0.99) },
      ITEM,
      fresh()
    );
    expect(outcome.steps[0]).toMatchObject({ rung: 1, confidence: 0 });
    expect(outcome.verdict).toMatchObject({ kind: 'act', rung: 2 });
  });

  it('only sends a serious label to a person at a confidence of at least escalateBelow', async () => {
    const frontier = fixed('fable', 'k7', 0.99);
    const outcome = await runLadder(
      POLICY,
      { decision: fixed('jev', 'x9', 0.5), frontier },
      ITEM,
      fresh()
    );
    // 0.5 is below escalateBelow (0.7): an unsure lean, so it goes up a rung.
    expect(outcome.verdict).toMatchObject({ kind: 'act', rung: 2 });
    const atFloor = await runLadder(POLICY, { decision: fixed('jev', 'x9', 0.7) }, ITEM, fresh());
    expect(atFloor.verdict).toMatchObject({ kind: 'person', reason: 'serious', rung: 1 });
  });

  it('refuses a policy whose serious label no question offers', async () => {
    await expect(
      runLadder({ ...POLICY, serious: ['nope'] }, { rules: fixed('rules', 'm2', 1) }, ITEM, fresh())
    ).rejects.toThrow(/serious label/);
  });

  it('stops before the next rung once the signal fires, without counting it against a cap', async () => {
    const counter = createMemoryCallCounter();
    const controller = new AbortController();
    const rules: DecisionModel = {
      ...fixed('rules', null, 0),
      decide: async (req) => {
        controller.abort();
        return {
          answers: Object.fromEntries(
            Object.keys(req.questions).map((q) => [
              q,
              { value: null, confidence: 0, failure: 'aborted' as const },
            ])
          ),
          modelId: 'rules',
          latencyMs: 1,
        };
      },
    };
    const decision = fixed('jev', 'm2', 0.99);
    const outcome = await runLadder(POLICY, { rules, decision }, ITEM, {
      counter,
      signal: controller.signal,
    });
    expect(outcome.verdict).toEqual({ kind: 'unsure', whenUnsure: 'hold', reason: 'aborted' });
    expect(decision.decide).not.toHaveBeenCalled();
    expect(counter.count(POLICY.useCase, 1, new Date().toISOString().slice(0, 10))).toBe(0);
  });

  it('requires a call counter, so a cap cannot silently reset on every call', () => {
    // @ts-expect-error -- `counter` is required in LadderOptions.
    const call = () => runLadder(POLICY, {}, ITEM, {});
    expect(call).toBeTypeOf('function');
  });

  it('uses the least confident answer when a policy asks several questions', async () => {
    const policy = {
      ...POLICY,
      questions: {
        ...POLICY.questions,
        other: { kind: 'yesno' as const, instructions: 'Off topic?' },
      },
    };
    const model: DecisionModel = {
      ...fixed('mixed', 'm2', 1),
      decide: async () => ({
        answers: {
          kind: { value: 'm2', confidence: 0.99 },
          other: { value: true, confidence: 0.5 },
        },
        modelId: 'mixed',
        latencyMs: 1,
      }),
    };
    const outcome = await runLadder(policy, { decision: model }, ITEM, fresh());
    expect(outcome.steps[0]).toMatchObject({ confidence: 0.5 });
    expect(outcome.verdict.kind).toBe('unsure');
  });
});

describe('policyVersion', () => {
  it('is stable across key order and changes with the rules or the questions', () => {
    const reordered: DecisionPolicy = {
      ...POLICY,
      questions: {
        kind: {
          kind: 'choice',
          labels: { x9: 'a threat', m2: 'selling', k7: 'ordinary' },
          instructions: 'Which kind of post?',
        },
      },
    };
    expect(policyVersion(reordered)).toBe(policyVersion(POLICY));
    expect(policyVersion({ ...POLICY, rules: 'No selling!' })).not.toBe(policyVersion(POLICY));
    expect(
      policyVersion({ ...POLICY, questions: { kind: { kind: 'yesno', instructions: 'x' } } })
    ).not.toBe(policyVersion(POLICY));
  });
});
