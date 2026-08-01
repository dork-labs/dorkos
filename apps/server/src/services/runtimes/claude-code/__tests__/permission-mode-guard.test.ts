import { describe, it, expect } from 'vitest';
import { resolveEffectivePermissionMode } from '../messaging/permission-mode-guard.js';

describe('resolveEffectivePermissionMode', () => {
  it('coerces auto -> default when the model explicitly does not support auto', () => {
    // Purpose: prevent the SDK 400 when a session is left in auto on an unsupported
    // model (e.g. switched to Haiku). This is the edge case the guard exists for.
    expect(
      resolveEffectivePermissionMode({ permissionMode: 'auto', modelSupportsAutoMode: false })
    ).toEqual({ permissionMode: 'default', downgradedFromAuto: true });
  });

  it('keeps auto when the model supports it', () => {
    expect(
      resolveEffectivePermissionMode({ permissionMode: 'auto', modelSupportsAutoMode: true })
    ).toEqual({ permissionMode: 'auto', downgradedFromAuto: false });
  });

  it('coerces auto -> default when support is UNKNOWN (cold model cache)', () => {
    // `undefined` means the model-capability cache is cold or the model is
    // unrecognized. Passing auto through on a hunch is how the send 400s — the
    // one failure this guard exists to prevent. Downgrading costs at most one
    // turn of Auto on a model that does support it, and the stored mode is
    // untouched, so Auto returns as soon as the capability loads.
    expect(
      resolveEffectivePermissionMode({ permissionMode: 'auto', modelSupportsAutoMode: undefined })
    ).toEqual({ permissionMode: 'default', downgradedFromAuto: true });
  });

  it.each([undefined, false] as const)(
    'leaves non-auto modes untouched when auto support is %s',
    (support) => {
      expect(
        resolveEffectivePermissionMode({ permissionMode: 'plan', modelSupportsAutoMode: support })
      ).toEqual({ permissionMode: 'plan', downgradedFromAuto: false });
    }
  );

  it.each(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const)(
    'leaves non-auto mode "%s" untouched even when the model lacks auto support',
    (mode) => {
      expect(
        resolveEffectivePermissionMode({ permissionMode: mode, modelSupportsAutoMode: false })
      ).toEqual({ permissionMode: mode, downgradedFromAuto: false });
    }
  );
});
