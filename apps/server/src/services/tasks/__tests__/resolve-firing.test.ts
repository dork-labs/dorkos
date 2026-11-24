import { describe, it, expect } from 'vitest';
import { resolveTasksFiring, type FiringInput } from '../resolve-firing.js';

/**
 * The production gate (ADR-285): firing defaults OFF for every non-production
 * environment; DORKOS_TASKS_ENABLED is an explicit override in both directions;
 * a named non-production deployEnv stays off even on a production build.
 */
describe('resolveTasksFiring', () => {
  const base: FiringInput = {
    nodeEnv: 'production',
    explicitOverride: undefined,
    schedulerEnabled: true,
  };

  it.each([
    ['development, by default (the core safety guarantee)', { nodeEnv: 'development' }, false],
    ['production with the master switch on', {}, true],
    ['production with the master switch off', { schedulerEnabled: false }, false],
    ['development forced ON', { nodeEnv: 'development', explicitOverride: true }, true],
    ['production forced OFF', { explicitOverride: false }, false],
    [
      'forced ON over a switched-off scheduler',
      { explicitOverride: true, schedulerEnabled: false },
      true,
    ],
    ['a production build in a preview deployEnv', { deployEnv: 'preview' }, false],
  ] as const)('%s', (_label, input, mayFire) => {
    expect(resolveTasksFiring({ ...base, ...input } as FiringInput).mayFire).toBe(mayFire);
  });
});
