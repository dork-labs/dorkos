/**
 * Tier enforcement matrix (spec `agent-trust` §3.2): what the gate does for each
 * tier, against each state an approval token can be in, under each tier ceiling.
 *
 * The invariant every case defends: a `destructive` capability reached by an
 * identified agent does not run until a person has said yes to THAT action with
 * THOSE arguments — and refusals and waits are audited, not just successes.
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
  APPROVAL_TOKEN_ARGUMENT,
  describeGatedAttempt,
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  splitApprovalToken,
  type TierEnforcementAttempt,
} from '../tier-enforcement.js';
import { APPROVAL_TTL_MS, ApprovalService, hashApprovalInput } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

/** A capability at the given tier, with a real input schema to hash over. */
function capabilityAt(tier: CapabilityTier) {
  return defineCapability({
    id: `demo.${tier}`,
    title: `Demo ${tier}`,
    description: 'A demonstration capability used by the tier enforcement tests.',
    tier,
    input: z.object({ name: z.string(), purge: z.boolean().optional() }),
    output: z.unknown(),
    surfaces: { mcp: { toolName: `demo_${tier}`, servers: ['external'] } },
    invoke: async () => ({ ok: true }),
  });
}

/** An identity with the given ceiling. */
function identityWith(tierCeiling: CapabilityTier): AgentIdentity {
  return {
    agentPath: '/projects/prober',
    displayName: 'Prober',
    tierCeiling,
    createdAt: new Date().toISOString(),
  };
}

/** The input every case attempts. */
const INPUT = { name: 'sentry-monitor', purge: true };

