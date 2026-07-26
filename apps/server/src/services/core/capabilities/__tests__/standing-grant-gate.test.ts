/**
 * The standing-permission half of the tier gate (spec `agent-approval-settings`
 * §3.3), as a matrix rather than a handful of happy paths.
 *
 * The cross product that matters is {no identity, identity with a permission,
 * identity without one} times {switch on, switch off} times each tier, plus the two
 * orderings the design rests on:
 *
 * - a ceiling refusal beats a permission, because the lookup sits AFTER the ceiling
 *   check. A ceiling refusal is `approvable: false` — no human decision can unlock
 *   it — so a permission must not be able to either.
 * - a permission reaches an `act` capability, because the lookup sits BEFORE the
 *   `act` early-return. That is what lets one lookup satisfy the marketplace's own
 *   confirmation step as well as this gate.
 *
 * The store here is the real {@link ApprovalGrantService} over a real database, so
 * expiry and revocation are exercised through the same code the server runs rather
 * than through a stub that could disagree with it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { CapabilityTier } from '@dorkos/shared/capabilities';

import { defineCapability } from '../capability-definition.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type TierEnforcementAttempt,
  type TierEnforcementDecision,
} from '../tier-enforcement.js';
import { ApprovalGrantService, ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

/** The agent a permission is keyed on. */
const AGENT_PATH = '/projects/prober';

/** A capability at the given tier. */
function capabilityAt(tier: CapabilityTier) {
  return defineCapability({
    id: `demo.${tier}`,
    title: `Demo ${tier}`,
    description: 'A demonstration capability used by the standing-permission tests.',
    tier,
    input: z.object({ name: z.string() }),
    output: z.unknown(),
    surfaces: { mcp: { toolName: `demo_${tier}`, servers: ['external'] } },
    invoke: async () => ({ ok: true }),
  });
}

/** An identity with the given ceiling, keyed on the path permissions use. */
function identityWith(tierCeiling: CapabilityTier = 'destructive'): AgentIdentity {
  return {
    agentPath: AGENT_PATH,
    displayName: 'Prober',
    tierCeiling,
    createdAt: new Date().toISOString(),
  };
}

const INPUT = { name: 'sentry-monitor' };

