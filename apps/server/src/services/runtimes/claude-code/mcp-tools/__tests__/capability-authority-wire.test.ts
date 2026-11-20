/** Real SDK/MCP → shared invocation → registry → real approval service proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { noopLogger } from '@dorkos/shared/logger';
import { approvals as approvalRows } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityInvocationContext,
  type CapabilityHandlerContext,
} from '../../../../core/capabilities/index.js';
import { ApprovalService, hashApprovalInput } from '../../../../core/approvals/index.js';
import { registerCapabilitiesAsMcpTools } from '../../../../core/external-mcp/capability-mcp-tools.js';
import { registerClaudeCapabilityTools } from '../capability-mcp-tools.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';

const identity = {
  agentPath: '/agents/wire',
  displayName: 'Wire',
  createdAt: '2026-11-16T00:00:00.000Z',
};
const clients = new Set<Client>();
let db: ReturnType<typeof createTestDb>;
let approvals: ApprovalService;
let calls: Array<{ id: string; input: unknown; context: CapabilityHandlerContext }>;
let session: { eventQueue: StreamEvent[]; eventQueueNotify: () => void };

beforeEach(() => {
  db = createTestDb();
  approvals = new ApprovalService(db);
  initCapabilityTierGate({ approvals });
  calls = [];
  session = { eventQueue: [], eventQueueNotify: vi.fn<() => void>() };
});
afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
  resetCapabilityTierGate();
});

function fixture() {
  const input = z.object({
    name: z.string().default('production'),
    limit: z.coerce.number().int().default(2),
    options: z.object({}).catchall(z.unknown()).default({}),
  });
  const cap = (
    id: string,
    tier: 'observe' | 'destructive',
    servers: Array<'in-session' | 'external'>
  ) =>
    defineCapability({
      id: `wire.${id}`,
      title: 'Wire fixture',
      description: 'Recording handler; no external service.',
      tier,
      area: null,
      input,
      output: z.unknown(),
      surfaces: { mcp: { toolName: `wire_${id}`, servers } },
      invoke: async (_deps, args, context) => {
        calls.push({ id, input: args, context });
        return args;
      },
    });
  return composeRegistry(
    [
      {
        name: 'wire',
        capabilities: [
          cap('destroy', 'destructive', ['in-session', 'external']),
          cap('read', 'observe', ['in-session', 'external']),
          cap('session', 'observe', ['in-session']),
          cap('external', 'observe', ['external']),
          defineCapability({
            id: 'wire.signin',
            title: 'Sign in',
            description: 'A card fixture without a network request.',
            tier: 'act',
            area: null,
            input: z.object({ agentId: z.string(), name: z.string() }),
            output: z.unknown(),
            surfaces: { mcp: { toolName: 'wire_signin', servers: ['in-session', 'external'] } },
            inSessionCard: 'signin',
            invoke: async () => ({
              flowId: 'wire-flow',
              authorizeUrl: 'https://example.com/authorize',
              disclosure: 'Read the selected account.',
              message: 'Open the sign-in link.',
            }),
          }),
        ],
      },
    ],
    { logger: noopLogger }
  );
}

async function connect(
  registry: ReturnType<typeof fixture>,
  surface: 'in-session' | 'external',
  resolve: (
    id: string,
    signal?: AbortSignal
  ) => Promise<CapabilityInvocationContext> = async () => ({ identity }),
  hold = false
) {
  const server =
    surface === 'in-session'
      ? createSdkMcpServer({ name: 'wire', version: '1.0.0', tools: [] }).instance
      : new McpServer({ name: 'wire-external', version: '1.0.0' });
  if (surface === 'in-session')
    registerClaudeCapabilityTools(
      server,
      registry,
      surface,
      resolve,
      hold ? { session, approvals } : undefined
    );
  else registerCapabilitiesAsMcpTools(server, registry, surface, await resolve('request'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'authority-wire-proof', version: '1.0.0' });
  clients.add(client);
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}
function payload(result: unknown): Record<string, unknown> {
  const response = result as CallToolResult;
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const block = response.content[0];
  expect(block?.type).toBe('text');
  return JSON.parse((block as { text: string }).text) as Record<string, unknown>;
}
function card() {
  const events = session.eventQueue.filter(
    (event) => event.type === 'capability_approval_required'
  );
  expect(events).toHaveLength(1);
  return events[0]!.data as { approval: { approvalId: string } };
}

describe('full-object authority through real MCP calls', () => {
  it.each(['in-session', 'external'] as const)(
    '%s binds a retry to parsed defaults and refuses unknown authority before approval',
    async (surface) => {
      const client = await connect(fixture(), surface);
      const listed = (await client.listTools()).tools;
      expect(listed.filter((tool) => tool.name === 'wire_destroy')).toHaveLength(1);
      expect(
        listed.find((tool) => tool.name === 'wire_destroy')!.inputSchema.properties
      ).toHaveProperty('approvalToken');
      expect(
        listed.find((tool) => tool.name === 'wire_read')!.inputSchema.properties
      ).not.toHaveProperty('approvalToken');
      for (const name of ['extra', 'ownerId']) {
        expect(
          (await client.callTool({ name: 'wire_destroy', arguments: { [name]: 'hostile' } }))
            .isError
        ).toBe(true);
        expect(db.select().from(approvalRows).all()).toEqual([]);
        expect(calls).toEqual([]);
      }
      const options = { ownerId: 'nested data', values: { enabled: true } };
      const ask = payload(await client.callTool({ name: 'wire_destroy', arguments: { options } }));
      expect(ask.status).toBe('approval_required');
      expect(calls).toEqual([]);
      const rows = db.select().from(approvalRows).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        capabilityId: 'wire.destroy',
        inputHash: hashApprovalInput({ name: 'production', limit: 2, options }),
      });
      approvals.grant(ask.approvalId as string);
      const mismatch = payload(
        await client.callTool({
          name: 'wire_destroy',
          arguments: { options, limit: 3, approvalToken: ask.approvalToken },
        })
      );
      expect(mismatch.status).toBe('approval_required');
      expect(mismatch.approvalId).not.toBe(ask.approvalId);
      expect(calls).toEqual([]);
      approvals.deny(mismatch.approvalId as string);
      expect(
        payload(
          await client.callTool({
            name: 'wire_destroy',
            arguments: {
              name: 'production',
              limit: '2',
              options,
              approvalToken: ask.approvalToken,
            },
          })
        )
      ).toEqual({ name: 'production', limit: 2, options });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.context.approval).toEqual({ via: 'approval', approvalId: ask.approvalId });
      expect(calls[0]!.input).toEqual({ name: 'production', limit: 2, options });
      expect(
        (
          await client.callTool({
            name: 'wire_read',
            arguments: { approvalToken: ask.approvalToken },
          })
        ).isError
      ).toBe(true);
      expect(calls).toHaveLength(1);
      expect(payload(await client.callTool({ name: 'wire_read', arguments: {} }))).toEqual({
        name: 'production',
        limit: 2,
        options: {},
      });
      expect(calls).toHaveLength(2);
    }
  );

  it('external token/poll repeats the pending subject and denied retries never execute', async () => {
    const client = await connect(fixture(), 'external');
    const ask = payload(await client.callTool({ name: 'wire_destroy', arguments: {} }));
    const pending = payload(
      await client.callTool({
        name: 'wire_destroy',
        arguments: { approvalToken: ask.approvalToken },
      })
    );
    expect(pending.approvalId).toBe(ask.approvalId);
    expect(pending.status).toBe('approval_required');
    expect(db.select().from(approvalRows).all()).toHaveLength(1);
    expect(calls).toEqual([]);
    approvals.deny(ask.approvalId as string);
    expect(
      payload(
        await client.callTool({
          name: 'wire_destroy',
          arguments: { approvalToken: ask.approvalToken },
        })
      )
    ).toMatchObject({ status: 'denied' });
    expect(calls).toEqual([]);
    expect(session.eventQueue).toEqual([]);
    const allowed = payload(
      await client.callTool({ name: 'wire_destroy', arguments: { name: 'staging' } })
    );
    approvals.grant(allowed.approvalId as string);
    await client.callTool({
      name: 'wire_destroy',
      arguments: { name: 'staging', approvalToken: allowed.approvalToken },
    });
    expect(calls.map((call) => call.input)).toEqual([{ name: 'staging', limit: 2, options: {} }]);
  });

  it.each(['grant', 'deny'] as const)(
    'in-session holds the exact card and resumes on %s',
    async (decision) => {
      const client = await connect(
        fixture(),
        'in-session',
        async () => ({ identity, sessionId: 'held-session', cwd: '/work/held' }),
        true
      );
      const response = client.callTool({ name: 'wire_destroy', arguments: {} });
      await vi.waitFor(() =>
        expect(
          session.eventQueue.filter((event) => event.type === 'capability_approval_required')
        ).toHaveLength(1)
      );
      const id = card().approval.approvalId;
      expect(calls).toEqual([]);
      if (decision === 'grant') approvals.grant(id);
      else approvals.deny(id);
      const result = payload(await response);
      expect(approvals.verdictDelivery(id)).toMatchObject({
        sessionId: 'held-session',
        cwd: '/work/held',
      });
      expect(calls).toHaveLength(decision === 'grant' ? 1 : 0);
      if (decision === 'grant')
        expect(result).toEqual({ name: 'production', limit: 2, options: {} });
      else expect(result.status).toBe('denied');
      expect(
        session.eventQueue.filter((event) => event.type === 'capability_approval_resolved')
      ).toHaveLength(1);
      if (decision === 'deny') {
        const read = payload(await client.callTool({ name: 'wire_read', arguments: {} }));
        expect(read.name).toBe('production');
        expect(calls.map((call) => call.id)).toEqual(['read']);
      }
    }
  );

  it('cancels a real SDK hold without execution, then grants the same capability on a fresh call', async () => {
    const client = await connect(
      fixture(),
      'in-session',
      async () => ({ identity, sessionId: 'cancel-session' }),
      true
    );
    const controller = new AbortController();
    const response = client.callTool({ name: 'wire_destroy', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    const cancelled = expect(response).rejects.toThrow();
    await vi.waitFor(() =>
      expect(
        session.eventQueue.filter((event) => event.type === 'capability_approval_required')
      ).toHaveLength(1)
    );
    const id = card().approval.approvalId;
    controller.abort(new Error('test cancellation'));
    await cancelled;
    await vi.waitFor(() =>
      expect(
        session.eventQueue.filter((event) => event.type === 'capability_approval_resolved')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ approvalId: id, outcome: 'timeout' }),
        }),
      ])
    );
    expect(calls).toEqual([]);
    const positive = client.callTool({
      name: 'wire_destroy',
      arguments: { name: 'fresh-control' },
    });
    await vi.waitFor(() =>
      expect(
        session.eventQueue.filter((event) => event.type === 'capability_approval_required')
      ).toHaveLength(2)
    );
    const next = session.eventQueue.filter(
      (event) => event.type === 'capability_approval_required'
    )[1]!.data as { approval: { approvalId: string } };
    expect(next.approval.approvalId).not.toBe(id);
    approvals.grant(next.approval.approvalId);
    expect(payload(await positive)).toEqual({ name: 'fresh-control', limit: 2, options: {} });
    expect(calls.map((call) => call.input)).toEqual([
      { name: 'fresh-control', limit: 2, options: {} },
    ]);
  });

  it('keeps card projection in-session and leaves external sign-in payloads intact', async () => {
    const registry = fixture();
    const local = await connect(registry, 'in-session', async () => ({ identity }), true);
    const external = await connect(registry, 'external');
    const args = { agentId: 'wire-agent', name: 'wire-service' };
    const result = payload(await local.callTool({ name: 'wire_signin', arguments: args }));
    expect(result.message).toContain('already on screen');
    expect(session.eventQueue.filter((event) => event.type === 'mcp_signin_required')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: 'wire-agent',
          serverName: 'wire-service',
          flowId: 'wire-flow',
        }),
      }),
    ]);
    expect(
      payload(await external.callTool({ name: 'wire_signin', arguments: args }))
    ).toMatchObject({
      message: 'Open the sign-in link.',
      authorizeUrl: 'https://example.com/authorize',
    });
    expect(session.eventQueue.filter((event) => event.type === 'mcp_signin_required')).toHaveLength(
      1
    );
  });

  it('keeps ordinary audiences separate with a successful same-surface control', async () => {
    const registry = fixture();
    for (const surface of ['in-session', 'external'] as const) {
      const client = await connect(registry, surface);
      const own = surface === 'in-session' ? 'wire_session' : 'wire_external';
      const other = surface === 'in-session' ? 'wire_external' : 'wire_session';
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        ['wire_destroy', 'wire_read', 'wire_signin', own].sort()
      );
      expect((await client.callTool({ name: other, arguments: {} })).isError).toBe(true);
      expect(calls).toHaveLength(surface === 'in-session' ? 0 : 1);
      payload(await client.callTool({ name: own, arguments: {} }));
    }
    expect(calls.map((call) => call.id)).toEqual(['session', 'external']);
  });

  it('resolves current session, principal, cwd and signal on each ordinary call', async () => {
    const principal = (suffix: string) =>
      createServerPrincipal({
        kind: 'runtime',
        runtime: 'claude-code',
        owner: { kind: 'local_install', installationId: 'wire-install' },
        bindingId: `binding-${suffix}`,
        canonicalSessionId: `session-${suffix}`,
        agentId: `agent-${suffix}`,
        agentPath: `/agents/${suffix}`,
        canonicalCwd: `/work/${suffix}`,
      });
    let suffix = 'a';
    const proofs = { a: principal('a'), b: principal('b') };
    const resolve = vi.fn(async (_id: string, signal?: AbortSignal) => ({
      identity,
      sessionId: `session-${suffix}`,
      cwd: `/work/${suffix}`,
      serverPrincipal: proofs[suffix as 'a' | 'b'],
      signal,
    }));
    const client = await connect(fixture(), 'in-session', resolve);
    payload(await client.callTool({ name: 'wire_read', arguments: {} }));
    suffix = 'b';
    payload(await client.callTool({ name: 'wire_read', arguments: {} }));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    expect(
      calls.map((call) => [call.context.sessionId, call.context.cwd, call.context.serverPrincipal])
    ).toEqual([
      ['session-a', '/work/a', proofs.a],
      ['session-b', '/work/b', proofs.b],
    ]);
    for (const call of calls) {
      expect(call.context.mcpServer).toBe('in-session');
      expect(call.context.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[0]!.context.signal).not.toBe(calls[1]!.context.signal);
  });
});
