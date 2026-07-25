/**
 * The MCP half of the enforcement choke point (spec `agent-trust` §3.2).
 *
 * Both MCP adapters funnel every tool call through `invokeCapabilityAsMcpResult`,
 * so this is where the gate runs for the in-session `dorkos` server and the
 * external `/mcp` server alike. What these tests pin:
 *
 * - a destructive tool advertises the extra `approvalToken` argument, and nothing
 *   else does;
 * - an unapproved destructive call comes back as an ORDINARY result carrying the
 *   `approval_required` payload — needing a person is a protocol step, not an
 *   error — and the handler never runs;
 * - the token rides alongside the input and is stripped before the handler sees
 *   it, so the approval binding covers the arguments that actually execute;
 * - a granted approval reaches the handler on the invocation context, which is
 *   what stops a self-confirming capability from asking a second time.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';

import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityDomain,
  type CapabilityInvocationContext,
} from '../index.js';
import { capabilityInputShape, invokeCapabilityAsMcpResult } from '../mcp-projection.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/index.js';

const AGENT: AgentIdentity = {
  agentPath: '/projects/prober',
  displayName: 'Prober',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

describe('invokeCapabilityAsMcpResult — tier enforcement', () => {
  let ran: { input: unknown; context: CapabilityInvocationContext }[];
  let approvals: ApprovalService;

  /** Two capabilities: one destructive (recorded), one act (for contrast). */
  function domain(): CapabilityDomain {
    const record = async (input: unknown, context: CapabilityInvocationContext) => {
      ran.push({ input, context });
      return { ok: true };
    };
    return {
      name: 'gated',
      capabilities: [
        defineCapability({
          id: 'gated.destroy',
          title: 'Destroy the thing',
          description: 'Deletes the named thing. Cannot be undone.',
          tier: 'destructive',
          input: z.object({ name: z.string() }),
          output: z.object({ ok: z.boolean() }),
          surfaces: { mcp: { toolName: 'gated_destroy', servers: ['in-session', 'external'] } },
          invoke: async (_deps, input, context) => record(input, context),
        }),
        defineCapability({
          id: 'gated.tidy',
          title: 'Tidy the thing',
          description: 'Rearranges the named thing, reversibly.',
          tier: 'act',
          input: z.object({ name: z.string() }),
          output: z.object({ ok: z.boolean() }),
          surfaces: { mcp: { toolName: 'gated_tidy', servers: ['in-session', 'external'] } },
          invoke: async (_deps, input, context) => record(input, context),
        }),
      ],
    };
  }

  let registry: ReturnType<typeof composeRegistry>;

  beforeEach(() => {
    ran = [];
    registry = composeRegistry([domain()], { logger: noopLogger });
    approvals = new ApprovalService(createTestDb());
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  /** The plain payload inside an MCP text result. */
  function payloadOf(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
    return JSON.parse(result.content[0].text ?? 'null') as Record<string, unknown>;
  }

  describe('advertised input shape', () => {
    it('adds approvalToken to a destructive tool only', () => {
      const destroy = capabilityInputShape(registry.get('gated.destroy')!);
      const tidy = capabilityInputShape(registry.get('gated.tidy')!);
      expect(Object.keys(destroy).sort()).toEqual(['approvalToken', 'name']);
      expect(Object.keys(tidy)).toEqual(['name']);
    });

    it('leaves the capability input schema untouched', () => {
      // The extra argument is an adapter-level affordance; the schema the approval
      // binds to must not grow a field.
      expect(Object.keys((registry.get('gated.destroy')!.input as z.ZodObject).shape)).toEqual([
        'name',
      ]);
    });
  });

  it('returns approval_required as an ordinary result and runs nothing', async () => {
    const result = await invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production' },
      { identity: AGENT }
    );

    expect(result.isError).toBeUndefined();
    const payload = payloadOf(result);
    expect(payload.status).toBe('approval_required');
    expect(payload.retry).toMatchObject({ channel: 'mcp-argument', field: 'approvalToken' });
    expect(ran).toEqual([]);
  });

  it('runs the capability on a retry with the token, and hides the token from the handler', async () => {
    const asked = payloadOf(
      await invokeCapabilityAsMcpResult(
        registry,
        'gated.destroy',
        { name: 'production' },
        { identity: AGENT }
      )
    );
    approvals.grant(asked.approvalId as string);

    const result = await invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production', approvalToken: asked.approvalToken as string },
      { identity: AGENT }
    );

    expect(payloadOf(result)).toEqual({ ok: true });
    expect(ran).toHaveLength(1);
    // The handler sees the capability's input and nothing else.
    expect(ran[0].input).toEqual({ name: 'production' });
    // …and it can see that a person already approved THIS call.
    expect(ran[0].context.approval?.approvalId).toBe(asked.approvalId);
  });

  it('lets an act capability straight through, with no approval on the context', async () => {
    const result = await invokeCapabilityAsMcpResult(
      registry,
      'gated.tidy',
      { name: 'production' },
      { identity: AGENT }
    );
    expect(payloadOf(result)).toEqual({ ok: true });
    expect(ran[0].context.approval).toBeUndefined();
  });

  it('refuses an agent whose ceiling forbids the tier', async () => {
    const result = await invokeCapabilityAsMcpResult(
      registry,
      'gated.destroy',
      { name: 'production' },
      { identity: { ...AGENT, tierCeiling: 'act' } }
    );
    expect(payloadOf(result).status).toBe('denied');
    expect(payloadOf(result).approvable).toBe(false);
    expect(ran).toEqual([]);
  });

  it('leaves an unattributed call exactly as it was before the gate existed', async () => {
    const result = await invokeCapabilityAsMcpResult(registry, 'gated.destroy', {
      name: 'production',
    });
    expect(payloadOf(result)).toEqual({ ok: true });
    expect(ran).toHaveLength(1);
  });

  it('still reports an unknown capability id through the registry', async () => {
    await expect(invokeCapabilityAsMcpResult(registry, 'gated.nope', {})).rejects.toThrow(
      /no capability registered/
    );
  });
});
