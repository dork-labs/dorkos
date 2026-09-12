/**
 * What a held tool call tells the agent when its approval stops being
 * answerable (spec `approval-expiry-notice`, DOR-1932).
 *
 * ## The hole this closes
 *
 * DOR-1932 made an unanswered approval settle on a sweep and deliver a notice to
 * the requesting session. That delivery cannot reach a session whose hold is
 * still waiting, and by design: the hold takes the single-delivery claim when it
 * STARTS waiting, so the out-of-band deliverer composes the notice, loses the
 * claim, and drops it. The hold is supposed to report the ending itself, in the
 * turn the agent is still running.
 *
 * It did not. It returned the original `approval_required` poll payload
 * verbatim, whose every claim was false by then: no card was left for anyone to
 * answer (`listPending` filters expired rows), nobody could approve it (`decide`
 * refuses a spent row), and the token it told the agent to retry with had just
 * been written off. So the one configuration where the sweep and a live hold
 * overlap was the one where the agent was actively misled.
 *
 * That overlap is not exotic: it is every window shorter than the ten-minute
 * hold cap, which is exactly what `DORKOS_APPROVAL_TTL_MS` exists to configure —
 * the repo's own governance eval sets it to five seconds.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { approvals as approvalsTable, eq, type Db } from '@dorkos/db';

import { ApprovalService } from '../approvals/index.js';
import { startApprovalVerdictDelivery } from '../approvals/approval-verdict-delivery.js';
import { initCapabilityTierGate, resetCapabilityTierGate } from '../capabilities/index.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../mcp-tool-gate.js';

const TARGET = '01KXQ3P7ADJY9DSXMZW1XGWCV4';

/** The JSON body a gated tool hands back, unwrapped from the MCP text envelope. */
function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  expect(first?.type).toBe('text');
  return JSON.parse((first as { text: string }).text) as Record<string, unknown>;
}

describe('a held call whose approval stops being answerable', () => {
  let db: Db;
  let approvals: ApprovalService;
  let queue: { type: string; data?: unknown }[];
  let stopDelivery: () => void;

  function tool(): SdkMcpTool {
    return {
      name: 'mesh_unregister',
      description: 'Unregister an agent by ID.',
      inputSchema: {},
      async handler() {
        return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
      },
    };
  }

  beforeEach(() => {
    db = createTestDb();
    approvals = new ApprovalService(db);
    queue = [];
    stopDelivery = startApprovalVerdictDelivery(approvals);
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    stopDelivery();
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  /**
   * Start a held destructive call, let its window close underneath it, and sweep.
   * Returns what the agent is handed back.
   */
  async function holdThenExpire(): Promise<{
    payload: Record<string, unknown>;
    approvalId: string;
  }> {
    const [gated] = gateHandRegisteredMcpTools(
      [tool()],
      undefined,
      {
        approvals,
        session: { eventQueue: queue as never, eventQueueNotify: vi.fn() },
        capMs: 3_000,
      },
      () => ({ sessionId: 'session-42', cwd: '/agents/scout' })
    );

    const pending = gated!.handler({ agentId: TARGET } as Record<string, unknown>, undefined);

    await vi.waitFor(() => expect(approvals.listPending()).toHaveLength(1));
    const approvalId = approvals.listPending()[0]!.approvalId;
    // The window closes while the hold is still waiting — the whole overlap.
    db.update(approvalsTable)
      .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(approvalsTable.id, approvalId))
      .run();
    expect(approvals.sweepExpired()).toBe(1);

    return { payload: payloadOf(await pending), approvalId };
  }

  it('says the approval is no longer open, rather than replaying the poll payload', async () => {
    const { payload } = await holdThenExpire();

    expect(payload.status).toBe('approval_no_longer_valid');
    expect(payload.capabilityTitle).toBeTruthy();
  });

  it('hands back no token and no retry instructions, because there are none', async () => {
    // The precise failure: the old payload advertised BOTH, and an agent that
    // followed them would retry with a token the sweep had already written off.
    const { payload } = await holdThenExpire();

    expect(payload.approvalToken).toBeUndefined();
    expect(payload.retry).toBeUndefined();
    expect(
      JSON.stringify(payload),
      'the agent was told an approval card is still waiting and to retry with its token, ' +
        'after the sweep had already killed both'
    ).not.toMatch(/Once they have approved it/);
  });

  it('tells the agent not to route around the refusal', async () => {
    const { payload } = await holdThenExpire();
    const message = String(payload.message).toLowerCase();

    expect(message).toContain('no longer open');
    expect(message).toContain('will not work');
    // An agent reading a non-refusal as latitude is the failure that matters.
    expect(message).toContain('do not look for another way');
  });

  it('leaves nothing for the out-of-band deliverer to say twice', async () => {
    // The hold reported the ending itself, so it KEEPS the delivery claim. If it
    // handed the claim back here, the row would sit inviting a second delivery
    // that no broadcast would ever trigger — and if a broadcast did come, the
    // agent would be told the same thing twice.
    const { approvalId } = await holdThenExpire();

    const row = db.select().from(approvalsTable).where(eq(approvalsTable.id, approvalId)).get();
    expect(row?.notifiedAt).not.toBeNull();
  });

  it('still points a merely-slow call at its live card, with its live token', async () => {
    // The other no-decision ending must NOT change: when the hold cap runs out
    // while the window is still open, every word of the poll payload is true and
    // the out-of-band deliverer is the one that will speak later.
    const [gated] = gateHandRegisteredMcpTools(
      [tool()],
      undefined,
      {
        approvals,
        session: { eventQueue: queue as never, eventQueueNotify: vi.fn() },
        capMs: 50,
      },
      () => ({ sessionId: 'session-42', cwd: '/agents/scout' })
    );

    const payload = payloadOf(
      await gated!.handler({ agentId: TARGET } as Record<string, unknown>, undefined)
    );

    expect(payload.status).toBe('approval_required');
    expect(payload.approvalToken).toBeTruthy();
    expect(approvals.listPending()).toHaveLength(1);

    // And the claim went back, so whoever answers later can still be delivered to.
    const approvalId = approvals.listPending()[0]!.approvalId;
    const row = db.select().from(approvalsTable).where(eq(approvalsTable.id, approvalId)).get();
    expect(row?.notifiedAt).toBeNull();
  });
});
