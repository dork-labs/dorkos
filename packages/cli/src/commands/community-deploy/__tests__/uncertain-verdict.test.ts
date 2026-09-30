import { describe, expect, it } from 'vitest';
import type { LaunchJournal } from '../journal.js';
import { PROVENANCE_ROUND_TRIP_PROVED } from '../provenance/provenance-gate.js';
import { COMMUNITY_SERVICE_TIMEOUT_MS } from '../provider-process.js';
import { PROVIDER_WRITE_TIMEOUT_MS } from '../provider-mutation.js';
import {
  DEFAULT_CREATE_DEADLINE_MS,
  TIGRIS_CREATE_DEADLINE_MS,
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

  // The committed gate is open for Fly and Neon (receipt dorkos-gate-376b14cf0957); Tigris follows Fly.
  it('proves every service with the committed gate', () => {
    expect(PROVENANCE_ROUND_TRIP_PROVED).toEqual({ fly: true, neon: true });
    for (const [journal, result] of [
      [shapeA('fly'), found.fly()],
      [shapeA('neon'), found.neon()],
      [shapeA('tigris'), found.tigris()],
    ] as const) {
      // No gate passed: the committed constant applies.
      expect(evaluateUncertainResource(journal, journal.pendingIntent!, result)).toMatchObject({
        verdict: 'proved',
      });
    }
  });

  it('never proves a service whose gate is closed', () => {
    for (const [journal, result, gate] of [
      [shapeA('fly'), found.fly(), { fly: false, neon: true }],
      [shapeA('neon'), found.neon(), { fly: true, neon: false }],
      [shapeA('tigris'), found.tigris(), { fly: false, neon: true }],
    ] as const) {
      expect(
        evaluateUncertainResource(journal, journal.pendingIntent!, result, { gate })
      ).toMatchObject({ verdict: 'unproved', reason: 'not-confirmed' });
    }
  });

  it.each([
    ['a different marker', { network: `dorkos-${OTHER_MARKER}` }, 'different-marker'],
    ['no network', { network: null }, 'different-marker'],
    ['the default network', { network: 'default' }, 'different-marker'],
    ['a time before the window', { createdAt: '2026-09-23T10:28:59Z' }, 'outside-window'],
    ['a time after the window', { createdAt: '2026-09-23T10:36:00Z' }, 'outside-window'],
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

  // The Tigris create makes three bounded reads (app listing, fly auth token, terms check) after
  // its intent is written and before createAddOn, so its window is wider than one call's.
  // Creates run under the shared write deadline (#2374), so a create cut off at that deadline, as
  // seen through up to two minutes of clock skew, must still be inside its window: that slow,
  // cut-off create is exactly the case removal exists for. Requested at 10:31:03.
  it('sizes every create window from the write deadline, and Tigris also from its reads', () => {
    expect(DEFAULT_CREATE_DEADLINE_MS).toBe(PROVIDER_WRITE_TIMEOUT_MS);
    expect(TIGRIS_CREATE_DEADLINE_MS).toBe(
      3 * COMMUNITY_SERVICE_TIMEOUT_MS + PROVIDER_WRITE_TIMEOUT_MS
    );
    // Fly and Neon: request + 2 min write deadline + 2 min skew = 10:35:03.
    const flyEdge = '2026-09-23T10:35:03Z';
    expect(evaluate(shapeA('fly'), found.fly({ createdAt: flyEdge }))).toMatchObject({
      verdict: 'proved',
    });
    expect(evaluate(shapeA('neon'), found.neon(neonProject({ createdAt: flyEdge })))).toMatchObject(
      { verdict: 'proved' }
    );
    for (const past of ['2026-09-23T10:35:04Z']) {
      expect(evaluate(shapeA('fly'), found.fly({ createdAt: past }))).toMatchObject({
        reason: 'outside-window',
      });
      expect(evaluate(shapeA('neon'), found.neon(neonProject({ createdAt: past })))).toMatchObject({
        reason: 'outside-window',
      });
    }
    // Tigris: request + 3 x 30 s reads + 2 min write deadline + 2 min skew = 10:36:33.
    const addOn = (createdAt: string) => ({
      addOns: [{ token: 'addon-5', name: 'community-acme', organization: 'acme', createdAt }],
    });
    expect(evaluate(shapeA('tigris'), found.tigris(addOn('2026-09-23T10:36:33Z')))).toMatchObject({
      verdict: 'proved',
    });
    expect(evaluate(shapeA('tigris'), found.tigris(addOn('2026-09-23T10:36:34Z')))).toMatchObject({
      reason: 'outside-window',
    });
    // The margin also covers a service clock two minutes behind this one.
    expect(evaluate(shapeA('fly'), found.fly({ createdAt: '2026-09-23T10:29:03Z' }))).toMatchObject(
      {
        verdict: 'proved',
      }
    );
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
