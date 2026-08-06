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
 * - the hold cap sits below the verified MCP request timeout.
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
  CAPABILITY_APPROVAL_HOLD_CAP_MS,
  MCP_SDK_REQUEST_TIMEOUT_MS,
  type CapabilityApprovalHold,
} from '../capability-approval-hold.js';
import { ApprovalService } from '../../approvals/index.js';
import { SESSIONS } from '../../../../config/constants.js';
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

  it('caps the hold below the verified MCP request timeout', () => {
    // The knowable number: @modelcontextprotocol/sdk 1.29.0 DEFAULT_REQUEST_TIMEOUT_MSEC.
    expect(MCP_SDK_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(CAPABILITY_APPROVAL_HOLD_CAP_MS).toBeLessThan(MCP_SDK_REQUEST_TIMEOUT_MS);
    // …and below the 10-minute interaction timeout too, the other ceiling.
    expect(CAPABILITY_APPROVAL_HOLD_CAP_MS).toBeLessThan(SESSIONS.INTERACTION_TIMEOUT_MS);
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
});
