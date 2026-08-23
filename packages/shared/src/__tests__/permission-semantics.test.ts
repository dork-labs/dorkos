import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '../agent-runtime.js';
import {
  findWorkingMode,
  isAutonomyStop,
  isBypassSemantics,
  isDivergent,
  isTightening,
  isUnattendedAutonomy,
  isWorkingMode,
  needsConsentRitual,
  resolveTrustStops,
  stopExpectation,
} from '../permission-semantics.js';

/** A declared mode, with only the semantics under test spelled out. */
function descriptor(overrides: Partial<PermissionModeDescriptor>): PermissionModeDescriptor {
  return {
    id: 'mode',
    label: 'Mode',
    stop: 'ask',
    asks: 'always',
    reach: 'edit',
    promise: 'Asks first.',
    ...overrides,
  };
}

describe('stopExpectation', () => {
  it('gives each dial position the asking it promises', () => {
    expect(stopExpectation('ask')).toBe('always');
    expect(stopExpectation('act')).toBe('when-risky');
    expect(stopExpectation('autonomy')).toBe('never');
  });
});

describe('isTightening', () => {
  it('is true when the agent must now ask more often', () => {
    // Claude's `bypassPermissions` → `default`: the change DOR-1435 is about.
    expect(
      isTightening(
        descriptor({ asks: 'never', reach: 'everything' }),
        descriptor({ asks: 'always', reach: 'edit' })
      )
    ).toBe(true);
    expect(isTightening(descriptor({ asks: 'when-risky' }), descriptor({ asks: 'always' }))).toBe(
      true
    );
  });

  it('is true when the agent may now reach less far, even at the same asking', () => {
    // `default` → `plan`: both ask always, and the second cannot edit.
    expect(
      isTightening(
        descriptor({ asks: 'always', reach: 'edit' }),
        descriptor({ asks: 'always', reach: 'read' })
      )
    ).toBe(true);
  });

  it('is false in the loosening direction', () => {
    expect(
      isTightening(
        descriptor({ asks: 'always', reach: 'edit' }),
        descriptor({ asks: 'never', reach: 'everything' })
      )
    ).toBe(false);
    expect(
      isTightening(
        descriptor({ asks: 'always', reach: 'read' }),
        descriptor({ asks: 'always', reach: 'workspace' })
      )
    ).toBe(false);
  });

  it('is false when nothing about the leash moved', () => {
    expect(
      isTightening(
        descriptor({ id: 'acceptEdits', asks: 'when-risky', reach: 'edit' }),
        descriptor({ id: 'auto', asks: 'when-risky', reach: 'edit' })
      )
    ).toBe(false);
  });
});

describe('isDivergent', () => {
  it('is quiet when the runtime does what its stop promises', () => {
    expect(isDivergent(descriptor({ stop: 'ask', asks: 'always' }))).toBe(false);
    expect(isDivergent(descriptor({ stop: 'act', asks: 'when-risky' }))).toBe(false);
    expect(isDivergent(descriptor({ stop: 'autonomy', asks: 'never' }))).toBe(false);
  });

  it('flags the runtime that cannot keep its stop’s promise', () => {
    // Codex's workspace-write: the middle stop, but no way to pause and ask.
    expect(isDivergent(descriptor({ stop: 'act', asks: 'never', reach: 'workspace' }))).toBe(true);
  });

  it('flags asking only sometimes where the position promised always', () => {
    expect(isDivergent(descriptor({ stop: 'ask', asks: 'when-risky', reach: 'edit' }))).toBe(true);
  });

  it('is quiet when a mode asks MORE often than its position promised', () => {
    // Over-delivering on safety is not the surprise the caption exists to warn
    // about; flagging it teaches people the mark means "unusual" rather than
    // "this will do more than you agreed to".
    expect(isDivergent(descriptor({ stop: 'autonomy', asks: 'always', reach: 'everything' }))).toBe(
      false
    );
    expect(isDivergent(descriptor({ stop: 'act', asks: 'always', reach: 'edit' }))).toBe(false);
  });

  it('is quiet for a read-only mode that never asks — it cannot break a promise', () => {
    // Codex's read-only default. It never asks because it cannot write, run, or
    // reach the network. Plain inequality would amber the safest mode on offer.
    expect(isDivergent(descriptor({ stop: 'ask', asks: 'never', reach: 'read' }))).toBe(false);
  });
});

describe('isBypassSemantics', () => {
  it('is true only for a mode that never asks and can reach anything', () => {
    expect(isBypassSemantics(descriptor({ asks: 'never', reach: 'everything' }))).toBe(true);
  });

  it('is false when the reach is bounded or the mode still asks', () => {
    expect(isBypassSemantics(descriptor({ asks: 'never', reach: 'workspace' }))).toBe(false);
    expect(isBypassSemantics(descriptor({ asks: 'never', reach: 'read' }))).toBe(false);
    expect(isBypassSemantics(descriptor({ asks: 'when-risky', reach: 'everything' }))).toBe(false);
  });
});

