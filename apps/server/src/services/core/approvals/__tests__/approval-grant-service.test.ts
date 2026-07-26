/**
 * Lifecycle tests for standing permissions (spec `agent-approval-settings` §3.2).
 *
 * The two behaviors the rest of the feature leans on are pinned here: expiry is
 * evaluated on READ rather than only by the sweep, and re-granting supersedes
 * rather than accumulating. Both are the kind of property that stays true by
 * accident for a long time and then quietly stops.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalGrantService } from '../approval-grant-service.js';

const AGENT = '/Users/dev/agents/dorkbot';
const OTHER_AGENT = '/Users/dev/agents/scout';
const CAPABILITY = 'marketplace.uninstall';

/** The fields every test supplies but none of them are about. */
const WHO = { grantedBy: 'user_owner', posture: 'signed-in-operator' as const };

describe('ApprovalGrantService', () => {
  let grants: ApprovalGrantService;

  beforeEach(() => {
    grants = new ApprovalGrantService(createTestDb());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('covers exactly the agent and capability it was created for', () => {
    grants.create({ agentPath: AGENT, capabilityId: CAPABILITY, windowMinutes: 480, ...WHO });

    expect(grants.findLive(AGENT, CAPABILITY)).toBeDefined();
    // A different agent asking for the same thing is a different question.
    expect(grants.findLive(OTHER_AGENT, CAPABILITY)).toBeUndefined();
    // And the same agent asking for something else has never been answered.
    expect(grants.findLive(AGENT, 'marketplace.install')).toBeUndefined();
  });

  it('never matches a caller that presented no identity', () => {
    grants.create({ agentPath: AGENT, capabilityId: CAPABILITY, windowMinutes: 480, ...WHO });

    // There is no path to look up, so there is nothing to match. This is why
    // dropping a credential can only ever get a caller the gate, never past it.
    expect(grants.findLive('', CAPABILITY)).toBeUndefined();
  });

  it('supersedes rather than accumulates when the same pair is granted again', () => {
    const first = grants.create({
      agentPath: AGENT,
      capabilityId: CAPABILITY,
      windowMinutes: 60,
      ...WHO,
    });
    const second = grants.create({
      agentPath: AGENT,
      capabilityId: CAPABILITY,
      windowMinutes: 480,
      ...WHO,
    });

    expect(second.id).not.toBe(first.id);
    expect(grants.list()).toHaveLength(1);
    expect(grants.findLive(AGENT, CAPABILITY)?.id).toBe(second.id);
  });

  it('evaluates expiry on READ, so a stale row is never honored', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T09:00:00.000Z'));
    grants.create({ agentPath: AGENT, capabilityId: CAPABILITY, windowMinutes: 30, ...WHO });
    expect(grants.findLive(AGENT, CAPABILITY)).toBeDefined();

    // No sweep has run. The row is still in the table; it is simply not live.
    vi.setSystemTime(new Date('2026-07-25T09:31:00.000Z'));
    expect(grants.findLive(AGENT, CAPABILITY)).toBeUndefined();
    expect(grants.list()).toEqual([]);
    expect(grants.purgeExpired(new Date('2026-07-25T09:00:00.000Z'))).toBe(0);
  });

  it('does not slide the window when the permission is used', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T09:00:00.000Z'));
    const created = grants.create({
      agentPath: AGENT,
      capabilityId: CAPABILITY,
      windowMinutes: 60,
      ...WHO,
    });

    // Use it repeatedly, right up to the boundary. The clock does not move: a
    // sliding window would hand the agent control of its own expiry.
    for (const minute of [10, 20, 30, 40, 50]) {
      vi.setSystemTime(new Date(`2026-07-25T09:${String(minute).padStart(2, '0')}:00.000Z`));
      expect(grants.findLive(AGENT, CAPABILITY)?.expiresAt).toBe(created.expiresAt);
    }

    vi.setSystemTime(new Date('2026-07-25T10:00:01.000Z'));
    expect(grants.findLive(AGENT, CAPABILITY)).toBeUndefined();
  });

  it('ends one permission, and says whether this call is what ended it', () => {
    const grant = grants.create({
      agentPath: AGENT,
      capabilityId: CAPABILITY,
      windowMinutes: 480,
      ...WHO,
    });

    expect(grants.revoke(grant.id)).toBe(true);
    expect(grants.findLive(AGENT, CAPABILITY)).toBeUndefined();
    // A second click cannot rewrite the moment it ended.
    expect(grants.revoke(grant.id)).toBe(false);
    expect(grants.revoke('01JZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
  });

  it('ends every live permission at once, for the master switch', () => {
    grants.create({ agentPath: AGENT, capabilityId: CAPABILITY, windowMinutes: 480, ...WHO });
    grants.create({
      agentPath: OTHER_AGENT,
      capabilityId: CAPABILITY,
      windowMinutes: 480,
      ...WHO,
    });

    expect(grants.revokeAll()).toBe(2);
    expect(grants.list()).toEqual([]);
    // Nothing is left dormant to wake up if the switch comes back on.
    expect(grants.revokeAll()).toBe(0);
  });

  it('sweeps rows whose window closed before the cutoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T09:00:00.000Z'));
    grants.create({ agentPath: AGENT, capabilityId: CAPABILITY, windowMinutes: 60, ...WHO });

    vi.setSystemTime(new Date('2026-07-27T09:00:00.000Z'));
    expect(grants.purgeExpired()).toBe(1);
  });

  it('records the posture and the source card the decision came from', () => {
    const grant = grants.create({
      agentPath: AGENT,
      capabilityId: CAPABILITY,
      windowMinutes: 480,
      grantedBy: 'Local operator',
      posture: 'local-trust',
      sourceApprovalId: '01JAPPROVAL',
    });

    expect(grant.posture).toBe('local-trust');
    expect(grant.grantedBy).toBe('Local operator');
    expect(grant.sourceApprovalId).toBe('01JAPPROVAL');
  });
});
