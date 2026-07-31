import { describe, it, expect } from 'vitest';
import { describeAgentExecution, effortLabel, knownModelsFrom } from '../execution-config';

describe('knownModelsFrom', () => {
  it('reads an EMPTY catalog as no evidence, not as "nothing is offered"', () => {
    // `GET /api/models` answers 200 {models: []} while the runtime cache warms
    // up. Passed through as `[]` it says every pinned model in the fleet is
    // gone; collapsed to `undefined` it says nothing, which is the truth.
    expect(knownModelsFrom([])).toBeUndefined();
    expect(knownModelsFrom(undefined)).toBeUndefined();
    expect(knownModelsFrom([{ value: 'opus' }])).toEqual(['opus']);
  });

  it('produces no broken verdict for a pinned model against a cold catalog', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'claude-code', model: 'opus' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      knownModels: knownModelsFrom([]),
    });
    expect(report.isBroken).toBe(false);
    expect(report.breakages).toEqual([]);
  });
});

describe('effortLabel', () => {
  it('names a rung, and calls the absence Default', () => {
    expect(effortLabel('xhigh')).toBe('Extra high');
    expect(effortLabel(null)).toBe('Default');
    expect(effortLabel(undefined)).toBe('Default');
  });
});

describe('describeAgentExecution', () => {
  it('reports nothing at all for an agent that inherits everything', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'claude-code' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      knownModels: ['opus'],
    });
    expect(report.isException).toBe(false);
    expect(report.isBroken).toBe(false);
    expect(report.deviations).toEqual([]);
  });

  it('calls a set model or effort a deviation, not a breakage', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'claude-code', model: 'opus', effort: 'xhigh' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      knownModels: ['opus'],
      modelSupportsEffort: true,
    });
    expect(report.isException).toBe(true);
    expect(report.isBroken).toBe(false);
    expect(report.deviations).toEqual([
      { field: 'model', label: 'opus' },
      { field: 'effort', label: 'Extra high' },
    ]);
  });

  it('breaks on a runtime this machine has not connected', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'codex' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
    });
    expect(report.isBroken).toBe(true);
    expect(report.breakages[0].kind).toBe('runtime-not-connected');
    // Written the way the product names the runtime, not the way the wire does.
    expect(report.breakages[0].message).toBe('Codex is not connected on this machine.');
  });

  it('breaks on a model the runtime no longer offers', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'claude-code', model: 'opus-3' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      knownModels: ['opus', 'sonnet'],
    });
    expect(report.isBroken).toBe(true);
    expect(report.breakages[0].kind).toBe('model-unavailable');
    expect(report.breakages[0].message).toBe('Claude no longer offers opus-3.');
  });

  it('names a runtime the way the calling screen names it, when told how', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'codex' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      runtimeLabel: (type) => (type === 'codex' ? 'Codex CLI' : type),
    });
    expect(report.breakages[0].message).toBe('Codex CLI is not connected on this machine.');
  });

  it('breaks on an effort set for a runtime whose API has none', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'opencode', effort: 'high' },
      defaultRuntime: 'opencode',
      knownRuntimes: ['opencode'],
    });
    expect(report.breakages.map((b) => b.kind)).toEqual(['effort-unsupported-runtime']);
  });

  it('breaks on an effort set for a model that does not take one', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'claude-code', model: 'haiku', effort: 'high' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      knownModels: ['haiku'],
      modelSupportsEffort: false,
    });
    expect(report.breakages.map((b) => b.kind)).toEqual(['effort-unsupported-model']);
  });

  // The rule the module leads with: evidence nobody has is not evidence against.
  // A catalog that has not loaded must never make a working agent look broken.
  it('reports no breakage while the catalogs and runtime list are unknown', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      defaultRuntime: 'claude-code',
    });
    expect(report.isBroken).toBe(false);
    expect(report.isException).toBe(true);
  });

  // An in-flight optimistic reset carries the wire's `null` for "inherit". Read
  // as a value, it made a reset click say "set here" and announce that the
  // runtime no longer offers `null`.
  it('reads a null field as inheriting, exactly like an absent one', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'claude-code', model: null, effort: null },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      knownModels: ['opus'],
    });
    expect(report.isException).toBe(false);
    expect(report.deviations).toEqual([]);
    expect(report.breakages).toEqual([]);
  });

  // The divergence I3 names: the strip used to ask only about a PINNED model, so
  // an agent asking for high effort on an inherited Haiku was broken in the
  // Config tab and healthy in the strip.
  it('judges effort against the EFFECTIVE model, pinned or inherited', () => {
    const inherited = describeAgentExecution({
      agent: { runtime: 'claude-code', effort: 'high' },
      defaultRuntime: 'claude-code',
      serverDefaultModel: 'haiku',
      knownRuntimes: ['claude-code'],
      knownModels: ['haiku', 'opus'],
      modelSupportsEffort: false,
    });
    expect(inherited.breakages.map((b) => b.kind)).toEqual(['effort-unsupported-model']);
    // ...and names the model that will actually run, not "This model".
    expect(inherited.breakages[0].message).toBe('haiku does not take an effort setting.');
  });

  // The other half of the same rule: availability stays scoped to the pin. A
  // server default that stopped being offered is one problem with one fix, and
  // repeating it once per agent would bury the agents that chose something.
  it('does not call an agent broken for a server default model that is gone', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'claude-code', effort: 'high' },
      defaultRuntime: 'claude-code',
      serverDefaultModel: 'opus-3',
      knownRuntimes: ['claude-code'],
      knownModels: ['opus'],
      modelSupportsEffort: undefined,
    });
    expect(report.breakages).toEqual([]);
  });

  it('does not blame the model when the runtime itself is missing', () => {
    const report = describeAgentExecution({
      agent: { runtime: 'codex', model: 'gone' },
      defaultRuntime: 'claude-code',
      knownRuntimes: ['claude-code'],
      knownModels: [],
    });
    expect(report.breakages.map((b) => b.kind)).toEqual(['runtime-not-connected']);
  });
});
