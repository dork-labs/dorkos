/**
 * The words both consent dialogs put on screen, and the two shapes they must
 * never put them on (spec `trust-dial`, decision 5; DOR-816).
 *
 * Tested at the function rather than through a dialog because it is exported
 * from `shared/ui`'s barrel: the four call sites all hand it a mode the door
 * already accepted, so a defect here is invisible from any of them — and stays
 * invisible right up until a fifth caller does the obvious thing.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { consentActionLabel, consentAsksNote } from '../consent-ritual-copy';

/** A declared mode, with only the semantics under test spelled out. */
function descriptor(overrides: Partial<PermissionModeDescriptor>): PermissionModeDescriptor {
  return {
    id: 'mode',
    label: 'Mode',
    stop: 'act',
    asks: 'never',
    reach: 'workspace',
    promise: 'Works inside the project without asking.',
    ...overrides,
  };
}

describe('consentActionLabel', () => {
  it('names the dial position, not the runtime’s word for the mode', () => {
    // A person pressed a segment labelled "Act". A dialog headed "Turn on
    // Workspace write" names something that is nowhere on their screen.
    expect(consentActionLabel(descriptor({ stop: 'act', label: 'Workspace write' }))).toBe(
      'Turn on Act'
    );
    expect(consentActionLabel(descriptor({ stop: 'autonomy', label: 'Full access' }))).toBe(
      'Turn on Full autonomy'
    );
  });
});

describe('consentAsksNote', () => {
  it('says the thing the middle stop’s name hides', () => {
    expect(consentAsksNote(descriptor({ stop: 'act', asks: 'never', reach: 'workspace' }))).toBe(
      'This stop never pauses to ask. Whatever it decides to do, it does.'
    );
    expect(consentAsksNote(descriptor({ stop: 'act', asks: 'never', reach: 'edit' }))).toBe(
      'This stop never pauses to ask. Whatever it decides to do, it does.'
    );
  });

  it('is silent at the autonomy stop, where the title already says it', () => {
    expect(
      consentAsksNote(descriptor({ stop: 'autonomy', asks: 'never', reach: 'everything' }))
    ).toBeNull();
    // Including a sandboxed one, and one that (hypothetically) still asks.
    expect(
      consentAsksNote(descriptor({ stop: 'autonomy', asks: 'never', reach: 'workspace' }))
    ).toBeNull();
    expect(
      consentAsksNote(descriptor({ stop: 'autonomy', asks: 'always', reach: 'everything' }))
    ).toBeNull();
  });

  it.each([
    ['ask', 'Codex’s shipped read-only default'],
    ['act', 'the same read-only shape filed one stop along'],
  ] as const)('is silent for a read-only mode at the %s stop — %s', (stop, _why) => {
    // It "never asks" because it cannot write, run, or reach the network.
    // Telling somebody it does whatever it decides to do is the opposite of
    // true, and it is the safest setting the runtime offers. This is the
    // guard `needsConsentRitual` supplies; plain `asks === 'never'` failed it.
    expect(consentAsksNote(descriptor({ stop, asks: 'never', reach: 'read' }))).toBeNull();
  });

  it('is silent for anything that still stops for the person', () => {
    expect(
      consentAsksNote(descriptor({ stop: 'act', asks: 'when-risky', reach: 'workspace' }))
    ).toBeNull();
    expect(consentAsksNote(descriptor({ stop: 'ask', asks: 'always', reach: 'edit' }))).toBeNull();
  });

  it('speaks for exactly the modes the consent door opens for, minus the autonomy stop', () => {
    // The whole 36-shape space, so a future edit cannot put this sentence in
    // front of a mode nobody meant it for. The expectation is deliberately
    // written from the PRODUCT rule — the door's traffic, less the stop whose
    // title already carries the promise — rather than from the implementation.
    const stops = ['ask', 'act', 'autonomy'] as const;
    const asks = ['always', 'when-risky', 'never'] as const;
    const reaches = ['read', 'edit', 'workspace', 'everything'] as const;
    for (const stop of stops) {
      for (const ask of asks) {
        for (const reach of reaches) {
          const d = descriptor({ stop, asks: ask, reach });
          const opensTheDoor = stop === 'autonomy' || (ask === 'never' && reach !== 'read');
          const expected = opensTheDoor && stop !== 'autonomy';
          expect(consentAsksNote(d) !== null, `${stop}/${ask}/${reach}`).toBe(expected);
        }
      }
    }
  });
});
