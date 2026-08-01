import { describe, it, expect } from 'vitest';
import {
  resolveEffectivePermissionMode,
  AUTO_DOWNGRADE_STATUS,
} from '../messaging/permission-mode-guard.js';

describe('resolveEffectivePermissionMode', () => {
  it('coerces auto -> default when the model explicitly does not support auto', () => {
    // Purpose: prevent the SDK 400 when a session is left in auto on an unsupported
    // model (e.g. switched to Haiku). This is the edge case the guard exists for.
    expect(
      resolveEffectivePermissionMode({ permissionMode: 'auto', modelSupportsAutoMode: false })
    ).toEqual({ permissionMode: 'default', autoDowngrade: 'unsupported' });
  });

  it('keeps auto when the model supports it', () => {
    expect(
      resolveEffectivePermissionMode({ permissionMode: 'auto', modelSupportsAutoMode: true })
    ).toEqual({ permissionMode: 'auto', autoDowngrade: null });
  });

  it('coerces auto -> default when support is UNKNOWN, and says so distinctly', () => {
    // `undefined` means the model-capability cache is cold or the model is
    // unrecognized. Passing auto through on a hunch is how the send 400s — the
    // one failure this guard exists to prevent. Downgrading costs at most one
    // turn of Auto on a model that does support it, and the stored mode is
    // untouched, so Auto returns as soon as the capability loads. The reason is
    // NOT 'unsupported': nobody established that.
    expect(
      resolveEffectivePermissionMode({ permissionMode: 'auto', modelSupportsAutoMode: undefined })
    ).toEqual({ permissionMode: 'default', autoDowngrade: 'unconfirmed' });
  });

  it.each([undefined, false] as const)(
    'leaves non-auto modes untouched when auto support is %s',
    (support) => {
      expect(
        resolveEffectivePermissionMode({ permissionMode: 'plan', modelSupportsAutoMode: support })
      ).toEqual({ permissionMode: 'plan', autoDowngrade: null });
    }
  );

  it.each(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const)(
    'leaves non-auto mode "%s" untouched even when the model lacks auto support',
    (mode) => {
      expect(
        resolveEffectivePermissionMode({ permissionMode: mode, modelSupportsAutoMode: false })
      ).toEqual({ permissionMode: mode, autoDowngrade: null });
    }
  );
});

describe('AUTO_DOWNGRADE_STATUS', () => {
  it('states the unsupported case as fact', () => {
    expect(AUTO_DOWNGRADE_STATUS.unsupported).toBe(
      "Auto mode isn't available on this model — using Default instead."
    );
  });

  it('claims nothing about the model, and promises nothing, when support is unconfirmed', () => {
    // This branch fires on a cold cache AND permanently for a model id the cache
    // has never seen. Asserting "Auto mode isn't available on this model" there
    // would state a fact nobody established, on every single send.
    const message = AUTO_DOWNGRADE_STATUS.unconfirmed;
    expect(message).toBe(
      "Couldn't confirm Auto mode works on this model — running this turn in Default."
    );
    expect(message).not.toContain("isn't available");
    // Scoped to this turn, so it never promises Auto is coming back.
    expect(message).toContain('this turn');
  });
});
