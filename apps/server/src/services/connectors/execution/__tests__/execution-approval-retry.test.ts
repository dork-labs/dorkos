/** Real MCP schemas, registry and approval service; only domain preflight and dispatch stand in. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../../core/approvals/index.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
} from '../../../core/capabilities/index.js';
import { registerClaudeConnectorCapabilityTools } from '../../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js';
import { CAPABILITY_APPROVAL_HOLD_CAP_MS } from '../../../core/capabilities/capability-approval-hold.js';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { createCapabilityAuthorityBinding } from '../../principal/capability-authority-binding.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';
import { createConnectorRuntimeMcpServer } from '../runtime-mcp-server.js';
import type { ConnectorExecutionAuthorizationService } from '../authorization-service.js';

const TARGET = {
  connectionId: 'connection-garden',
  operationRevisionId: 'revision-note',
  arguments: { text: 'Garden meeting' },
};
const PRINCIPAL = createServerPrincipal({
  kind: 'runtime',
  owner: { kind: 'local_install', installationId: 'install-a' },
  bindingId: 'binding-a',
  runtime: 'codex',
  canonicalSessionId: 'session-a',
  agentId: 'agent-wren',
  agentPath: '/agents/wren',
  canonicalCwd: '/agents/wren',
});

function payload(result: unknown): Record<string, unknown> {
  if (
    !result ||
    typeof result !== 'object' ||
    !('content' in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error('Expected an MCP result with content');
  }
  const block = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected MCP text content');
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('connected-app approval retries over MCP', () => {
  const execute = vi.fn(async () => ({
    logicalOperationId: 'logical-a',
    attemptCount: 1,
    result: { status: 'success' as const, data: {} },
  }));
  let approvals: ApprovalService;
  let registry: ReturnType<typeof composeRegistry>;
  let client: Client;
  let server: ReturnType<typeof createConnectorRuntimeMcpServer>;
  let request: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    execute.mockClear();
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    });
    noteRoomTurnWords('session-a', true);
    approvals = new ApprovalService(createTestDb());
    request = vi.spyOn(approvals, 'request');
    initCapabilityTierGate({ approvals });
    registry = composeRegistry([connectorExecutionDomain], {
      logger: noopLogger,
      connectorExecutionDeps: {
        authorization: {
          preflight: vi.fn(
            async ({
              capabilityId,
              target,
            }: Parameters<ConnectorExecutionAuthorizationService['preflight']>[0]) => ({
              authorityBinding: createCapabilityAuthorityBinding({
                digest: JSON.stringify(target),
                ownerKind: 'local_install',
                ownerId: 'install-a',
                agentId: 'agent-wren',
                sessionId: 'session-a',
                connectionId: TARGET.connectionId,
                operationRevisionId: TARGET.operationRevisionId,
              }),
              ...(capabilityId === 'connectors.execute_read'
                ? {
                    spend: {
                      kind: 'ask',
                      reason: 'no-limit',
                      card: {
                        priceMicro: null,
                        priceSource: null,
                        limitMicro: null,
                        leftMicro: null,
                        currency: 'USD',
                      },
                    },
                  }
                : {}),
            })
          ),
        } as never,
        broker: { execute } as never,
        access: {} as never,
      },
    });
    server = createConnectorRuntimeMcpServer(registry, PRINCIPAL);
    client = new Client({ name: 'approval-retry-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([client.close(), server.close()]);
    resetCapabilityTierGate();
    resetPermissionGate();
    resetLiveOutsiderTurns();
    vi.restoreAllMocks();
  });

  function call(name = 'connectors.execute_write', approvalToken?: unknown, target = TARGET) {
    return client.callTool(
      {
        name,
        arguments: { ...target, ...(approvalToken === undefined ? {} : { approvalToken }) },
      },
      undefined,
      { timeout: CAPABILITY_APPROVAL_HOLD_CAP_MS + 60_000 }
    );
  }

  it.each(['read', 'write', 'destructive'] as const)(
    'honors one late yes for %s through the authenticated runtime tool, then refuses replay',
    async (classification) => {
      const name = `connectors.execute_${classification}`;
      // A paid read asks in a clean turn; marked turns refuse spend outright.
      if (classification === 'read') resetLiveOutsiderTurns();
      const asked = payload(await call(name));
      expect(asked).toMatchObject({
        status: 'approval_required',
        retry: { channel: 'mcp-argument', field: 'approvalToken' },
      });
      expect(execute).not.toHaveBeenCalled();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + CAPABILITY_APPROVAL_HOLD_CAP_MS + 1);
      approvals.grant(asked.approvalId as string, 'owner');
      const result = await call(name, asked.approvalToken);
      expect(payload(result)).toMatchObject({ result: { status: 'success' } });
      expect(request).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          target: TARGET,
          approval: expect.objectContaining({ approvalId: asked.approvalId }),
        })
      );
      expect(payload(await call(name, asked.approvalToken))).toMatchObject({
        status: 'approval_required',
        reason: 'already_used',
      });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  );

  it('resumes a marked write after the real ten-minute in-session hold times out', async () => {
    await Promise.all([client.close(), server.close()]);
    const session = { eventQueue: [], eventQueueNotify: vi.fn() };
    server = new McpServer({ name: 'claude-approval-test', version: '1.0.0' });
    registerClaudeConnectorCapabilityTools(
      server,
      registry,
      async () => ({ serverPrincipal: PRINCIPAL, sessionId: 'session-a' }),
      { approvals, session }
    );
    client = new Client({ name: 'claude-approval-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    vi.useFakeTimers();
    const resultP = call();
    await vi.waitFor(() => expect(session.eventQueue).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(CAPABILITY_APPROVAL_HOLD_CAP_MS);
    const asked = payload(await resultP);
    expect(asked.status).toBe('approval_required');
    expect(execute).not.toHaveBeenCalled();
    approvals.grant(asked.approvalId as string, 'owner');
    const result = await call('connectors.execute_write', asked.approvalToken);
    expect(payload(result)).toMatchObject({ result: { status: 'success' } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired token before dispatch', async () => {
    const asked = payload(await call());
    approvals.grant(asked.approvalId as string, 'owner');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(asked.expiresAt as string).getTime() + 1);
    expect(payload(await call('connectors.execute_write', asked.approvalToken))).toMatchObject({
      status: 'approval_required',
      reason: 'expired',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a token for changed arguments before dispatch', async () => {
    const asked = payload(await call());
    approvals.grant(asked.approvalId as string, 'owner');
    expect(
      payload(
        await call('connectors.execute_write', asked.approvalToken, {
          ...TARGET,
          arguments: { text: 'Different note' },
        })
      )
    ).toMatchObject({ status: 'approval_required' });
    expect(execute).not.toHaveBeenCalled();
  });
});
