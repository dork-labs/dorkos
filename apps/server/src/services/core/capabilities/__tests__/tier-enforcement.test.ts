/**
 * Tier enforcement matrix (spec `agent-trust` §3.2): what the gate does for each
 * tier, against each state an approval token can be in, under each tier ceiling.
 *
 * The invariant every case defends: a `destructive` capability does not run until a
 * person has said yes to THAT action with THOSE arguments — identified or not — and
 * refusals and waits are audited, not just successes.
 *
 * Three of these cases pin fixes to reproduced defects, so read them before
 * relaxing anything:
 *
 * - the ceiling applies to an unidentified caller too. It used to apply only when
 *   an identity was present, so an agent capped at `act` was refused while the SAME
 *   agent after `unset DORKOS_AGENT_TOKEN` reached the approvable path instead.
 * - the card cannot be forged. `{ name: 'pkg, purge: no', purge: true }` used to
 *   render a fake `purge: no` BEFORE the real `purge: yes`.
 * - secret-shaped values never reach the card, which is broadcast on the global
 *   event stream and readable by agents through `GET /api/approvals/pending`.
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
  DEFAULT_ANONYMOUS_TIER_CEILING,
  describeGatedAttempt,
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  splitApprovalToken,
  type TierEnforcementAttempt,
} from '../tier-enforcement.js';
import {
  APPROVAL_TTL_MS,
  ApprovalService,
  hashApprovalInput,
  REDACTED_SUMMARY_VALUE,
} from '../../approvals/index.js';
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
      action: capabilityAt(tier),
      input: INPUT,
      identity: identityWith(ceiling),
      ...(approvalToken ? { approvalToken } : {}),
      retryChannel: 'mcp-argument',
    });
  }

  /** Run the gate with NO identity — the shape of `env -u DORKOS_AGENT_TOKEN …`. */
  function enforceAnonymous(tier: CapabilityTier, approvalToken?: string) {
    return enforceCapabilityTier({
      action: capabilityAt(tier),
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

    it('is capped by the anonymous ceiling, which defaults to no extra restriction', () => {
      // Unchanged behavior, deliberately asserted: the DEFAULT anonymous ceiling is
      // `destructive`, so an anonymous destructive call is approvable, not refused.
      expect(DEFAULT_ANONYMOUS_TIER_CEILING).toBe('destructive');
      const decision = enforceAnonymous('destructive');
      expect(decision.outcome).toBe('approval_required');
    });

    it('CANNOT escape a ceiling by dropping its identity', () => {
      // The defect this replaces: the ceiling comparison used to run only when an
      // identity was present, so presenting a credential strictly COST privilege.
      // An agent capped at `act` was refused unapprovably; the same agent with the
      // token unset reached the approvable path instead.
      initCapabilityTierGate({
        approvals,
        anonymousTierCeiling: 'act',
        onAttempt: (attempt) => attempts.push(attempt),
      });

      const identified = enforce('destructive', 'act');
      const anonymous = enforceAnonymous('destructive');

      expect(identified.outcome).toBe('denied');
      expect(anonymous.outcome).toBe('denied');
      if (anonymous.outcome !== 'denied') throw new Error('unreachable');
      expect(anonymous.payload.reason).toBe('tier_ceiling');
      expect(anonymous.payload.approvable).toBe(false);
      // Says whose limit it is, without pretending to know who asked.
      expect(anonymous.payload.message).toContain('callers that do not identify themselves');
      // And nothing was queued for a person who could not act on it anyway.
      expect(approvals.listPending()).toHaveLength(0);
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
        action: capabilityAt('destructive'),
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
      expect(decision.approval?.via).toBe('approval');
      if (decision.approval?.via !== 'approval') throw new Error('unreachable');
      expect(decision.approval.approvalId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
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
        action: capabilityAt('destructive'),
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

  describe('what reaches the cockpit', () => {
    it('never publishes a token-shaped input value to the pending list', () => {
      // The realistic trigger is benign: `confirmationToken`'s own description tells
      // a model to re-call with a token, so a model that puts an APPROVAL token in
      // the wrong field would otherwise publish a live, unspent secret to every
      // connected cockpit — and `GET /api/approvals/pending` is readable by agents.
      const live = 'f3a9c1d47b8e5026aa11bb22cc33dd44';
      enforceCapabilityTier({
        action: capabilityAt('destructive'),
        input: { name: live, purge: true, confirmationToken: live },
        retryChannel: 'http-header',
      });

      const [pending] = approvals.listPending();
      expect(pending.summary).not.toContain(live);
      expect(JSON.stringify(pending)).not.toContain(live);
    });

    it('refuses an input it cannot bind, and audits the refusal', () => {
      // `stableStringify` rebuilds objects from `Object.keys()`, which silently drops
      // a Set's contents — two different Sets used to hash IDENTICALLY. A field that
      // looks bound while being ignored is worse than no approval, so refuse.
      const decision = enforceCapabilityTier({
        action: capabilityAt('destructive'),
        input: { name: 'x', when: new Date(0) },
        retryChannel: 'http-header',
      });

      expect(decision.outcome).toBe('denied');
      if (decision.outcome !== 'denied') throw new Error('unreachable');
      expect(decision.payload.reason).toBe('input_not_bindable');
      expect(decision.payload.approvable).toBe(false);
      // Nothing was queued, and the attempt is on the record.
      expect(approvals.listPending()).toHaveLength(0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].decision.outcome).toBe('denied');
    });

    it('audits the attempt even when the approval store itself fails', () => {
      // Fail closed AND leave a record: the throw used to jump straight past
      // `audit()`, so a destructive reach during a database outage vanished.
      vi.spyOn(approvals, 'request').mockImplementation(() => {
        throw new Error('database is locked');
      });

      expect(() => enforce('destructive', 'destructive')).toThrow('database is locked');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].decision.outcome).toBe('denied');
      expect(attempts[0].decision.payload.reason).toBe('enforcement_unavailable');
    });

    it('audits the attempt when spending a token fails', () => {
      vi.spyOn(approvals, 'consume').mockImplementation(() => {
        throw new Error('database is locked');
      });

      expect(() => enforce('destructive', 'destructive', 'some-token')).toThrow(
        'database is locked'
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0].decision.payload.reason).toBe('enforcement_unavailable');
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
      'An unidentified caller wants to run "Demo destructive" with name: "x"'
    );
  });

  it('names the agent, the capability, and the arguments that decide the effect', () => {
    const summary = describeGatedAttempt(
      capabilityAt('destructive'),
      { name: 'sentry-monitor', purge: true },
      identityWith('destructive')
    );
    expect(summary).toBe(
      '"Prober" wants to run "Demo destructive" with name: "sentry-monitor", purge: yes'
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

  describe('a requester cannot forge the sentence a person decides on', () => {
    it('quotes an injected argument instead of letting it become a second field', () => {
      // REPRODUCED defect: this rendered `name: pkg, purge: no, purge: yes`, and the
      // fake pair came FIRST. Quoting makes the injection visibly one value.
      const summary = describeGatedAttempt(capabilityAt('destructive'), {
        name: 'sentry-monitor, purge: no',
        purge: true,
      });

      expect(summary).toBe(
        'An unidentified caller wants to run "Demo destructive" with ' +
          'name: "sentry-monitor, purge: no", purge: yes'
      );
      // The real value is present, once, and last — not shadowed by the fake one.
      expect(summary.endsWith('purge: yes')).toBe(true);
    });

    it('caps each value, so padding one argument cannot truncate away another', () => {
      const summary = describeGatedAttempt(capabilityAt('destructive'), {
        name: 'x'.repeat(2000),
        purge: true,
      });

      expect(summary.length).toBeLessThan(200);
      expect(summary).toContain('purge: yes');
    });

    it('flattens newlines, so a value cannot fake a second line of the card', () => {
      const summary = describeGatedAttempt(capabilityAt('destructive'), {
        name: 'safe\nActually: delete everything',
      });

      expect(summary).not.toContain('\n');
      expect(summary).toContain('safe\\nActually');
    });

    it('caps a self-chosen display name, which an agent can rewrite through act-tier tools', () => {
      const summary = describeGatedAttempt(
        capabilityAt('destructive'),
        { name: 'x' },
        {
          ...identityWith('destructive'),
          displayName: 'A'.repeat(500),
        }
      );

      expect(summary.length).toBeLessThan(200);
      expect(summary).toContain('wants to run "Demo destructive"');
    });
  });

  describe('secrets never reach the card', () => {
    it('drops a field whose NAME says secret', () => {
      const summary = describeGatedAttempt(capabilityAt('destructive'), {
        name: 'sentry-monitor',
        confirmationToken: 'f3a9c1d47b8e5026aa11bb22cc33dd44',
      });

      expect(summary).not.toContain('f3a9c1d47b8e5026aa11bb22cc33dd44');
      expect(summary).not.toContain('confirmationToken');
    });

    it('redacts a token-shaped VALUE hiding under an innocent field name', () => {
      const summary = describeGatedAttempt(capabilityAt('destructive'), {
        name: 'f3a9c1d47b8e5026aa11bb22cc33dd44',
      });

      expect(summary).not.toContain('f3a9c1d47b8e5026aa11bb22cc33dd44');
      expect(summary).toContain(REDACTED_SUMMARY_VALUE);
    });

    it('shows only the fields a capability declares, in that order', () => {
      const capability = defineCapability({
        id: 'demo.declared',
        title: 'Declared demo',
        description: 'A demonstration capability that declares its approval display fields.',
        tier: 'destructive',
        input: z.object({
          name: z.string(),
          purge: z.boolean(),
          confirmationToken: z.string().optional(),
          note: z.string().optional(),
        }),
        output: z.unknown(),
        approvalDisplayFields: ['purge', 'name'],
        surfaces: { mcp: { toolName: 'demo_declared', servers: ['external'] } },
        invoke: async () => ({ ok: true }),
      });

      const summary = describeGatedAttempt(capability, {
        name: 'sentry-monitor',
        purge: true,
        confirmationToken: 'f3a9c1d47b8e5026aa11bb22cc33dd44',
        note: 'do not show me',
      });

      expect(summary).toBe(
        'An unidentified caller wants to run "Declared demo" with purge: yes, name: "sentry-monitor"'
      );
    });

    it('strips separators from a caller-controlled field NAME too', () => {
      // Keys are schema-controlled today (`z.object` strips what it does not
      // declare), but a `.passthrough()` or `z.record()` destructive schema would
      // hand a caller the key as well — and a key can forge structure exactly the
      // way a value could.
      const summary = describeGatedAttempt(capabilityAt('destructive'), {
        'name, purge: no': 'x',
      });

      expect(summary).toBe(
        'An unidentified caller wants to run "Demo destructive" with namepurgeno: "x"'
      );
    });

    it('reads a nested declared field instead of rendering it as "details"', () => {
      const capability = defineCapability({
        id: 'demo.nested',
        title: 'Nested demo',
        description: 'A demonstration capability whose consequential field is nested.',
        tier: 'destructive',
        input: z.object({ options: z.object({ purge: z.boolean() }) }),
        output: z.unknown(),
        approvalDisplayFields: ['options.purge'],
        surfaces: { mcp: { toolName: 'demo_nested', servers: ['external'] } },
        invoke: async () => ({ ok: true }),
      });

      expect(describeGatedAttempt(capability, { options: { purge: true } })).toBe(
        'An unidentified caller wants to run "Nested demo" with options.purge: yes'
      );
    });
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
