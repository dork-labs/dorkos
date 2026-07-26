import { describe, it, expect } from 'vitest';
import { isBypassPermissionMode } from '../permission-mode';

describe('isBypassPermissionMode', () => {
  it('flags the modes that let the agent act without asking', () => {
    expect(isBypassPermissionMode('bypassPermissions')).toBe(true);
    // The test-mode runtime's spelling of the same thing.
    expect(isBypassPermissionMode('always-allow')).toBe(true);
  });

  it('leaves the modes that still ask alone', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto', 'always-deny']) {
      expect(isBypassPermissionMode(mode)).toBe(false);
    }
  });

  it('treats an unknown session as asking rather than bypassing', () => {
    // A missing mode must never read as "bypassing" — a false warning on every
    // unloaded session would train people to ignore the real one.
    expect(isBypassPermissionMode(null)).toBe(false);
    expect(isBypassPermissionMode(undefined)).toBe(false);
    expect(isBypassPermissionMode('')).toBe(false);
  });
});
