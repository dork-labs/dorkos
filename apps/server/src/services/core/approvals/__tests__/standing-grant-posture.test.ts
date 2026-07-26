/**
 * A standing permission must not outlive the posture that justified it
 * (spec `agent-approval-settings` §3.0, §3.7).
 *
 * The failure this guards is a permission granted while login was on waking up
 * again after login is turned off — under a posture where DorkOS cannot tell the
 * person in the cockpit from an agent on the same machine, which is exactly the
 * distinction the permission was resting on.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalGrantService } from '../approval-grant-service.js';
import {
  initStandingGrantPosture,
  resetStandingGrantPosture,
  revokeStandingGrantsIfPostureNarrowed,
} from '../standing-grant-posture.js';

const ON = { loginEnabled: true, standingGrants: true };

describe('revokeStandingGrantsIfPostureNarrowed', () => {
  let grants: ApprovalGrantService;

  beforeEach(() => {
    grants = new ApprovalGrantService(createTestDb());
    initStandingGrantPosture(grants);
    grants.create({
      agentPath: '/Users/dev/agents/dorkbot',
      capabilityId: 'marketplace.uninstall',
      windowMinutes: 480,
      grantedBy: 'user_owner',
      posture: 'signed-in-operator',
    });
  });

  afterEach(() => {
    resetStandingGrantPosture();
  });

  it('ends every live permission when login is turned off', () => {
    expect(revokeStandingGrantsIfPostureNarrowed(ON, { ...ON, loginEnabled: false })).toBe(1);
    expect(grants.list()).toEqual([]);
  });

  it('ends every live permission when the master switch is turned off', () => {
    expect(revokeStandingGrantsIfPostureNarrowed(ON, { ...ON, standingGrants: false })).toBe(1);
    expect(grants.list()).toEqual([]);
  });

  it('leaves permissions alone when nothing narrowed', () => {
    expect(revokeStandingGrantsIfPostureNarrowed(ON, ON)).toBe(0);
    // Turning a setting ON grants nothing and revokes nothing: a permission is
    // always a fresh human decision.
    expect(
      revokeStandingGrantsIfPostureNarrowed({ loginEnabled: false, standingGrants: false }, ON)
    ).toBe(0);
    expect(grants.list()).toHaveLength(1);
  });

  it('reports zero rather than throwing when no store is wired', () => {
    resetStandingGrantPosture();
    expect(revokeStandingGrantsIfPostureNarrowed(ON, { ...ON, loginEnabled: false })).toBe(0);
  });
});
