import { describe, expect, it } from 'vitest';
import {
  DecisionAnswerSchema,
  DecisionPolicySchema,
  DecisionQuestionSchema,
  DecisionRequestSchema,
} from '../decision-model.js';

describe('decision-model schemas', () => {
  it('bounds a choice question to 2..255 labels and a score to 2..10 levels', () => {
    const choice = (n: number) => ({
      kind: 'choice',
      instructions: 'x',
      labels: Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${i}`, ''])),
    });
    expect(DecisionQuestionSchema.safeParse(choice(1)).success).toBe(false);
    expect(DecisionQuestionSchema.safeParse(choice(2)).success).toBe(true);
    expect(DecisionQuestionSchema.safeParse(choice(255)).success).toBe(true);
    expect(DecisionQuestionSchema.safeParse(choice(256)).success).toBe(false);
    const score = (n: number) => ({
      kind: 'score',
      instructions: 'x',
      levels: Array.from({ length: n }, () => 'l'),
    });
    expect(DecisionQuestionSchema.safeParse(score(1)).success).toBe(false);
    expect(DecisionQuestionSchema.safeParse(score(10)).success).toBe(true);
    expect(DecisionQuestionSchema.safeParse(score(11)).success).toBe(false);
  });

  it('requires at least one question in a request', () => {
    const base = { useCase: 'u', policyVersion: 'v', item: 'x' };
    expect(DecisionRequestSchema.safeParse({ ...base, questions: {} }).success).toBe(false);
    expect(
      DecisionRequestSchema.safeParse({
        ...base,
        questions: { q: { kind: 'yesno', instructions: 'q?' } },
      }).success
    ).toBe(true);
  });

  it('refuses an answer with no value, or a failure, that claims any confidence', () => {
    expect(DecisionAnswerSchema.safeParse({ value: null, confidence: 0 }).success).toBe(true);
    expect(DecisionAnswerSchema.safeParse({ value: null, confidence: 0.4 }).success).toBe(false);
    expect(
      DecisionAnswerSchema.safeParse({ value: 'a', confidence: 0.4, failure: 'timeout' }).success
    ).toBe(false);
    expect(DecisionAnswerSchema.safeParse({ value: 'a', confidence: 1.2 }).success).toBe(false);
  });

  it('refuses a policy whose escalate threshold sits above its act threshold', () => {
    const policy = {
      useCase: 'u',
      rules: '',
      questions: { q: { kind: 'yesno', instructions: 'q?' } },
      actAbove: 0.7,
      escalateBelow: 0.9,
      whenUnsure: 'hold',
      serious: [],
      dailyCallCap: { rung1: 10, rung2: 1 },
    };
    expect(DecisionPolicySchema.safeParse(policy).success).toBe(false);
    expect(DecisionPolicySchema.safeParse({ ...policy, escalateBelow: 0.5 }).success).toBe(true);
  });
});
