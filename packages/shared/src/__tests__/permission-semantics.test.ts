import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '../agent-runtime.js';
import {
  isBypassSemantics,
  isDivergent,
  stopExpectation,
  warnTier,
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

describe('warnTier', () => {
  it('marks never-asking-and-reaching-everything as danger', () => {
    expect(warnTier(descriptor({ asks: 'never', reach: 'everything' }))).toBe('danger');
  });

  it('marks never-asking within a bounded reach as caution', () => {
    expect(warnTier(descriptor({ asks: 'never', reach: 'workspace' }))).toBe('caution');
    expect(warnTier(descriptor({ asks: 'never', reach: 'edit' }))).toBe('caution');
  });

  it('leaves a read-only mode alone even though it never asks', () => {
    // It has nothing to ask about. Warning about the safest setting on offer is
    // how a warning stops being read.
    expect(warnTier(descriptor({ asks: 'never', reach: 'read' }))).toBe('none');
  });

  it('leaves anything that still stops for the person alone', () => {
    expect(warnTier(descriptor({ asks: 'always', reach: 'everything' }))).toBe('none');
    expect(warnTier(descriptor({ asks: 'when-risky', reach: 'everything' }))).toBe('none');
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
