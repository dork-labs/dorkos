/**
 * The whole loop the operator actually hit (DOR-1929).
 *
 * The unit tests either side of this one prove their own halves — the resolver
 * fails closed, the summary substitutes by field path, the card renders a
 * subject block. None of them proves the halves are CONNECTED, and that is
 * exactly where this defect could come back: a declaration the gate drops, a
 * resolver boot forgets to wire, or a subject that never reaches the row the
 * card reads would each leave every one of those tests green.
 *
 * So this drives the real `mesh_unregister` tier declaration through the real
 * hand-registered gate, against a real `ApprovalService` on a real database, and
 * reads the result off `listPending()` — the same call `GET
 * /api/approvals/pending` serves to the card.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ApprovalService } from '../approvals/index.js';
import {
  initApprovalSubjectResolvers,
  resetApprovalSubjectResolvers,
} from '../approvals/approval-subject.js';
import { initCapabilityTierGate, resetCapabilityTierGate } from '../capabilities/index.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../mcp-tool-gate.js';

/** The id from the operator's screenshot, kept so the fixture names the report. */
const TARGET = '01KXQ3P7ADJY9DSXMZW1XGWCV4';

/** A stand-in for the real `mesh_unregister` tool; only its NAME is load-bearing. */
function meshUnregisterTool(onRun: () => void): SdkMcpTool {
  return {
    name: 'mesh_unregister',
    description: 'Unregister an agent by ID, removing it from the registry.',
    inputSchema: {},
    async handler() {
      onRun();
      return { content: [{ type: 'text' as const, text: '{}' }] };
    },
  };
}

describe('an approval card names the agent it would remove', () => {
  let approvals: ApprovalService;
  let ran: number;

  beforeEach(() => {
    ran = 0;
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetApprovalSubjectResolvers();
  });

  /** Call the gated tool once and hand back what the person would be shown. */
  async function askToRemove(agentId: string): Promise<CallToolResult> {
    const [gated] = gateHandRegisteredMcpTools([meshUnregisterTool(() => (ran += 1))]);
    return gated!.handler({ agentId } as Record<string, unknown>, undefined);
  }

  it('resolves the id to the name the registry holds, end to end', async () => {
    initApprovalSubjectResolvers({ agent: (id) => (id === TARGET ? 'Lab Scout' : undefined) });

    await askToRemove(TARGET);

    const [pending] = approvals.listPending();
    expect(pending?.subject).toEqual({ kind: 'agent', label: 'Lab Scout', id: TARGET });
    // And the sentence itself names the agent, which is what carries the fix to
    // the Activity feed and the notification without either of them changing.
    expect(pending?.summary).toContain('agent: "Lab Scout"');
    expect(pending?.summary).not.toContain(TARGET);
  });

  it('still asks, and still refuses to run, once it can name the target', async () => {
    // The point of the card is the decision, not the prose. Naming the subject
    // must not have turned a gated call into an allowed one.
    initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

    const result = await askToRemove(TARGET);

    const first = result.content[0];
    expect(first?.type).toBe('text');
    expect(JSON.parse((first as { text: string }).text).status).toBe('approval_required');
    expect(ran).toBe(0);
  });

  it('falls back to the raw id when the registry no longer holds it', async () => {
    // The agent is already gone, or the registry is down. The card must still
    // say WHICH id — losing the argument would be worse than the original bug.
    initApprovalSubjectResolvers({ agent: () => undefined });

    await askToRemove(TARGET);

    const [pending] = approvals.listPending();
    expect(pending?.subject).toBeUndefined();
    expect(pending?.summary).toContain(`agentId: "${TARGET}"`);
  });

  it('falls back the same way when nothing wired the resolvers at all', async () => {
    // Boot forgot, or this is a surface that never wires them. Legibility
    // degrades; the gate does not.
    await askToRemove(TARGET);

    const [pending] = approvals.listPending();
    expect(pending?.subject).toBeUndefined();
    expect(pending?.summary).toContain(`agentId: "${TARGET}"`);
    expect(ran).toBe(0);
  });

  it('records the surface the request came over, since nothing named the caller', async () => {
    initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

    await askToRemove(TARGET);

    // The in-session entry point. This is the bit that turns "an unidentified
    // caller" into a sentence that says the true thing.
    expect(approvals.listPending()[0]?.origin).toBe('session');
  });

  it('takes the name from the registry, never from what the caller sent', async () => {
    // The spoofing case: a caller passing its own label must not be able to
    // dress one agent up as another. The resolver is handed the id and reads the
    // name itself, so the extra arguments are inert.
    initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

    const [gated] = gateHandRegisteredMcpTools([meshUnregisterTool(() => (ran += 1))]);
    await gated!.handler({ agentId: TARGET, displayName: 'DorkBot', label: 'DorkBot' }, undefined);

    const [pending] = approvals.listPending();
    expect(pending?.subject?.label).toBe('Lab Scout');
    expect(pending?.summary).not.toContain('DorkBot');
  });

  it('sends the card nothing to repeat when the subject was the only argument', async () => {
    // `mesh_unregister` declares exactly one display field, and the card now
    // draws it itself. Anything left here would be the title and the name said a
    // second time, directly under the first.
    initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

    await askToRemove(TARGET);

    expect(approvals.listPending()[0]?.otherArguments).toBeUndefined();
  });

  it('keeps the summary self-contained for the surfaces that have no card', async () => {
    // A notification and an Activity row get no heading and no subject block, so
    // the sentence still has to stand on its own.
    initApprovalSubjectResolvers({ agent: () => 'Lab Scout' });

    await askToRemove(TARGET);

    expect(approvals.listPending()[0]?.summary).toBe(
      // The TITLE comes from `MCP_TOOL_TIERS`, never from the tool's own
      // model-facing description — pinned here because the two differ, and the
      // card must show the sentence written for a person.
      'An unidentified caller wants to run "Remove an agent and its setup file, and turn off its scheduled tasks" with agent: "Lab Scout"'
    );
  });
});
