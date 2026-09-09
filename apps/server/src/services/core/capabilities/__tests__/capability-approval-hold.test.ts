/**
 * In-session hold-and-await for destructive capability approvals (DOR-939).
 *
 * These cross the seam the feature exists to close: a destructive call that
 * `invokeCapabilityAsMcpResult` gates does NOT return the poll payload and end —
 * it HOLDS, pushing the inline card onto the live session, and resumes on the
 * operator's real decision. What each test pins:
 *
 * - a GRANT resumes the held call and returns the capability's REAL result (the
 *   exact deletion, not "some result") — the handler runs, once, with the person's
 *   approval on its context;
 * - a DENY comes back `denied` and the handler never runs;
 * - a no-decision TIMEOUT degrades to the EXACT `approval_required` payload today's
 *   poll flow returns — never an error, never worse than before;
 * - the inline card is emitted onto the session and retired on resolution, so the
 *   projector can pause the stall watchdog for the hold and drop it after;
 * - the card carries the real cap, so the projector's pause and the client's
 *   countdown describe the same wait.
 *
 * The gate, the approval primitive, and the global fan-out are all REAL here (only
 * the clock is faked, and only for the timeout test), because the resume rides the
 * `approval_resolved` broadcast `grant`/`deny` emit — a mocked fan-out would prove
 * nothing about the wire the hold actually waits on.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type {
  StreamEvent,
  CapabilityApprovalRequiredEvent,
  CapabilityApprovalResolvedEvent,
} from '@dorkos/shared/types';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';

import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../index.js';
import { invokeCapabilityAsMcpResult } from '../mcp-projection.js';
import {
  awaitCapabilityApproval,
  CAPABILITY_APPROVAL_HOLD_CAP_MS,
  type CapabilityApprovalHold,
} from '../capability-approval-hold.js';
import { ApprovalService, hashApprovalInput } from '../../approvals/index.js';
import { APPROVAL_TOKEN_ARGUMENT } from '../tier-enforcement.js';
import type { AgentIdentity } from '../../agent-identity/index.js';

const AGENT: AgentIdentity = {
  agentPath: '/projects/prober',
  displayName: 'Prober',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

/** A destructive capability whose handler returns a DISTINCTIVE, input-derived result. */
function domain(ran: { input: unknown; context: CapabilityHandlerContext }[]): CapabilityDomain {
  return {
    name: 'gated',
    capabilities: [
      defineCapability({
        id: 'gated.destroy',
        title: 'Destroy the thing',
        description: 'Deletes the named thing. Cannot be undone.',
        tier: 'destructive',
        input: z.object({ name: z.string() }),
        output: z.object({ deleted: z.string() }),
        surfaces: { mcp: { toolName: 'gated_destroy', servers: ['in-session'] } },
        invoke: async (_deps, input, context) => {
          ran.push({ input, context });
          return { deleted: (input as { name: string }).name };
        },
      }),
    ],
  };
}

