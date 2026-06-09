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

  it('keeps auto when support is unknown (never downgrades on uncertainty)', () => {
    // Cold cache / unrecognized model — undefined must NOT trigger a downgrade, or we
    // would strip auto from a supported model whose capability simply has not loaded.
    expect(
      resolveEffectivePermissionMode({ permissionMode: 'auto', modelSupportsAutoMode: undefined })
    ).toEqual({ permissionMode: 'auto', downgradedFromAuto: false });
  });

  it.each(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const)(
    'leaves non-auto mode "%s" untouched even when the model lacks auto support',
    (mode) => {
      expect(
        resolveEffectivePermissionMode({ permissionMode: mode, modelSupportsAutoMode: false })
      ).toEqual({ permissionMode: mode, downgradedFromAuto: false });
    }
  );
});
