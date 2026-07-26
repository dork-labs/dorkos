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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalGrantService } from '../approval-grant-service.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { readStandingGrantPosture, readStandingGrantSettings } from '../standing-grant-settings.js';
import {
  initStandingGrantPosture,
  resetStandingGrantPosture,
  revokeStandingGrantsIfPostureForbids,
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

describe('revokeStandingGrantsIfPostureForbids — the boot floor', () => {
  // The sibling above only fires on a write this process saw. `dorkos config set`
  // edits `~/.dork/config.json` out of process and reaches no seam, so without this
  // a CLI round trip would leave permissions live and wake them up later. Boot is
  // where the invariant "no permission is live unless both settings license one"
  // gets re-established.
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

  it('leaves permissions alone when both settings license them', () => {
    expect(revokeStandingGrantsIfPostureForbids(ON)).toBe(0);
    expect(grants.list()).toHaveLength(1);
  });

  it('ends every permission when the master switch is off', () => {
    expect(revokeStandingGrantsIfPostureForbids({ ...ON, standingGrants: false })).toBe(1);
    expect(grants.list()).toEqual([]);
  });

  it('ends every permission when login is off, which is the half that was missed', () => {
    // The blocking defect this function was extracted to fix. The first boot sweep
    // read only the master switch, so `dorkos config set auth.enabled false` left
    // permissions live AND still honored by the gate — the half §3.0 calls
    // load-bearing. A test that only covered the master switch would have passed
    // against that version.
    expect(revokeStandingGrantsIfPostureForbids({ ...ON, loginEnabled: false })).toBe(1);
    expect(grants.list()).toEqual([]);
  });

  it('ends every permission when neither setting licenses one', () => {
    expect(
      revokeStandingGrantsIfPostureForbids({ loginEnabled: false, standingGrants: false })
    ).toBe(1);
    expect(grants.list()).toEqual([]);
  });

  it('reports zero rather than throwing when no store is wired', () => {
    resetStandingGrantPosture();
    expect(revokeStandingGrantsIfPostureForbids({ ...ON, loginEnabled: false })).toBe(0);
  });
});

describe('readStandingGrantPosture reads BOTH settings', () => {
  // The narrower `readStandingGrantSettings` answers "may the gate honor one" and
  // reads only the master switch; this one answers "may one EXIST", which needs
  // `auth.enabled` too. Boot passing the wrong one of those two was the whole
  // defect, so the reader is pinned here rather than only the function it feeds.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-grant-posture-'));
    initConfigManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports login off, even with the master switch on', () => {
    configManager.set('auth', { enabled: false });
    configManager.set('approvals', { standingGrants: true, trustWindowMinutes: 480 });

    expect(readStandingGrantPosture()).toEqual({ loginEnabled: false, standingGrants: true });
    // …and the narrower reader says the gate may honor one, which is exactly why
    // the two must not be swapped for each other.
    expect(readStandingGrantSettings().enabled).toBe(true);
  });

  it('reports both on when both are on', () => {
    configManager.set('auth', { enabled: true });
    configManager.set('approvals', { standingGrants: true, trustWindowMinutes: 480 });

    expect(readStandingGrantPosture()).toEqual({ loginEnabled: true, standingGrants: true });
  });
});
