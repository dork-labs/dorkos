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
import { eventFanOut } from '../../event-fan-out.js';

const AGENT = '/Users/dev/agents/dorkbot';
const OTHER_AGENT = '/Users/dev/agents/scout';
const CAPABILITY = 'marketplace.uninstall';

/** The fields every test supplies but none of them are about. */
const WHO = { grantedBy: 'user_owner', posture: 'signed-in-operator' as const };

describe('ApprovalGrantService', () => {
  let grants: ApprovalGrantService;
  let broadcast: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    grants = new ApprovalGrantService(createTestDb());
    broadcast = vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  describe('announcing itself', () => {
    // The cockpit lists live permissions in two places. Every change has to reach
    // both, including the two that happen nowhere near a route: the master switch
    // going off and Require login going off both call revokeAll directly.
    it('announces a permission being opened', () => {
      const row = grants.create({
        agentPath: AGENT,
        capabilityId: CAPABILITY,
        windowMinutes: 480,
        ...WHO,
      });

      expect(broadcast).toHaveBeenCalledWith(
        'approval_grant_changed',
        expect.objectContaining({ change: 'created', grantId: row.id })
      );
    });

    it('announces a permission being ended', () => {
      const row = grants.create({
        agentPath: AGENT,
        capabilityId: CAPABILITY,
        windowMinutes: 480,
        ...WHO,
      });
      broadcast.mockClear();

      grants.revoke(row.id);

      expect(broadcast).toHaveBeenCalledWith(
        'approval_grant_changed',
        expect.objectContaining({ change: 'revoked', grantId: row.id })
      );
    });

    it('says nothing when a second click ends nothing', () => {
      const row = grants.create({
        agentPath: AGENT,
        capabilityId: CAPABILITY,
        windowMinutes: 480,
        ...WHO,
      });
      grants.revoke(row.id);
      broadcast.mockClear();

      grants.revoke(row.id);

      expect(broadcast).not.toHaveBeenCalled();
    });

    it('announces the sweep that ends every permission at once', () => {
      grants.create({ agentPath: AGENT, capabilityId: CAPABILITY, windowMinutes: 480, ...WHO });
      grants.create({
        agentPath: OTHER_AGENT,
        capabilityId: CAPABILITY,
        windowMinutes: 480,
        ...WHO,
      });
      broadcast.mockClear();

      grants.revokeAll();

      expect(broadcast).toHaveBeenCalledWith(
        'approval_grant_changed',
        expect.objectContaining({ change: 'ended-all' })
      );
    });
  });
});

describe('the posture floor', () => {
  // A permission granted at or before the moment the settings last stopped
  // licensing permissions is void (DOR-520). Both sides are asserted in every test
  // here on purpose: a comparison reversed by one character would still hide
  // SOMETHING, and an install that never toggled the setting has no floor at all,
  // so the common path looks identical whichever way the comparison runs.
  const BEFORE = '2026-07-26T09:00:00.000Z';
  const FLOOR = '2026-07-26T10:00:00.000Z';
  const AFTER = '2026-07-26T11:00:00.000Z';

  /** A store whose floor is fixed, and a clock so `grantedAt` lands where we say. */
  function storeWithFloor(floor: string | null) {
    return new ApprovalGrantService(createTestDb(), () => floor);
  }

  /** Open a permission stamped at `at`, with a window long enough to outlive it. */
  function permitAt(store: ApprovalGrantService, at: string) {
    vi.setSystemTime(new Date(at));
    return store.create({
      agentPath: AGENT,
      capabilityId: CAPABILITY,
      windowMinutes: 1440,
      ...WHO,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides a permission granted before the floor and keeps the one granted after', () => {
    const stale = storeWithFloor(FLOOR);
    permitAt(stale, BEFORE);
    vi.setSystemTime(new Date(AFTER));
    expect(stale.findLive(AGENT, CAPABILITY)).toBeUndefined();
    expect(stale.list()).toEqual([]);

    const fresh = storeWithFloor(FLOOR);
    permitAt(fresh, AFTER);
    vi.setSystemTime(new Date(AFTER));
    expect(fresh.findLive(AGENT, CAPABILITY)).toBeDefined();
    expect(fresh.list()).toHaveLength(1);
  });

  it('voids a permission granted in the same instant the floor was stamped', () => {
    // The boundary is inclusive on the void side. A permission and the narrowing
    // that killed it landing in the same millisecond is a coin flip about which
    // came first, and the safe answer to a coin flip about a safety setting is to
    // stop honoring the permission.
    const store = storeWithFloor(FLOOR);
    permitAt(store, FLOOR);
    vi.setSystemTime(new Date(AFTER));
    expect(store.findLive(AGENT, CAPABILITY)).toBeUndefined();
  });

  it('honors everything when no floor has ever been stamped', () => {
    const store = storeWithFloor(null);
    permitAt(store, BEFORE);
    vi.setSystemTime(new Date(AFTER));
    expect(store.findLive(AGENT, CAPABILITY)).toBeDefined();
  });

  it('re-reads the floor on every lookup rather than capturing it', () => {
    // The floor moves when a person changes a setting, and the store is built once
    // at boot. A floor captured in the constructor would answer a question that has
    // stopped being current — the same reason the tier gate re-reads the master
    // switch per call.
    let floor: string | null = null;
    const store = new ApprovalGrantService(createTestDb(), () => floor);
    permitAt(store, BEFORE);
    vi.setSystemTime(new Date(AFTER));
    expect(store.findLive(AGENT, CAPABILITY)).toBeDefined();

    floor = FLOOR;
    expect(store.findLive(AGENT, CAPABILITY)).toBeUndefined();
  });

  it('ends the voided rows for real when asked, and leaves the rest alone', () => {
    const store = storeWithFloor(FLOOR);
    permitAt(store, BEFORE);
    permitAt(store, AFTER);
    vi.setSystemTime(new Date(AFTER));

    // Two rows exist; only the one below the floor is ended. `create` supersedes
    // per pair, so the earlier row is already revoked by the later one — this
    // asserts the sweep touches nothing it should not rather than a count.
    expect(store.revokeVoidedByPosture()).toBe(0);
    expect(store.list()).toHaveLength(1);

    // A different pair, granted below the floor, is the one with something to end.
    permitAt(store, BEFORE);
    vi.setSystemTime(new Date(AFTER));
    const stale = new ApprovalGrantService(createTestDb(), () => FLOOR);
    permitAt(stale, BEFORE);
    vi.setSystemTime(new Date(AFTER));
    expect(stale.revokeVoidedByPosture()).toBe(1);
    expect(stale.revokeVoidedByPosture()).toBe(0);
  });

  it('sweeps nothing when there is no floor', () => {
    const store = storeWithFloor(null);
    permitAt(store, BEFORE);
    expect(store.revokeVoidedByPosture()).toBe(0);
  });
});
