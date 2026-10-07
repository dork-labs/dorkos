import { describe, expect, it, vi } from 'vitest';
import type {
  DecisionFailure,
  DecisionModel,
  DecisionRequest,
} from '@dorkos/shared/decision-model';
import { unsureResult } from '../answers.js';
import { withCircuitBreaker } from '../circuit-breaker.js';

const REQ: DecisionRequest = {
  useCase: 'test',
  policyVersion: 'v1',
  item: 'x',
  questions: { q: { kind: 'yesno', instructions: 'q?' } },
};

/** A bridge that answers with the next scripted outcome: a failure, or a clear `true`. */
function scripted(
  outcomes: Array<DecisionFailure | 'ok'>
): DecisionModel & { decide: ReturnType<typeof vi.fn> } {
  let i = 0;
  const decide = vi.fn(async (req: DecisionRequest) => {
    const next = outcomes[Math.min(i++, outcomes.length - 1)]!;
    return next === 'ok'
      ? { answers: { q: { value: true, confidence: 1 } }, modelId: 'm', latencyMs: 1 }
      : unsureResult(req, 'm', next);
  });
  return {
    id: 'scripted',
    capabilities: {
      kinds: ['yesno'],
      customRules: true,
      reasons: false,
      calibrated: false,
      runsLocally: false,
      maxInputTokens: 1000,
    },
    decide,
  };
}

const signal = () => new AbortController().signal;

describe('withCircuitBreaker', () => {
  it('opens after the threshold of consecutive outages and answers circuit-open without calling', async () => {
    let now = 0;
    const inner = scripted(['outage', 'timeout', 'outage', 'ok']);
    const model = withCircuitBreaker(inner, {
      failureThreshold: 3,
      cooldownMs: 1000,
      now: () => now,
    });
    for (let i = 0; i < 3; i++) await model.decide(REQ, signal());
    const result = await model.decide(REQ, signal());
    expect(inner.decide).toHaveBeenCalledTimes(3);
    expect(result.answers.q).toEqual({ value: null, confidence: 0, failure: 'circuit-open' });

    now = 1000; // cooldown over: one trial call goes through and closes the circuit
    expect((await model.decide(REQ, signal())).answers.q!.value).toBe(true);
    expect(inner.decide).toHaveBeenCalledTimes(4);
  });

  it('re-opens at once when the trial call after the cooldown fails', async () => {
    let now = 0;
    const inner = scripted(['outage']);
    const model = withCircuitBreaker(inner, {
      failureThreshold: 2,
      cooldownMs: 100,
      now: () => now,
    });
    await model.decide(REQ, signal());
    await model.decide(REQ, signal());
    now = 100;
    await model.decide(REQ, signal()); // trial, fails
    now = 150;
    await model.decide(REQ, signal());
    expect(inner.decide).toHaveBeenCalledTimes(3);
  });

  it('does not count refusals, unknown labels or caller aborts as outages', async () => {
    const inner = scripted(['refused', 'unknown-label', 'aborted', 'outage', 'outage']);
    const model = withCircuitBreaker(inner, { failureThreshold: 3, now: () => 0 });
    for (let i = 0; i < 6; i++) await model.decide(REQ, signal());
    expect(inner.decide).toHaveBeenCalledTimes(6);
  });

  it('resets the run on any real answer', async () => {
    const inner = scripted(['outage', 'outage', 'ok', 'outage', 'outage', 'ok']);
    const model = withCircuitBreaker(inner, { failureThreshold: 3, now: () => 0 });
    for (let i = 0; i < 6; i++) await model.decide(REQ, signal());
    expect(inner.decide).toHaveBeenCalledTimes(6);
  });

  it('lets exactly one trial call through when half-open; the rest answer circuit-open until it settles', async () => {
    let now = 0;
    let release: (() => void) | undefined;
    let calls = 0;
    const inner: DecisionModel = {
      ...scripted(['ok']),
      decide: async (req: DecisionRequest) => {
        calls += 1;
        if (calls <= 2) return unsureResult(req, 'm', 'outage');
        if (calls === 3) await new Promise<void>((resolve) => (release = resolve));
        return { answers: { q: { value: true, confidence: 1 } }, modelId: 'm', latencyMs: 1 };
      },
    };
    const model = withCircuitBreaker(inner, {
      failureThreshold: 2,
      cooldownMs: 100,
      now: () => now,
    });
    await model.decide(REQ, signal());
    await model.decide(REQ, signal()); // open
    now = 100;
    const trial = model.decide(REQ, signal());
    const concurrent = await Promise.all([
      model.decide(REQ, signal()),
      model.decide(REQ, signal()),
    ]);
    for (const r of concurrent) expect(r.answers.q!.failure).toBe('circuit-open');
    expect(calls).toBe(3);
    release!();
    expect((await trial).answers.q!.value).toBe(true);
    // Closed again: calls go straight through.
    await model.decide(REQ, signal());
    expect(calls).toBe(4);
  });

  it('counts a run of unreadable replies as a service failure, so a wrong reply shape is loud', async () => {
    const inner = scripted(['invalid-answer']);
    const model = withCircuitBreaker(inner, { failureThreshold: 3, now: () => 0 });
    for (let i = 0; i < 5; i++) await model.decide(REQ, signal());
    expect(inner.decide).toHaveBeenCalledTimes(3);
  });

  it('keeps the wrapped id and capabilities', () => {
    const inner = scripted(['ok']);
    const model = withCircuitBreaker(inner);
    expect(model.id).toBe(inner.id);
    expect(model.capabilities).toBe(inner.capabilities);
  });
});
