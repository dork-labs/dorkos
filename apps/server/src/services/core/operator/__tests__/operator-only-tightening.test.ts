/**
 * The table of strictest values a Full turn may write to a person's setting on its own
 * (DOR-3426): each entry names a real operator-only setting, and only those exact values count.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { OPERATOR_ONLY_CONFIG_PATHS } from '../config-write-policy.js';
import {
  patchOnlyTightens,
  personSettingsRaised,
  SAFEST_VALUES,
} from '../operator-only-tightening.js';

describe('the strictest values', () => {
  it('names only operator-only settings', () => {
    for (const path of SAFEST_VALUES.keys()) expect(OPERATOR_ONLY_CONFIG_PATHS).toContain(path);
  });

  it('leaves out sign-in and the preset on purpose', () => {
    expect(SAFEST_VALUES.has('auth.enabled')).toBe(false);
    expect(SAFEST_VALUES.has('permissions.preset')).toBe(false);
  });
});

describe('patchOnlyTightens', () => {
  it('is true only when every person-only setting is set to its strictest value', () => {
    expect(patchOnlyTightens({ tunnel: { enabled: false } })).toBe(true);
    expect(patchOnlyTightens({ tunnel: { enabled: false }, ui: { theme: 'dark' } })).toBe(true);
    expect(patchOnlyTightens({ tunnel: { enabled: true } })).toBe(false);
    expect(patchOnlyTightens({ tunnel: { enabled: false, domain: 'x' } })).toBe(false);
    expect(patchOnlyTightens({ tunnel: { enabled: 'false' } })).toBe(false);
  });

  it('is false for a patch that touches no person-only setting', () => {
    expect(patchOnlyTightens({ ui: { theme: 'dark' } })).toBe(false);
    expect(patchOnlyTightens(undefined)).toBe(false);
  });
});

describe('personSettingsRaised', () => {
  it('names each raise with its area, and no tightening', () => {
    expect(personSettingsRaised({ tunnel: { enabled: false, domain: 'x' } })).toEqual([
      '`tunnel.domain` (Reach & secrets)',
    ]);
    expect(personSettingsRaised({ tunnel: { enabled: false } })).toEqual([]);
  });
});