describe('capability approval hold (DOR-939)', () => {
  let ran: { input: unknown; context: CapabilityHandlerContext }[];
  let approvals: ApprovalService;
  let registry: ReturnType<typeof composeRegistry>;
  let session: { eventQueue: StreamEvent[]; eventQueueNotify: () => void };

  beforeEach(() => {
    ran = [];
    registry = composeRegistry([domain(ran)], { logger: noopLogger });
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
    session = { eventQueue: [], eventQueueNotify: vi.fn() };
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  /** The plain payload inside an MCP text result. */
  function payloadOf(result: {
    content: { type: string; text?: string }[];
  }): Record<string, unknown> {
    return JSON.parse(result.content[0].text ?? 'null') as Record<string, unknown>;
  }

  /**
   * The inline card's data, once it has been emitted. `StreamEvent` is a
   * `{ type, data }` pair rather than a discriminated union, so the payload is
   * cast to the known event shape.
   */
  function cardData(): CapabilityApprovalRequiredEvent | undefined {
    const event = session.eventQueue.find((e) => e.type === 'capability_approval_required');
    return event?.data as CapabilityApprovalRequiredEvent | undefined;
  }

  /** The resolution event's data, once the hold has ended. */
  function resolvedData(): CapabilityApprovalResolvedEvent | undefined {
    const event = session.eventQueue.find((e) => e.type === 'capability_approval_resolved');
    return event?.data as CapabilityApprovalResolvedEvent | undefined;
  }

  function hold(overrides: Partial<CapabilityApprovalHold> = {}): CapabilityApprovalHold {
    return { approvals, session, ...overrides };
  }

  it('tells the session how long the card is answerable for — the real cap', async () => {
    // The cap is not decoration: the emitted `capMs` is what the projector bounds
    // its stall-pause on and what the client counts down, so the card and the
    // wait it describes cannot drift apart. (The old test here asserted the MCP
    // SDK's 60s default instead — a number nothing in this path reads, and the
    // wrong premise for the cap. DOR-987.)
    const resultP = invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production' },
      { identity: AGENT },
      hold()
    );
    await vi.waitFor(() => expect(cardData()).toBeDefined());
    expect(cardData()!.capMs).toBe(CAPABILITY_APPROVAL_HOLD_CAP_MS);

    approvals.grant(cardData()!.approval.approvalId);
    await resultP;
  });

  it('holds, emits the inline card, and resumes on a GRANT with the REAL result', async () => {
    const resultP = invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production' },
      { identity: AGENT },
      hold()
    );

    // The call held instead of returning: the inline card is on the session, and
    // the destructive handler has NOT run yet.
    await vi.waitFor(() => expect(cardData()).toBeDefined());
    const card = cardData()!;
    expect(card.approval.capabilityId).toBe('gated.destroy');
    expect(ran).toEqual([]);

    // The operator answers the SAME approval the card carries.
    approvals.grant(card.approval.approvalId);

    const result = await resultP;
    // The real, input-derived result — not the approval_required payload, and not
    // "some result": the exact thing the destructive handler produced.
    expect(payloadOf(result)).toEqual({ deleted: 'production' });
    expect(ran).toHaveLength(1);
    expect(ran[0].input).toEqual({ name: 'production' });
    expect(ran[0].context.approval).toEqual({
      via: 'approval',
      approvalId: card.approval.approvalId,
    });
    // The card was retired so the projector drops the pending hold.
    expect(resolvedData()).toMatchObject({
      approvalId: card.approval.approvalId,
      outcome: 'granted',
    });
  });

  it('resumes on a DENY as denied, and never runs the handler', async () => {
    const resultP = invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production' },
      { identity: AGENT },
      hold()
    );
    await vi.waitFor(() => expect(cardData()).toBeDefined());
    const approvalId = cardData()!.approval.approvalId;

    approvals.deny(approvalId, 'not today');

    const result = await resultP;
    const payload = payloadOf(result);
    expect(payload.status).toBe('denied');
    expect(payload.approvable).toBe(true);
    expect(ran).toEqual([]);
    expect(resolvedData()).toMatchObject({ approvalId, outcome: 'denied' });
  });

  it('degrades to the EXACT approval_required payload on a hold TIMEOUT — never an error', async () => {
    vi.useFakeTimers();
    try {
      const resultP = invokeCapabilityAsMcpResult(
        registry,
        'gated.destroy',
        { name: 'production' },
        { identity: AGENT },
        hold({ capMs: 1_000 })
      );

      // Let the hold reach its await, then run the cap out with no decision.
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultP;

      const card = cardData();
      expect(card).toBeDefined();
      const payload = payloadOf(result);
      // Byte-for-byte today's poll payload: the same status, the same approval id
      // the card carries — the operator can still grant it on the dashboard and the
      // agent can still retry with its token. Not `isError`.
      expect(result.isError).toBeUndefined();
      expect(payload.status).toBe('approval_required');
      expect(payload.approvalId).toBe(card!.approval.approvalId);
      expect(ran).toEqual([]);
      expect(resolvedData()).toMatchObject({ outcome: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  // DOR-987: the hold fired only on `reason: 'no_approval'`, but tier enforcement
  // mints a brand-new approval for every token failure too. Those calls produced a
  // dashboard card, no inline card and no hold — the exact experience the feature
  // exists to remove, reached by the most ordinary route there is (an agent
  // retrying with a token that has since expired or been spent).
  it('holds on a token failure too — an EXPIRED token mints a fresh ask', async () => {
    // A real expired token: granted, then left past its window. `shouldAdvanceTime`
    // keeps the fake clock moving with the real one, so the aging is deterministic
    // AND the hold's own await still settles.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const shortLived = new ApprovalService(createTestDb(), { ttlMs: 60_000 });
      initCapabilityTierGate({ approvals: shortLived });
      const stale = shortLived.request({
        capabilityId: 'gated.destroy',
        inputHash: hashApprovalInput({ name: 'production' }),
        summary: 'Prober wants to destroy production',
      });
      shortLived.grant(stale.approvalId);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(shortLived.getPending(stale.approvalId)?.approvalId).toBe(stale.approvalId);

      const resultP = invokeCapabilityAsMcpResult(
        registry,
        'gated.destroy',
        { name: 'production', [APPROVAL_TOKEN_ARGUMENT]: stale.token },
        { identity: AGENT },
        { approvals: shortLived, session }
      );

      // The retry did NOT end at a dashboard-only card: it held, with an inline
      // card carrying the NEW approval the gate just minted.
      await vi.waitFor(() => expect(cardData()).toBeDefined());
      const card = cardData()!;
      expect(card.approval.approvalId).not.toBe(stale.approvalId);

      shortLived.grant(card.approval.approvalId);
      const result = await resultP;
      expect(payloadOf(result)).toEqual({ deleted: 'production' });
      expect(resolvedData()).toMatchObject({ outcome: 'granted' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT hold on awaiting_decision — the one reason that echoes an existing ask', async () => {
    // The token is real and still undecided, so the gate echoes the SAME approval
    // rather than minting one. Holding here would push a second inline card for a
    // card the person is already looking at, and park the turn on it.
    const undecided = approvals.request({
      capabilityId: 'gated.destroy',
      inputHash: hashApprovalInput({ name: 'production' }),
      summary: 'Prober wants to destroy production',
    });

    const result = await invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production', [APPROVAL_TOKEN_ARGUMENT]: undecided.token },
      { identity: AGENT },
      hold()
    );

    const payload = payloadOf(result);
    expect(payload.status).toBe('approval_required');
    expect(payload.reason).toBe('awaiting_decision');
    expect(payload.approvalId).toBe(undecided.approvalId);
    // Nothing pushed: no second card, no hold, no resolution.
    expect(session.eventQueue).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('emits NO resolution when the card itself could not be emitted', async () => {
    // The pending row vanished between the ask and the hold, so there is no card
    // to render — and therefore nothing to retire. Pushing a resolution anyway
    // put an event on the transcript for a card nobody ever saw (DOR-987).
    const cardless = {
      awaitDecision: approvals.awaitDecision.bind(approvals),
      getPending: () => undefined,
      claimVerdictDelivery: approvals.claimVerdictDelivery.bind(approvals),
      releaseVerdictDelivery: approvals.releaseVerdictDelivery.bind(approvals),
    };

    const result = await invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production' },
      { identity: AGENT },
      { approvals: cardless, session, capMs: 1 }
    );

    expect(payloadOf(result).status).toBe('approval_required');
    expect(session.eventQueue).toEqual([]);
  });

  it('leaves the sessionless poll flow byte-identical (no hold seam)', async () => {
    // The external `/mcp` and HTTP surfaces pass no `hold`, so a fresh destructive
    // call returns the poll payload immediately and pushes nothing onto a session.
    const result = await invokeCapabilityAsMcpResult(registry, 'gated.destroy', {
      name: 'production',
    });
    expect(payloadOf(result).status).toBe('approval_required');
    expect(session.eventQueue).toEqual([]);
    expect(ran).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // The delivery claim (spec `approval-verdict-delivery`)
  //
  // A hold and the out-of-band deliverer both wake on the same
  // `approval_resolved` broadcast, so exactly one of them must be allowed to
  // speak. The hold takes the claim when it STARTS waiting rather than when the
  // decision lands, because a hold that is waiting WILL deliver — through its own
  // return value — and claiming at the decision is a race a person can lose in
  // either direction: two turns for one answer, or none at all.
  // ---------------------------------------------------------------------------
  describe('the delivery claim', () => {
    /** Invoke from a session, which is what gives the approval somewhere to deliver. */
    function invokeFromSession(overrides: Partial<CapabilityApprovalHold> = {}) {
      return invokeCapabilityAsMcpResult(
        registry,
        'gated.destroy',
        { name: 'production' },
        { identity: AGENT, sessionId: 'session-1', cwd: '/work/repo' },
        hold(overrides)
      );
    }

    it('records where to deliver, all the way from the invoking surface', async () => {
      // The plumbing claim, end to end: the surface knows the session, the gate
      // passes it, the row keeps it. Without this the columns are the "declared,
      // validated, unreachable" defect and nothing could ever be delivered.
      const resultP = invokeFromSession();
      await vi.waitFor(() => expect(cardData()).toBeDefined());
      const approvalId = cardData()!.approval.approvalId;

      approvals.grant(approvalId);
      await resultP;

      expect(approvals.verdictDelivery(approvalId)).toMatchObject({
        sessionId: 'session-1',
        cwd: '/work/repo',
      });
    });

    it('is taken the moment the hold starts waiting, not when the answer lands', async () => {
      const resultP = invokeFromSession();
      await vi.waitFor(() => expect(cardData()).toBeDefined());
      const approvalId = cardData()!.approval.approvalId;

      // The out-of-band deliverer, arriving mid-wait, is locked out — while the
      // person has not answered anything yet.
      expect(approvals.claimVerdictDelivery(approvalId)).toBe(false);

      approvals.grant(approvalId);
      await resultP;
    });

    it('is KEPT when the person decides, so nothing delivers the answer twice', async () => {
      const resultP = invokeFromSession();
      await vi.waitFor(() => expect(cardData()).toBeDefined());
      const approvalId = cardData()!.approval.approvalId;

      approvals.grant(approvalId);
      await resultP;

      // The tool call itself carried the answer back. A second delivery would be a
      // turn nobody asked for, telling the agent something it already acted on.
      expect(approvals.claimVerdictDelivery(approvalId)).toBe(false);
    });

    it('is RELEASED when the hold gives up without a decision', async () => {
      // The case the whole feature is for: the cap runs out, the person answers at
      // minute twenty, and the out-of-band deliverer must be free to take it. A
      // hold that kept its claim here would leave the answer spoken for by
      // something that has been gone for an hour.
      vi.useFakeTimers();
      try {
        const resultP = invokeFromSession({ capMs: 1_000 });
        await vi.waitFor(() => expect(cardData()).toBeDefined());
        const approvalId = cardData()!.approval.approvalId;
        expect(approvals.claimVerdictDelivery(approvalId)).toBe(false);

        await vi.advanceTimersByTimeAsync(1_000);
        await resultP;

        expect(approvals.claimVerdictDelivery(approvalId)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases nothing it never took', async () => {
      // A hold whose claim was refused — the approval names no session, or
      // something else already owns the delivery — must not hand back a claim it
      // does not hold. Doing so would free a delivery the other path is in the
      // middle of, which is the two-turn failure wearing the opposite hat.
      //
      // Driven against the primitive rather than through the registry, because
      // the losing branch is unreachable end to end: a hold claims the instant it
      // mints its own approval, so it always wins in production. The invariant is
      // still real, and this is the only way to hold it to it.
      const release = vi.fn();
      const outcome = await awaitCapabilityApproval(
        {
          approvals: {
            awaitDecision: () => Promise.resolve('timeout' as const),
            getPending: () => undefined,
            claimVerdictDelivery: () => false,
            releaseVerdictDelivery: release,
          },
          session,
          capMs: 1,
        },
        {
          status: 'approval_required',
          capabilityId: 'gated.destroy',
          capabilityTitle: 'Destroy the thing',
          tier: 'destructive',
          approvalId: '01KXQ3P7ADJY9DSXMZW1XGWCV4',
          approvalToken: 'deadbeef',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          reason: 'no_approval',
          message: 'needs approval',
          retry: {
            channel: 'mcp-argument',
            field: APPROVAL_TOKEN_ARGUMENT,
            instructions: 'retry with the token',
          },
        }
      );

      expect(outcome).toBe('timeout');
      expect(release).not.toHaveBeenCalled();
    });
  });
});