describe('enforceCapabilityTier', () => {
  let db: Db;
  let approvals: ApprovalService;
  let attempts: TierEnforcementAttempt[];

  beforeEach(() => {
    db = createTestDb();
    approvals = new ApprovalService(db);
    attempts = [];
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({
      approvals,
      onAttempt: (attempt) => attempts.push(attempt),
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Run the gate over a tier, ceiling, and optional token. */
  function enforce(tier: CapabilityTier, ceiling: CapabilityTier, approvalToken?: string) {
    return enforceCapabilityTier({
      capability: capabilityAt(tier),
      input: INPUT,
      identity: identityWith(ceiling),
      ...(approvalToken ? { approvalToken } : {}),
      retryChannel: 'mcp-argument',
    });
  }

  /** Run the gate with NO identity — the shape of `env -u DORKOS_AGENT_TOKEN …`. */
  function enforceAnonymous(tier: CapabilityTier, approvalToken?: string) {
    return enforceCapabilityTier({
      capability: capabilityAt(tier),
      input: INPUT,
      ...(approvalToken ? { approvalToken } : {}),
      retryChannel: 'http-header',
    });
  }

  describe('an unidentified caller', () => {
    it('reads and makes ordinary changes freely, so no honest flow breaks', () => {
      // These are the calls spec §3.1 protected: external MCP clients and a human
      // running `dorkos call`. They must be untouched.
      expect(enforceAnonymous('observe').outcome).toBe('allowed');
      expect(enforceAnonymous('act').outcome).toBe('allowed');
      expect(attempts).toHaveLength(0);
    });

    it('CANNOT run a destructive capability by simply not identifying itself', () => {
      // The bypass this inversion closes: dropping DORKOS_AGENT_TOKEN needs less
      // capability than the honest path, so it must not buy more permission.
      const decision = enforceAnonymous('destructive');

      expect(decision.outcome).toBe('approval_required');
      if (decision.outcome !== 'approval_required') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('no_approval');
      expect(approvals.listPending()).toHaveLength(1);
    });

    it('is named as unidentified on the card, not left blank or dressed up as an agent', () => {
      enforceAnonymous('destructive');

      const [pending] = approvals.listPending();
      expect(pending.requestedBy).toBeUndefined();
      expect(pending.summary).toContain('An unidentified caller');
    });

    it('is audited, so an anonymous reach for something irreversible leaves a trace', () => {
      enforceAnonymous('destructive');

      expect(attempts).toHaveLength(1);
      expect(attempts[0].identity).toBeUndefined();
      expect(attempts[0].decision.outcome).toBe('approval_required');
    });

    it('goes through once a person grants the approval it was told to get', () => {
      const asked = enforceAnonymous('destructive');
      if (asked.outcome !== 'approval_required') throw new Error('unreachable');
      approvals.grant(asked.payload.approvalId);

      expect(enforceAnonymous('destructive', asked.payload.approvalToken).outcome).toBe('allowed');
    });

    it('has no ceiling to trip, so it is never refused unapprovably', () => {
      const decision = enforceAnonymous('destructive');
      expect(decision.outcome).not.toBe('denied');
    });
  });

  describe('observe', () => {
    it('passes, even under the tightest ceiling', () => {
      expect(enforce('observe', 'observe').outcome).toBe('allowed');
    });
  });

  describe('act', () => {
    it('passes under an act or destructive ceiling', () => {
      expect(enforce('act', 'act').outcome).toBe('allowed');
      expect(enforce('act', 'destructive').outcome).toBe('allowed');
    });

    it('emits no gate audit event of its own — the invocation observer covers it', () => {
      enforce('act', 'destructive');
      expect(attempts).toHaveLength(0);
    });

    it('is refused, unapprovably, under an observe ceiling', () => {
      const decision = enforce('act', 'observe');
      expect(decision.outcome).toBe('denied');
      if (decision.outcome !== 'denied') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('tier_ceiling');
      expect(decision.payload.approvable).toBe(false);
    });
  });

  describe('destructive under a capping ceiling', () => {
    it('is refused with a distinct, never-approvable payload', () => {
      const decision = enforce('destructive', 'act');
      expect(decision.outcome).toBe('denied');
      if (decision.outcome !== 'denied') throw new Error('unreachable');
      expect(decision.payload.status).toBe('denied');
      expect(decision.payload.reason).toBe('tier_ceiling');
      expect(decision.payload.approvable).toBe(false);
      expect(decision.payload.message).toContain('Nobody can approve this');
      // Nothing was recorded: an unapprovable attempt must not put a card in front
      // of a person who could not act on it anyway.
      expect(approvals.listPending()).toHaveLength(0);
    });

    it('audits the refusal', () => {
      enforce('destructive', 'act');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].decision.outcome).toBe('denied');
      expect(attempts[0].identity.agentPath).toBe('/projects/prober');
    });
  });

  describe('destructive with no token', () => {
    it('does not allow the call, and records an approval for exactly this action', () => {
      const decision = enforce('destructive', 'destructive');
      expect(decision.outcome).toBe('approval_required');
      if (decision.outcome !== 'approval_required') throw new Error('unreachable');

      const { payload } = decision;
      expect(payload.status).toBe('approval_required');
      expect(payload.reason).toBe('no_approval');
      expect(payload.capabilityId).toBe('demo.destructive');
      expect(payload.tier).toBe('destructive');
      expect(payload.approvalToken).toMatch(/^[0-9a-f]{32}$/);
      expect(payload.retry.field).toBe(APPROVAL_TOKEN_ARGUMENT);
      expect(payload.retry.instructions).toContain(APPROVAL_TOKEN_ARGUMENT);

      const [pending] = approvals.listPending();
      expect(pending.approvalId).toBe(payload.approvalId);
      // The card names the agent — the whole point of threading identity through.
      expect(pending.requestedBy).toBe('Prober');
      expect(pending.summary).toContain('Prober');
      expect(pending.summary).toContain('sentry-monitor');
    });

    it('states the retry channel of the surface the call arrived on', () => {
      const decision = enforceCapabilityTier({
        capability: capabilityAt('destructive'),
        input: INPUT,
        identity: identityWith('destructive'),
        retryChannel: 'http-header',
      });
      if (decision.outcome !== 'approval_required') throw new Error('unreachable');
      expect(decision.payload.retry.channel).toBe('http-header');
      expect(decision.payload.retry.field).toBe('x-dorkos-approval');
    });

    it('audits the wait', () => {
      enforce('destructive', 'destructive');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].decision.outcome).toBe('approval_required');
    });
  });

  describe('destructive with a token', () => {
    /** Ask, then grant, and return the token to retry with. */
    function grantedToken(): string {
      const decision = enforce('destructive', 'destructive');
      if (decision.outcome !== 'approval_required') throw new Error('unreachable');
      expect(approvals.grant(decision.payload.approvalId)).toBeUndefined();
      return decision.payload.approvalToken;
    }

    it('allows the call once a person granted it, and names the approval spent', () => {
      const token = grantedToken();
      const decision = enforce('destructive', 'destructive', token);
      expect(decision.outcome).toBe('allowed');
      if (decision.outcome !== 'allowed') throw new Error('unreachable');
      expect(decision.approval?.approvalId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('refuses a REPLAY of the same granted token', () => {
      const token = grantedToken();
      expect(enforce('destructive', 'destructive', token).outcome).toBe('allowed');

      const replay = enforce('destructive', 'destructive', token);
      expect(replay.outcome).toBe('approval_required');
      if (replay.outcome !== 'approval_required') throw new Error('unreachable');
      expect(replay.payload.reason).toBe('already_used');
    });

    it('refuses a granted token presented with DIFFERENT arguments', () => {
      const token = grantedToken();
      const decision = enforceCapabilityTier({
        capability: capabilityAt('destructive'),
        // The same package, but no longer purging — a materially different effect.
        input: { name: 'sentry-monitor', purge: false },
        identity: identityWith('destructive'),
        approvalToken: token,
        retryChannel: 'mcp-argument',
      });
      expect(decision.outcome).toBe('approval_required');
      if (decision.outcome !== 'approval_required') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('wrong_action');
      // The original approval survives for what it was actually granted for.
      expect(
        approvals.consume(token, {
          capabilityId: 'demo.destructive',
          inputHash: hashApprovalInput(INPUT),
        }).outcome
      ).toBe('granted');
    });

    it('echoes the same approval back while it is still undecided', () => {
      const first = enforce('destructive', 'destructive');
      if (first.outcome !== 'approval_required') throw new Error('unreachable');

      const second = enforce('destructive', 'destructive', first.payload.approvalToken);
      expect(second.outcome).toBe('approval_required');
      if (second.outcome !== 'approval_required') throw new Error('unreachable');
      expect(second.payload.reason).toBe('awaiting_decision');
      // One action, one card: a retry must not stack a second request.
      expect(second.payload.approvalId).toBe(first.payload.approvalId);
      expect(approvals.listPending()).toHaveLength(1);
    });

    it('reports a refusal when a person said no', () => {
      const first = enforce('destructive', 'destructive');
      if (first.outcome !== 'approval_required') throw new Error('unreachable');
      approvals.deny(first.payload.approvalId, 'Not that package');

      const decision = enforce('destructive', 'destructive', first.payload.approvalToken);
      expect(decision.outcome).toBe('denied');
      if (decision.outcome !== 'denied') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('operator_denied');
      expect(decision.payload.message).toContain('Not that package');
    });

    it('asks again when the decision window closed', () => {
      vi.useFakeTimers();
      const first = enforce('destructive', 'destructive');
      if (first.outcome !== 'approval_required') throw new Error('unreachable');
      approvals.grant(first.payload.approvalId);

      // Derived from the decision window, not a hardcoded duration — tuning
      // APPROVAL_TTL_MS must not turn this into a silently-passing test.
      vi.advanceTimersByTime(APPROVAL_TTL_MS + 60_000);
      const decision = enforce('destructive', 'destructive', first.payload.approvalToken);
      expect(decision.outcome).toBe('approval_required');
      if (decision.outcome !== 'approval_required') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('expired');
    });

    it('asks again for a token nothing recognizes', () => {
      const decision = enforce('destructive', 'destructive', 'not-a-real-token');
      expect(decision.outcome).toBe('approval_required');
      if (decision.outcome !== 'approval_required') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('unknown_token');
    });
  });

  describe('fail closed', () => {
    it('refuses a destructive call when the gate was never wired to an approval service', () => {
      resetCapabilityTierGate();
      const decision = enforce('destructive', 'destructive');
      expect(decision.outcome).toBe('denied');
      if (decision.outcome !== 'denied') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('enforcement_unavailable');
      expect(decision.payload.approvable).toBe(false);
    });

    it('still allows observe and act, which need nobody to ask', () => {
      resetCapabilityTierGate();
      expect(enforce('observe', 'destructive').outcome).toBe('allowed');
      expect(enforce('act', 'destructive').outcome).toBe('allowed');
    });
  });

  describe('an audit hook that throws', () => {
    it('cannot change what the caller is told', () => {
      initCapabilityTierGate({
        approvals,
        onAttempt: () => {
          throw new Error('the feed is on fire');
        },
      });
      expect(() => enforce('destructive', 'destructive')).not.toThrow();
    });
  });
});

describe('describeGatedAttempt', () => {
  it('names an unidentified caller plainly', () => {
    expect(describeGatedAttempt(capabilityAt('destructive'), { name: 'x' })).toBe(
      'An unidentified caller wants to run "Demo destructive" with name: x'
    );
  });

  it('names the agent, the capability, and the arguments that decide the effect', () => {
    const summary = describeGatedAttempt(
      capabilityAt('destructive'),
      { name: 'sentry-monitor', purge: true },
      identityWith('destructive')
    );
    expect(summary).toBe(
      'Prober wants to run "Demo destructive" with name: sentry-monitor, purge: yes'
    );
  });

  it('falls back to the agent path when it has no display name', () => {
    const summary = describeGatedAttempt(
      capabilityAt('destructive'),
      {},
      { ...identityWith('destructive'), displayName: '' }
    );
    expect(summary).toContain('/projects/prober');
  });
});

describe('splitApprovalToken', () => {
  it('lifts the token out and leaves the capability input untouched', () => {
    const { approvalToken, input } = splitApprovalToken({
      name: 'x',
      [APPROVAL_TOKEN_ARGUMENT]: 'abc123',
    });
    expect(approvalToken).toBe('abc123');
    expect(input).toEqual({ name: 'x' });
  });

  it('hashes identically with and without a token attached — the binding holds', () => {
    const withToken = splitApprovalToken({ name: 'x', [APPROVAL_TOKEN_ARGUMENT]: 'abc123' });
    const without = splitApprovalToken({ name: 'x' });
    expect(hashApprovalInput(withToken.input)).toBe(hashApprovalInput(without.input));
  });

  it('ignores an empty or non-string token', () => {
    expect(
      splitApprovalToken({ name: 'x', [APPROVAL_TOKEN_ARGUMENT]: '' }).approvalToken
    ).toBeUndefined();
    expect(
      splitApprovalToken({ name: 'x', [APPROVAL_TOKEN_ARGUMENT]: 7 }).approvalToken
    ).toBeUndefined();
  });

  it('passes non-object arguments through', () => {
    expect(splitApprovalToken(undefined)).toEqual({ input: undefined });
  });
});
