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

  it('does NOT fire in development by default (the core safety guarantee)', () => {
    expect(resolveTasksFiring({ ...base, nodeEnv: 'development' }).mayFire).toBe(false);
  });

  it('does NOT fire in the test environment by default', () => {
    expect(resolveTasksFiring({ ...base, nodeEnv: 'test' }).mayFire).toBe(false);
  });

  it('fires in production when the master switch is enabled', () => {
    expect(
      resolveTasksFiring({ ...base, nodeEnv: 'production', schedulerEnabled: true }).mayFire
    ).toBe(true);
  });

  it('does NOT fire in production when the master switch is disabled', () => {
    expect(
      resolveTasksFiring({ ...base, nodeEnv: 'production', schedulerEnabled: false }).mayFire
    ).toBe(false);
  });

  it('force-ON: explicit override true fires even in development', () => {
    expect(
      resolveTasksFiring({ ...base, nodeEnv: 'development', explicitOverride: true }).mayFire
    ).toBe(true);
  });

  it('force-OFF: explicit override false suppresses even a production build', () => {
    expect(
      resolveTasksFiring({ ...base, nodeEnv: 'production', explicitOverride: false }).mayFire
    ).toBe(false);
  });

  it('override wins over the master switch (override true, scheduler disabled -> fires)', () => {
    expect(
      resolveTasksFiring({
        nodeEnv: 'production',
        explicitOverride: true,
        schedulerEnabled: false,
      }).mayFire
    ).toBe(true);
  });

  it('a named non-production deployEnv stays OFF even on a production build (forward-compat seam)', () => {
    expect(
      resolveTasksFiring({ ...base, nodeEnv: 'production', deployEnv: 'preview' }).mayFire
    ).toBe(false);
  });

  it('deployEnv "production" does fire (the seam is permissive only for real production)', () => {
    expect(
      resolveTasksFiring({ ...base, nodeEnv: 'production', deployEnv: 'production' }).mayFire
    ).toBe(true);
  });

  it('always returns a non-empty reason for the startup log', () => {
    expect(resolveTasksFiring(base).reason.length).toBeGreaterThan(0);
    expect(
      resolveTasksFiring({ ...base, nodeEnv: 'development', explicitOverride: true }).reason
    ).toContain('override');
  });
});
