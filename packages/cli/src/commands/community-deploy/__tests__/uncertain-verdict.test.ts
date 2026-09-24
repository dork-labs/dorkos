import { describe, expect, it } from 'vitest';
import type { LaunchJournal } from '../journal.js';
import { PROVENANCE_ROUND_TRIP_PROVED } from '../provenance/provenance-gate.js';
import {
  evaluateUncertainResource,
  tokenConfirms,
  type FlyAppFacts,
  type ProbeResult,
  type TigrisFacts,
} from '../provenance/uncertain-removal.js';
import {
  OTHER_MARKER,
  NETWORK,
  ROLE,
  CREATED_AT,
  OPEN,
  intentFor,
  shapeA,
  neonProject,
  found,
} from './uncertain-removal-fixtures.js';

function evaluate(journal: LaunchJournal, result: ProbeResult, gate = OPEN) {
  return evaluateUncertainResource(journal, journal.pendingIntent!, result, { gate });
}

describe('uncertain removal verdicts', () => {
  it('proves a Fly app that carries the run marker and was created in the window', () => {
    const verdict = evaluate(shapeA('fly'), found.fly());
    expect(verdict).toMatchObject({
      verdict: 'proved',
      target: { provider: 'fly', token: '4817203', proof: 'marker', proofValue: NETWORK },
    });
  });

  it('never proves anything while the committed gate is closed', () => {
    expect(PROVENANCE_ROUND_TRIP_PROVED).toEqual({ fly: false, neon: false });
    for (const [journal, result] of [
      [shapeA('fly'), found.fly()],
      [shapeA('neon'), found.neon()],
      [shapeA('tigris'), found.tigris()],
    ] as const) {
      // No gate passed: the committed constant applies.
      expect(evaluateUncertainResource(journal, journal.pendingIntent!, result)).toMatchObject({
        verdict: 'unproved',
        reason: 'not-confirmed',
      });
    }
  });

  it.each([
    ['a different marker', { network: `dorkos-${OTHER_MARKER}` }, 'different-marker'],
    ['no network', { network: null }, 'different-marker'],
    ['the default network', { network: 'default' }, 'different-marker'],
    ['a time before the window', { createdAt: '2026-09-23T10:28:59Z' }, 'outside-window'],
    ['a time after the window', { createdAt: '2026-09-23T10:34:00Z' }, 'outside-window'],
    ['a Machine', { machines: 1 }, 'grown'],
    ['a volume', { volumes: 1 }, 'grown'],
    ['an IP address', { ipAddresses: 1 }, 'grown'],
    ['a certificate', { certificates: 1 }, 'grown'],
    ['a secret', { secretNames: ['EXTRA'] }, 'grown'],
  ] as const)('does not prove a Fly app with %s', (_label, update, reason) => {
    expect(evaluate(shapeA('fly'), found.fly(update as Partial<FlyAppFacts>))).toMatchObject({
      verdict: 'unproved',
      reason,
      candidates: [{ token: '4817203', reason }],
    });
  });

  it('reports a same-name Fly app in another organization as absent from this one', () => {
    expect(evaluate(shapeA('fly'), found.fly({ organization: 'someone-else' }))).toEqual({
      verdict: 'absent',
    });
  });

  it('refuses a run without a marker or a request time before reading anything', () => {
    const legacy = shapeA('fly', {
      pendingIntent: { provider: 'fly', organizationId: 'acme', resourceName: 'community-acme' },
    });
    expect(evaluate(legacy, found.fly())).toEqual({
      verdict: 'unproved',
      reason: 'no-marker',
      candidates: [],
    });
    expect(
      evaluate(
        shapeA('fly', { pendingIntent: intentFor('fly', { requestedAt: undefined }) }),
        found.fly()
      )
    ).toMatchObject({ reason: 'no-marker' });
    expect(evaluate(shapeA('fly', { recoveryContext: undefined }), found.fly())).toMatchObject({
      reason: 'too-old',
    });
  });

  it('proves only the marked Neon project and lists a same-name one as not from this run', () => {
    const verdict = evaluate(
      shapeA('neon'),
      found.neon(neonProject(), neonProject({ token: 'project-other', roles: ['community_owner'] }))
    );
    expect(verdict).toMatchObject({
      verdict: 'proved',
      target: { provider: 'neon', token: 'project-9', proofValue: ROLE },
      notFromRun: [{ token: 'project-other', reason: 'different-marker' }],
    });
  });

  it.each([
    ['two marked projects', [neonProject(), neonProject({ token: 'p2' })], 'several'],
    ['no created_at', [neonProject({ createdAt: undefined })], 'outside-window'],
    ['another region', [neonProject({ region: 'aws-eu-central-1' })], 'other-region'],
    ['another organization', [neonProject({ organization: 'org-x' })], 'other-organization'],
    ['two default branches', [neonProject({ defaultBranchCount: 2 })], 'different-marker'],
    ['an extra branch', [neonProject({ branchCount: 2 })], 'grown'],
    ['an extra role', [neonProject({ roles: [ROLE, 'reader'] })], 'grown'],
    ['an extra database', [neonProject({ databases: ['community', 'other'] })], 'grown'],
    [
      'two unmarked projects',
      [neonProject({ roles: [] }), neonProject({ token: 'p2', roles: [] })],
      'no-match',
    ],
  ] as const)('does not prove Neon with %s', (_label, projects, reason) => {
    expect(evaluate(shapeA('neon'), found.neon(...projects))).toMatchObject({
      verdict: 'unproved',
      reason,
    });
  });

  it('proves a Tigris bucket only through its re-proved app', () => {
    expect(evaluate(shapeA('tigris'), found.tigris())).toMatchObject({
      verdict: 'proved',
      target: { provider: 'tigris', token: 'addon-5', proof: 'binding', appName: 'community-acme' },
    });
  });

  it.each([
    [
      'an app with a different network now',
      { app: { name: 'community-acme', organization: 'acme', network: NETWORK } },
      'bound-app-unproved',
    ],
    [
      'an app without a network',
      { app: { name: 'community-acme', organization: 'acme', network: null } },
      'bound-app-unproved',
    ],
    ['an incomplete add-on list', { totalCount: 2 }, 'incomplete-list'],
    [
      'an add-on created outside the window',
      {
        addOns: [
          {
            token: 'addon-5',
            name: 'community-acme',
            organization: 'acme',
            createdAt: '2026-09-22T00:00:00Z',
          },
        ],
      },
      'outside-window',
    ],
    [
      'two add-ons with the name',
      {
        totalCount: 2,
        addOns: [
          { token: 'a1', name: 'community-acme', organization: 'acme', createdAt: CREATED_AT },
          { token: 'a2', name: 'community-acme', organization: 'acme', createdAt: CREATED_AT },
        ],
      },
      'several',
    ],
  ] as const)('does not prove Tigris with %s', (_label, update, reason) => {
    expect(evaluate(shapeA('tigris'), found.tigris(update as Partial<TigrisFacts>))).toMatchObject({
      verdict: 'unproved',
      reason,
    });
  });

  it('does not prove Tigris when the app carries no read-back network, or is missing', () => {
    expect(evaluate(shapeA('tigris', { provenance: undefined }), found.tigris())).toMatchObject({
      reason: 'no-marker',
    });
    expect(evaluate(shapeA('tigris'), { kind: 'tigris', facts: null })).toMatchObject({
      reason: 'bound-app-unproved',
    });
    expect(evaluate(shapeA('tigris'), found.tigris({ totalCount: 0, addOns: [] }))).toEqual({
      verdict: 'absent',
    });
  });

  it('follows the Fly gate for Tigris', () => {
    expect(evaluate(shapeA('tigris'), found.tigris(), { fly: false, neon: true })).toMatchObject({
      reason: 'not-confirmed',
    });
  });

  it('never accepts the Fly app name as a confirmation token', () => {
    const target = {
      provider: 'fly' as const,
      token: '4817203',
      resourceName: 'community-acme',
      organization: 'acme',
      proof: 'marker' as const,
      appName: 'community-acme',
    };
    expect(tokenConfirms(target, '4817203')).toBe(true);
    expect(tokenConfirms(target, 'community-acme')).toBe(false);
    expect(tokenConfirms({ ...target, token: 'community-acme' }, 'community-acme')).toBe(false);
    expect(tokenConfirms(target, '')).toBe(false);
    expect(tokenConfirms(target, '4817203 ')).toBe(false);
  });
});