describe('the tier gate and a standing permission', () => {
  let db: Db;
  let grants: ApprovalGrantService;
  let attempts: TierEnforcementAttempt[];
  let standingGrantsOn: boolean;

  beforeEach(() => {
    db = createTestDb();
    grants = new ApprovalGrantService(db);
    attempts = [];
    standingGrantsOn = true;
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({
      approvals: new ApprovalService(db),
      onAttempt: (attempt) => attempts.push(attempt),
      standingGrants: {
        enabled: () => standingGrantsOn,
        findLive: (agentPath, capabilityId) => grants.findLive(agentPath, capabilityId),
      },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Open a permission for one capability, straight through the store. */
  function permit(capabilityId: string, agentPath: string = AGENT_PATH, windowMinutes = 480) {
    return grants.create({
      agentPath,
      capabilityId,
      grantedBy: 'user_owner',
      posture: 'signed-in-operator',
      windowMinutes,
    });
  }

  /** Run the gate at a tier, with or without an identity. */
  function enforce(
    tier: CapabilityTier,
    options: { identity?: AgentIdentity } = {}
  ): TierEnforcementDecision {
    return enforceCapabilityTier({
      action: capabilityAt(tier),
      input: INPUT,
      ...(options.identity ? { identity: options.identity } : {}),
      retryChannel: 'mcp-argument',
    });
  }

  describe('the cross product of identity, permission, and the master switch', () => {
    it('lets a destructive call through for an identified agent with a permission', () => {
      const row = permit('demo.destructive');

      const decision = enforce('destructive', { identity: identityWith() });

      expect(decision.outcome).toBe('allowed');
      if (decision.outcome !== 'allowed') throw new Error('unreachable');
      expect(decision.approval).toEqual({ via: 'standing-grant', grantId: row.id });
    });

    it('still asks an identified agent that has no permission', () => {
      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });

    it('still asks when the master switch is off, permission or not', () => {
      permit('demo.destructive');
      standingGrantsOn = false;

      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });

    it('never matches a permission for a caller that presents no identity', () => {
      // Permissions key on agent path, so shedding a credential can get a caller
      // the gate and never past it. The mirror of the ceiling reasoning: presenting
      // a credential must not cost privilege, and dropping one must not buy trust.
      permit('demo.destructive');

      expect(enforce('destructive').outcome).toBe('approval_required');
    });

    it('does not even ASK the store about a caller with no identity', () => {
      // The outcome assertion above does not pin the guard, and a mutation proved
      // it: deleting the `!identity` check and keying on `identity?.agentPath ?? ''`
      // leaves the whole suite green, because an empty path matches no row. So the
      // guard has to be asserted where it actually lives — at the lookup. §3.8 is
      // the section arguing that a guard which holds by accident is worth pinning.
      permit('demo.destructive');
      const findLive = vi.fn(() => undefined);
      resetCapabilityTierGate();
      initCapabilityTierGate({
        approvals: new ApprovalService(db),
        standingGrants: { enabled: () => true, findLive },
      });

      expect(enforce('destructive').outcome).toBe('approval_required');
      expect(findLive).not.toHaveBeenCalled();

      // …and it IS called for an identified one, so this is not passing because the
      // lookup was never wired.
      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
      expect(findLive).toHaveBeenCalledWith(AGENT_PATH, 'demo.destructive');
    });

    it('never matches a permission granted to a DIFFERENT agent', () => {
      permit('demo.destructive', '/projects/somebody-else');

      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });

    it('never matches a permission granted for a DIFFERENT capability', () => {
      // There is no wildcard in the schema, and this is what that means at the gate.
      permit('demo.act');

      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });

    it('leaves observe alone, which never reached a permission anyway', () => {
      permit('demo.observe');

      const decision = enforce('observe', { identity: identityWith() });

      expect(decision).toEqual({ outcome: 'allowed' });
    });
  });

  describe('expiry and revocation are applied on read', () => {
    it('ignores a permission whose window has closed, with no sweep in between', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
      permit('demo.destructive', AGENT_PATH, 60);
      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe('allowed');

      vi.setSystemTime(new Date('2026-07-26T13:00:01.000Z'));

      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });

    it('ignores a revoked permission on the very next call', () => {
      const row = permit('demo.destructive');
      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe('allowed');

      expect(grants.revoke(row.id)).toBe(true);

      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });

    it('does not slide the window when a permission is used', () => {
      // A sliding window would hand the agent control of its own expiry: the agent
      // that acts most often would be the one that never has to ask again.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
      const row = permit('demo.destructive', AGENT_PATH, 60);

      vi.setSystemTime(new Date('2026-07-26T12:59:00.000Z'));
      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe('allowed');

      expect(grants.findLive(AGENT_PATH, 'demo.destructive')?.expiresAt).toBe(row.expiresAt);
      vi.setSystemTime(new Date('2026-07-26T13:00:01.000Z'));
      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });
  });

  describe('a permission cannot lift a ceiling', () => {
    it('refuses the call anyway, and says nobody can approve it', () => {
      permit('demo.destructive');

      const decision = enforce('destructive', { identity: identityWith('act') });

      expect(decision.outcome).toBe('denied');
      if (decision.outcome !== 'denied') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('tier_ceiling');
      expect(decision.payload.approvable).toBe(false);
    });

    it('audits it as a refusal, never as an auto-approval', () => {
      permit('demo.destructive');

      enforce('destructive', { identity: identityWith('act') });

      expect(attempts).toHaveLength(1);
      expect(attempts[0].decision.outcome).toBe('denied');
    });
  });

  describe('an act capability, which this gate never stopped', () => {
    it('carries the permission onto the decision so a second gate honors it', () => {
      // The §3.4 claim, and the one most likely to be quietly wrong. Nothing here
      // changes WHETHER the call runs; the permission rides along so the
      // marketplace's own confirmation step does not ask a question the operator
      // already answered.
      const row = permit('demo.act');

      const decision = enforce('act', { identity: identityWith() });

      expect(decision).toEqual({
        outcome: 'allowed',
        approval: { via: 'standing-grant', grantId: row.id },
      });
    });

    it('runs with a bare allowed when there is no permission, exactly as before', () => {
      expect(enforce('act', { identity: identityWith() })).toEqual({ outcome: 'allowed' });
    });

    it('is not audited as auto-approved, because no permission decided it', () => {
      // At this tier the gate allowed the call regardless, so a line crediting a
      // permission would credit it for a decision it did not make. The attribution
      // observer records the invocation and names the permission in its metadata.
      permit('demo.act');

      enforce('act', { identity: identityWith() });

      expect(attempts).toEqual([]);
    });
  });

  describe('auditing an auto-approved destructive call', () => {
    it('reports it to the audit hook as an allowed attempt carrying the permission', () => {
      const row = permit('demo.destructive');

      enforce('destructive', { identity: identityWith() });

      expect(attempts).toHaveLength(1);
      expect(attempts[0].decision).toEqual({
        outcome: 'allowed',
        approval: { via: 'standing-grant', grantId: row.id },
      });
      expect(attempts[0].identity?.agentPath).toBe(AGENT_PATH);
    });

    it('writes no approval row, so a quiet window does not flood the cockpit', () => {
      // The decision the codebase already made for auto-approval, restated here as
      // a test: the durable record is the permission plus one Activity line per use.
      const approvals = new ApprovalService(db);
      permit('demo.destructive');

      enforce('destructive', { identity: identityWith() });

      expect(approvals.listPending()).toEqual([]);
    });
  });

  describe('when nothing is wired, the gate behaves as if the feature did not exist', () => {
    it('asks for approval even with a live permission in the store', () => {
      // Fails closed in the only direction that is safe here. A boot that forgot to
      // wire the lookup must ask a person, not assume nobody granted anything.
      const row = permit('demo.destructive');
      resetCapabilityTierGate();
      initCapabilityTierGate({ approvals: new ApprovalService(db) });

      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
      expect(grants.findLive(AGENT_PATH, 'demo.destructive')?.id).toBe(row.id);
    });

    it('asks for approval when the lookup itself throws', () => {
      resetCapabilityTierGate();
      initCapabilityTierGate({
        approvals: new ApprovalService(db),
        standingGrants: {
          enabled: () => true,
          findLive: () => {
            throw new Error('the database went away');
          },
        },
      });

      expect(enforce('destructive', { identity: identityWith() }).outcome).toBe(
        'approval_required'
      );
    });
  });
});
