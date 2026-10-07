import { describe, expect, it } from 'vitest';
import { decisionModelConformance } from '@dorkos/test-utils/decision-model-conformance';
import type { DecisionRequest } from '@dorkos/shared/decision-model';
import { createRulesModel } from '../rules-bridge.js';

decisionModelConformance('rules', {
  create(scenario) {
    switch (scenario.kind) {
      case 'answer':
        return createRulesModel({
          id: 'rules:conformance',
          checks: Object.fromEntries(
            Object.entries(scenario.values).map(([id, value]) => [id, () => ({ value })])
          ),
        });
      case 'unknown-label':
        return createRulesModel({
          id: 'rules:conformance',
          checks: { q_choice: () => ({ value: 'zz9' }) },
        });
      case 'outage': {
        const boom = () => {
          throw new Error('check failed');
        };
        return createRulesModel({
          id: 'rules:conformance',
          checks: { q_choice: boom, q_score: boom, q_yes: boom },
        });
      }
      // A rule cannot refuse, and a synchronous check cannot hang.
      case 'refusal':
      case 'hang':
        return undefined;
    }
  },
});

/** Count links in a string item. */
function linkCount(req: DecisionRequest): number {
  return typeof req.item === 'string' ? (req.item.match(/https?:\/\//g) ?? []).length : 0;
}

const REQ: DecisionRequest = {
  useCase: 'community.spam',
  policyVersion: 'v1',
  item: 'see http://a.example and http://b.example and http://c.example',
  questions: {
    spam: { kind: 'choice', instructions: 'Spam?', labels: { k7: 'ordinary', m2: 'spam' } },
    other: { kind: 'yesno', instructions: 'Anything else?' },
  },
};

describe('createRulesModel', () => {
  const model = createRulesModel({
    id: 'rules:spam',
    checks: {
      spam: (req) =>
        linkCount(req) >= 3 ? { value: 'm2', reason: 'three or more links' } : undefined,
    },
  });

  it('answers with confidence 1 when a check fires, and carries its reason', async () => {
    const result = await model.decide(REQ, new AbortController().signal);
    expect(result.answers.spam).toEqual({
      value: 'm2',
      confidence: 1,
      reason: 'three or more links',
    });
    expect(result.modelId).toBe('rules:spam');
  });

  it('abstains with confidence 0 and no failure when a check does not fire', async () => {
    const result = await model.decide({ ...REQ, item: 'hello' }, new AbortController().signal);
    expect(result.answers.spam).toEqual({ value: null, confidence: 0 });
  });

  it('answers a question with no check as unsupported', async () => {
    const result = await model.decide(REQ, new AbortController().signal);
    expect(result.answers.other).toEqual({ value: null, confidence: 0, failure: 'unsupported' });
  });

  it('ignores a check inherited from the object prototype', async () => {
    const result = await model.decide(
      { ...REQ, questions: { toString: { kind: 'yesno' as const, instructions: 'x' } } },
      new AbortController().signal
    );
    expect(result.answers.toString).toEqual({ value: null, confidence: 0, failure: 'unsupported' });
  });

  it('runs on this computer and needs no rules text', () => {
    expect(model.capabilities).toMatchObject({ runsLocally: true, customRules: false });
  });
});
