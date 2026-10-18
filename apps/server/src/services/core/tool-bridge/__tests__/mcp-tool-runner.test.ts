/**
 * The live bridged-tool runner (DOR-2939 part 6): it builds the hub's MCP
 * server for the calling agent, as that agent and never a person, and carries
 * results back without the tool's own failure sentence.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpCaller } from '../../../../routes/mcp.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { createMcpBridgedToolRunner, outcomeOfToolResult } from '../mcp-tool-runner.js';
import { agentInactiveOf } from '../bridge-guards.js';
import { AgentIdentityService } from '../../agent-identity/agent-identity-service.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { currentAuditActor, runWithAuditActor } from '../../../audit/audit-context.js';
import type { BridgedToolRun } from '../bridged-tool-call.js';

const RUN: BridgedToolRun = {
  caller: 'agent-computer',
  identity: {
    agentPath: '/hub/agents/scout',
    displayName: 'Scout',
    createdAt: '2026-10-18T00:00:00Z',
  },
  sessionId: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c',
  computerId: 'cc-1',
};

/** A server with two tools, recording who it was built for. */
function fakeFactory(seen: McpCaller[]) {
  return (caller: McpCaller) => {
    seen.push(caller);
    const server = new McpServer({ name: 'fake', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echo', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text: JSON.stringify({ said: text }) }] })
    );
    server.registerTool('fail', { description: 'Fail' }, async () => ({
      content: [
        { type: 'text', text: JSON.stringify({ error: 'open /Users/x/.env', code: 'ENOENT' }) },
      ],
      isError: true,
    }));
    return server;
  };
}

describe('the live runner', () => {
  it('builds the server as the agent, with no signed-in person', async () => {
    const seen: McpCaller[] = [];
    const runner = createMcpBridgedToolRunner(fakeFactory(seen));
    await runner.call({ ...RUN, tool: 'echo', input: { text: 'hi' } });
    expect(seen).toEqual([
      { identity: RUN.identity, agentIdentityPresented: true, callerKind: 'agent-computer' },
    ]);
  });

  it('lists the server`s tools and runs one', async () => {
    const runner = createMcpBridgedToolRunner(fakeFactory([]));
    const tools = await runner.list(RUN);
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'fail']);
    expect(tools[0]!.inputSchema).toMatchObject({ type: 'object' });
    expect(await runner.call({ ...RUN, tool: 'echo', input: { text: 'hi' } })).toEqual({
      ok: true,
      output: { said: 'hi' },
    });
  });

  it('carries a failure`s code, never its sentence', async () => {
    const runner = createMcpBridgedToolRunner(fakeFactory([]));
    const failed = await runner.call({ ...RUN, tool: 'fail', input: {} });
    expect(failed).toEqual({ ok: false, code: 'ENOENT', message: 'The tool could not finish.' });
  });
});

describe('a tool result, as the relay carries it', () => {
  it('reads the gate`s refusal as denied, error or not', () => {
    const denied = { status: 'denied', reason: 'permission_blocked', message: 'No.' };
    expect(
      outcomeOfToolResult({
        content: [{ type: 'text', text: JSON.stringify(denied) }],
        isError: true,
      })
    ).toMatchObject({ ok: false, code: 'denied' });
    expect(
      outcomeOfToolResult({ content: [{ type: 'text', text: JSON.stringify(denied) }] })
    ).toMatchObject({ ok: false, code: 'denied' });
  });

  it('keeps an approval the tool needs as an ordinary answer', () => {
    const pending = { status: 'approval_required', approvalToken: 't' };
    expect(
      outcomeOfToolResult({ content: [{ type: 'text', text: JSON.stringify(pending) }] })
    ).toEqual({ ok: true, output: pending });
  });
});

describe('the agent`s standing and the audit scope', () => {
  it('reads a revoked agent off the identity service', async () => {
    const db = createTestDb();
    const service = new AgentIdentityService(db);
    expect(await agentInactiveOf('/hub/agents/scout', service)).toBeUndefined();
    await service.mint({ agentPath: '/hub/agents/scout', displayName: 'Scout' });
    expect(await agentInactiveOf('/hub/agents/scout', service)).toBeUndefined();
    await service.revoke('/hub/agents/scout');
    expect(await agentInactiveOf('/hub/agents/scout', service)).toBe('revoked');
  });

  it('runs the tool in its own scope, as the agent in the bridged session', async () => {
    const auditDb = createTestDb();
    initAuditTrail({
      log: new AuditLog(auditDb),
      accounts: new AccountIds({
        db: auditDb,
        installId: 'inst-test',
        readOwnerAccount: () => null,
      }),
    });
    try {
      const seen: (string | undefined)[] = [];
      const runner = createMcpBridgedToolRunner(() => {
        const server = new McpServer({ name: 'fake', version: '1.0.0' });
        server.registerTool('who', { description: 'Who' }, async () => {
          const scope = currentAuditActor();
          seen.push(scope?.actor.kind, scope?.sessionId);
          return { content: [{ type: 'text', text: '{}' }] };
        });
        return server;
      });
      // Delivered from inside a person's scope, as a relay frame might be.
      const person = {
        actor: { accountId: 'install:inst-test', kind: 'person' as const, name: 'Owner' },
        surface: 'app' as const,
      };
      await runWithAuditActor(person, () => runner.call({ ...RUN, tool: 'who', input: {} }));
      expect(seen).toEqual(['agent', RUN.sessionId]);
    } finally {
      resetAuditTrail();
    }
  });
});
