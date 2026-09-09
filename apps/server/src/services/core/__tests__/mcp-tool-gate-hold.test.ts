/**
 * The hand-registered tool surface waits for a person, and resumes (DOR-1930).
 *
 * The defect: an operator approved four `mesh_unregister` cards and the agent
 * that asked was never told. `mesh_unregister` and `tasks_delete` were the only
 * gated tools still on the poll flow — the call returned `approval_required`,
 * the turn ended, and nothing said a person had answered. The registry path had
 * held inline since DOR-939; this path was scoped out of it.
 *
 * What these pin, in the order they matter:
 *
 * - a granted decision RESUMES the same call and returns its real result;
 * - the resume goes back THROUGH the gate with the token, so the person's
 *   approval is consumed rather than bypassed;
 * - a denial comes back as a refusal and the handler never runs;
 * - no decision before the cap degrades to the exact poll payload — never worse
 *   than the flow it replaces;
 * - a surface with no hold (the external `/mcp` server) is untouched.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ApprovalService } from '../approvals/index.js';
import { initCapabilityTierGate, resetCapabilityTierGate } from '../capabilities/index.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../mcp-tool-gate.js';

const TARGET = '01KXQ3P7ADJY9DSXMZW1XGWCV4';

/** The text payload a gated tool hands back, parsed. */
function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  expect(first?.type).toBe('text');
  return JSON.parse((first as { text: string }).text) as Record<string, unknown>;
}

describe('a hand-registered destructive tool waits for the operator', () => {
  let approvals: ApprovalService;
  let ran: { agentId: string }[];
  let queue: { type: string; data?: unknown }[];

  /** A stand-in for `mesh_unregister`; only its NAME is load-bearing to the gate. */
  function tool(): SdkMcpTool {
    return {
      name: 'mesh_unregister',
      description: 'Unregister an agent by ID.',
      inputSchema: {},
      async handler(args) {
        ran.push(args as { agentId: string });
        return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
      },
    };
  }

  /** The live session the hold renders its inline card into. */
  function session() {
    return { eventQueue: queue, eventQueueNotify: vi.fn() };
  }

  beforeEach(() => {
    ran = [];
    queue = [];
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
  });

  /** Call the gated tool, with or without a hold. */
  function call(hold?: Parameters<typeof gateHandRegisteredMcpTools>[2]) {
    const [gated] = gateHandRegisteredMcpTools([tool()], undefined, hold);
    return gated!.handler({ agentId: TARGET } as Record<string, unknown>, undefined);
  }

  /** The hold seam the in-session server builds. */
  function hold() {
    return { approvals, session: session() } as Parameters<typeof gateHandRegisteredMcpTools>[2];
  }

  /** Answer the one pending approval once the card has been pushed. */
  async function decide(kind: 'grant' | 'deny'): Promise<void> {
    await vi.waitFor(() => expect(approvals.listPending()).toHaveLength(1));
    const id = approvals.listPending()[0]!.approvalId;
    if (kind === 'grant') approvals.grant(id);
    else approvals.deny(id);
  }

  it('resumes the held call and returns its real result on a grant', async () => {
    const pending = call(hold());
    await decide('grant');

    expect(payloadOf(await pending)).toEqual({ success: true });
    // The point of the whole change: the tool actually ran, in the same turn,
    // with the arguments the person approved.
    expect(ran).toEqual([{ agentId: TARGET }]);
  });

  it('puts the card in front of the person while it waits', async () => {
    const pending = call(hold());
    await decide('grant');
    await pending;

    expect(queue.map((e) => e.type)).toEqual([
      'capability_approval_required',
      'capability_approval_resolved',
    ]);
  });

  it('consumes the approval rather than bypassing it', async () => {
    // The resume is a full second gate pass carrying the token, so the person's
    // approval is SPENT. A resume that called the handler directly would leave a
    // live token behind — a second, ungated path to an irreversible effect that
    // outlives the decision the person actually made.
    //
    // Spied on `consume` rather than asserted on `listPending()` being empty:
    // granting alone empties the pending list, so that assertion passes just as
    // well with the resume reverted. `consume` is called by the gate and by
    // nothing else, so seeing it succeed IS seeing the gate re-entered.
    const consume = vi.spyOn(approvals, 'consume');

    const pending = call(hold());
    await decide('grant');
    await pending;

    expect(consume).toHaveBeenCalledOnce();
    expect(consume.mock.results[0]?.value).toMatchObject({ outcome: 'granted' });
  });

  it('refuses, and never runs the tool, on a denial', async () => {
    const pending = call(hold());
    await decide('deny');

    expect(payloadOf(await pending).status).not.toBe('approval_required');
    expect(ran).toEqual([]);
  });

  it('degrades to the poll payload when nobody answers before the cap', async () => {
    // Never worse than the flow it replaces: the card is still on the dashboard
    // and the agent still holds a usable token.
    const [gated] = gateHandRegisteredMcpTools([tool()], undefined, {
      ...hold()!,
      capMs: 10,
    });

    const payload = payloadOf(
      await gated!.handler({ agentId: TARGET } as Record<string, unknown>, undefined)
    );

    expect(payload.status).toBe('approval_required');
    expect(payload.approvalToken).toEqual(expect.any(String));
    expect(ran).toEqual([]);
  });

  it('leaves a surface with no hold exactly as it was', async () => {
    // The external `/mcp` server is sessionless — there is no event queue to
    // render a card into — so it keeps the poll flow, and this is what makes the
    // change additive rather than a behavior change for every caller.
    const payload = payloadOf(await call(undefined));

    expect(payload.status).toBe('approval_required');
    expect(queue).toEqual([]);
    expect(ran).toEqual([]);
  });
});
