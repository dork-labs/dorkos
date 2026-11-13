/**
 * The table of strictest values a Full turn may write to a person's setting on its own
 * (DOR-3426): each entry names a real operator-only setting, and only those exact values count.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { OPERATOR_ONLY_CONFIG_PATHS } from '../config-write-policy.js';
import type { ConfigWriteAuthority } from '../config-write.js';
import {
  patchOnlyTightens,
  PERSON_TURNS_ON_ONLY_CODE,
  personSettingsRaised,
  refuseAgentRaises,
  SAFEST_VALUES,
  unattendedConfigAuthority,
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

describe('remote access through an agent (DOR-3650)', () => {
  const allowAll: ConfigWriteAuthority = { refuseOperatorOnly: () => undefined };

  it('lets an agent turn it off on its own at Full', () => {
    const patch = { remoteAccess: { enabled: false } };
    expect(patchOnlyTightens(patch)).toBe(true);
    const authority = refuseAgentRaises(
      unattendedConfigAuthority(patch, { via: 'permission', source: 'floor' }),
      patch
    );
    expect(authority.refuseOperatorOnly(['remoteAccess.enabled'])).toBeUndefined();
  });

  it('never lets an agent turn it on, even with a person yes on a card', () => {
    const patch = { remoteAccess: { enabled: true } };
    const refusal = refuseAgentRaises(allowAll, patch).refuseOperatorOnly(['remoteAccess.enabled']);
    expect(refusal).toMatchObject({
      status: 403,
      code: PERSON_TURNS_ON_ONLY_CODE,
      paths: ['remoteAccess.enabled'],
    });
  });

  it('leaves every other setting to the authority it wraps', () => {
    const patch = { tunnel: { enabled: true } };
    expect(refuseAgentRaises(allowAll, patch).refuseOperatorOnly(['tunnel.enabled'])).toBe(
      undefined
    );
  });

  it('refuses a raise without an approval through the tool authority', () => {
    const patch = { remoteAccess: { enabled: true } };
    expect(
      refuseAgentRaises(unattendedConfigAuthority(patch, undefined), patch).refuseOperatorOnly([
        'remoteAccess.enabled',
      ])
    ).toMatchObject({ status: 403 });
  });
});
