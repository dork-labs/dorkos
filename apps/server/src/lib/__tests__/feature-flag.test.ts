import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('createFeatureFlag', () => {
  let createFeatureFlag: typeof import('../feature-flag.js').createFeatureFlag;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../feature-flag.js');
    createFeatureFlag = mod.createFeatureFlag;
  });

  it('stays disabled until startup reports success', () => {
    const flag = createFeatureFlag();
    expect(flag.isEnabled()).toBe(false);
  });

  it('setEnabled(true) enables the flag', () => {
    const flag = createFeatureFlag();
    flag.setEnabled(true);
    expect(flag.isEnabled()).toBe(true);
  });

  it('setEnabled(false) disables the flag', () => {
    const flag = createFeatureFlag();
    flag.setEnabled(true);
    flag.setEnabled(false);
    expect(flag.isEnabled()).toBe(false);
  });

  it('setEnabled(true) then setEnabled(false) toggles correctly', () => {
    const flag = createFeatureFlag();
    flag.setEnabled(true);
    expect(flag.isEnabled()).toBe(true);
    flag.setEnabled(false);
    expect(flag.isEnabled()).toBe(false);
    flag.setEnabled(true);
    expect(flag.isEnabled()).toBe(true);
  });

  it('error state tracks independently from enabled state', () => {
    const flag = createFeatureFlag();

    // Initially no error
    expect(flag.getInitError()).toBeUndefined();

    // Set error does not turn a subsystem on.
    flag.setInitError('Database connection failed');
    expect(flag.isEnabled()).toBe(false);
    expect(flag.getInitError()).toBe('Database connection failed');

    // Changing running state does not discard the error.
    flag.setEnabled(true);
    expect(flag.isEnabled()).toBe(true);
    expect(flag.getInitError()).toBe('Database connection failed');

    flag.setEnabled(false);
    expect(flag.isEnabled()).toBe(false);
    expect(flag.getInitError()).toBe('Database connection failed');
  });

  it('error can be set and retrieved', () => {
    const flag = createFeatureFlag();
    flag.setInitError('Init failed');
    expect(flag.getInitError()).toBe('Init failed');
  });

  it('error can be overwritten', () => {
    const flag = createFeatureFlag();
    flag.setInitError('First error');
    flag.setInitError('Second error');
    expect(flag.getInitError()).toBe('Second error');
  });

  it('error defaults to undefined', () => {
    const flag = createFeatureFlag();
    expect(flag.getInitError()).toBeUndefined();
  });

  it('multiple flags are independent', () => {
    const flagA = createFeatureFlag();
    const flagB = createFeatureFlag();

    // Neither claims to be running before its own startup succeeds.
    expect(flagA.isEnabled()).toBe(false);
    expect(flagB.isEnabled()).toBe(false);

    // Disable A, B stays at its independent fail-closed default.
    flagA.setEnabled(false);
    expect(flagA.isEnabled()).toBe(false);
    expect(flagB.isEnabled()).toBe(false);

    // Disable B, A stays disabled
    flagB.setEnabled(false);
    expect(flagA.isEnabled()).toBe(false);
    expect(flagB.isEnabled()).toBe(false);

    // Enable A, B stays disabled
    flagA.setEnabled(true);
    expect(flagA.isEnabled()).toBe(true);
    expect(flagB.isEnabled()).toBe(false);
  });

  it('multiple flags maintain separate error states', () => {
    const flagA = createFeatureFlag();
    const flagB = createFeatureFlag();

    flagA.setInitError('Error A');
    flagB.setInitError('Error B');

    expect(flagA.getInitError()).toBe('Error A');
    expect(flagB.getInitError()).toBe('Error B');
  });

  it('setting error on one flag does not affect another', () => {
    const flagA = createFeatureFlag();
    const flagB = createFeatureFlag();

    flagA.setInitError('Error A');

    expect(flagA.getInitError()).toBe('Error A');
    expect(flagB.getInitError()).toBeUndefined();
  });

  it('flag state is mutable across multiple calls', () => {
    const flag = createFeatureFlag();

    // Rapid toggling
    for (let i = 0; i < 10; i++) {
      flag.setEnabled(i % 2 === 0);
    }
    // After 10 iterations (0-9), last i=9 sets false
    expect(flag.isEnabled()).toBe(false);
  });
});