describe('needsConsentRitual', () => {
  it('is true at the autonomy stop, whatever that stop can reach', () => {
    expect(
      needsConsentRitual(descriptor({ stop: 'autonomy', asks: 'never', reach: 'everything' }))
    ).toBe(true);
    // A sandboxed autonomy stop is still the position a person deliberately took.
    expect(
      needsConsentRitual(descriptor({ stop: 'autonomy', asks: 'never', reach: 'workspace' }))
    ).toBe(true);
  });

  it('is true for a middle stop that never asks and can do more than read', () => {
    // Codex's workspace-write: filed at the middle stop, runs shell commands
    // with nothing to ask. The shape this predicate exists for (DOR-816).
    expect(needsConsentRitual(descriptor({ stop: 'act', asks: 'never', reach: 'workspace' }))).toBe(
      true
    );
    expect(needsConsentRitual(descriptor({ stop: 'act', asks: 'never', reach: 'edit' }))).toBe(
      true
    );
  });

  it('is false for a read-only mode that never asks — it has nothing to ask about', () => {
    expect(needsConsentRitual(descriptor({ stop: 'ask', asks: 'never', reach: 'read' }))).toBe(
      false
    );
  });

  it('is false for anything that still stops for the person', () => {
    expect(needsConsentRitual(descriptor({ stop: 'ask', asks: 'always', reach: 'edit' }))).toBe(
      false
    );
    expect(
      needsConsentRitual(descriptor({ stop: 'act', asks: 'when-risky', reach: 'workspace' }))
    ).toBe(false);
    // Even reaching everything, if it asks it is one refusal away from stopping.
    expect(
      needsConsentRitual(descriptor({ stop: 'act', asks: 'when-risky', reach: 'everything' }))
    ).toBe(false);
  });

  it('is strictly wider than the door it replaced and than the banner’s rule', () => {
    // The predicates are allowed to disagree, and this is the disagreement that
    // matters: the never-asking middle stop is gated by the door, and reported
    // by none of the others.
    const neverAskingMiddle = descriptor({ stop: 'act', asks: 'never', reach: 'workspace' });
    expect(needsConsentRitual(neverAskingMiddle)).toBe(true);
    expect(isAutonomyStop(neverAskingMiddle)).toBe(false);
    expect(isBypassSemantics(neverAskingMiddle)).toBe(false);
    expect(isUnattendedAutonomy(neverAskingMiddle)).toBe(false);
  });
});

describe('isWorkingMode', () => {
  it('is false for a mode that says nothing — a trust level is the ordinary case', () => {
    expect(isWorkingMode(descriptor({}))).toBe(false);
  });

  it('is true only for a mode the runtime declared as a way of working', () => {
    expect(isWorkingMode(descriptor({ axis: 'working' }))).toBe(true);
    expect(isWorkingMode(descriptor({ axis: 'trust' }))).toBe(false);
  });
});

describe('resolveTrustStops', () => {
  /** Claude Code's declared set, in its declared order. */
  const CLAUDE = [
    descriptor({ id: 'default', stop: 'ask' }),
    descriptor({ id: 'acceptEdits', stop: 'act', asks: 'when-risky' }),
    descriptor({ id: 'plan', stop: 'ask', reach: 'read', axis: 'working' }),
    descriptor({ id: 'bypassPermissions', stop: 'autonomy', asks: 'never', reach: 'everything' }),
    descriptor({ id: 'auto', stop: 'act', asks: 'when-risky' }),
  ];

  it('gives each stop the mode selecting it selects, in dial order', () => {
    expect(resolveTrustStops(CLAUDE).map((s) => [s.stop, s.mode.id])).toEqual([
      ['ask', 'default'],
      ['act', 'acceptEdits'],
      ['autonomy', 'bypassPermissions'],
    ]);
  });

  it('keeps a further mode at the same stop as a refinement inside it', () => {
    const act = resolveTrustStops(CLAUDE).find((s) => s.stop === 'act');
    expect(act?.refinements.map((d) => d.id)).toEqual(['auto']);
    expect(resolveTrustStops(CLAUDE).find((s) => s.stop === 'ask')?.refinements).toEqual([]);
  });

  it('leaves a way of working off the dial entirely', () => {
    const ask = resolveTrustStops(CLAUDE).find((s) => s.stop === 'ask');
    expect(ask?.mode.id).toBe('default');
    expect(ask?.refinements.map((d) => d.id)).not.toContain('plan');
  });

  it('omits a stop the runtime declares no mode for, rather than offering a dead one', () => {
    const stops = resolveTrustStops([
      descriptor({ id: 'default', stop: 'ask' }),
      descriptor({ id: 'bypassPermissions', stop: 'autonomy', asks: 'never', reach: 'everything' }),
    ]);
    expect(stops.map((s) => s.stop)).toEqual(['ask', 'autonomy']);
  });

  it('answers with nothing when the runtime declares nothing', () => {
    expect(resolveTrustStops([])).toEqual([]);
  });
});

describe('findWorkingMode', () => {
  it('finds the way of working a runtime offers', () => {
    const plan = descriptor({ id: 'plan', axis: 'working', reach: 'read' });
    expect(findWorkingMode([descriptor({ id: 'default' }), plan])).toBe(plan);
  });

  it('is undefined on a runtime that offers none', () => {
    expect(findWorkingMode([descriptor({ id: 'default' })])).toBeUndefined();
  });
});
