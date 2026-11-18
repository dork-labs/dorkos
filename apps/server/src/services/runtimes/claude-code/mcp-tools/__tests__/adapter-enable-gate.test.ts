/**
 * Security S7 on DOR-4355 M3: an agent's `relay_enable_adapter` on a chat
 * connection that is off waits for a person's card, at every level. A turn that
 * read words from outside the team, or a caller DorkOS cannot name, gets no
 * card and is refused by the tool. One that is on already answers at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';
import { ApprovalService } from '../../../../core/approvals/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../../core/capabilities/permission-enforcement.js';
import {
  gateHandRegisteredMcpTools,
  gatedToolRegistrar,
  type SdkMcpTool,
} from '../../../../core/mcp-tool-gate.js';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { noteRoomTurnWords } from '../../../../core/turn-power/outside-words.js';
import type { AgentIdentity } from '../../../../core/agent-identity/index.js';
import type { AdapterManager } from '../../../../relay/adapter-manager.js';
import type { McpToolDeps } from '../types.js';
import {
  createRelayEnableAdapterHandler,
  registerAdapterEnableEscalator,
} from '../adapter-tools.js';

const AGENT: AgentIdentity = {
  agentPath: '/made-up/agents/porter',
  displayName: 'Porter',
  createdAt: '2026-11-01T00:00:00.000Z',
};

let config: PermissionConfigInput;
let approvals: ApprovalService;
let unregister: () => void;
let enabled: boolean;
const manager = {
  getAdapter: vi.fn((id: string) =>
    id === 'tg' ? { config: { id, type: 'telegram', enabled } } : undefined
  ),
  resolveAdapterName: vi.fn(() => 'Northwind Telegram'),
  enable: vi.fn(async () => undefined),
};

/** The real tool: the gate in front, the handler behind. */
const enableTool: SdkMcpTool = {
  name: 'relay_enable_adapter',
  description: 'probe',
  inputSchema: {},
  handler: createRelayEnableAdapterHandler({
    adapterManager: manager as unknown as AdapterManager,
  } as McpToolDeps) as unknown as SdkMcpTool['handler'],
};

/** The tool on the in-session server, as the agent's own chat. */
function inSession(sessionId = 'ses-a') {
  const [tool] = gateHandRegisteredMcpTools(
    [enableTool],
    async () => ({ identity: AGENT }),
    undefined,
    () => ({ sessionId })
  );
  return (args: Record<string, unknown>) => tool!.handler(args, {}) as Promise<CallToolResult>;
}

/** The tool on the external `/mcp` server, with no agent header. */
function externalUnnamed() {
  let callback: ((args: unknown, extra: unknown) => Promise<CallToolResult>) | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, cb: typeof callback) => {
      callback = cb;
    },
  } as unknown as McpServer;
  gatedToolRegistrar(server, undefined).registerTool(
    'relay_enable_adapter',
    { description: 'probe', inputSchema: {} },
    ((args: Record<string, unknown>) => enableTool.handler(args, {})) as never
  );
  return (args: Record<string, unknown>) => callback!(args, {});
}

function payloadOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

beforeEach(() => {
  enabled = false;
  manager.enable.mockClear();
  config = { preset: 'trusted', defaults: { areas: {}, actions: {} } };
  approvals = new ApprovalService(createTestDb());
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals });
  initPermissionGate({ readConfig: () => config });
  unregister = registerAdapterEnableEscalator(manager as unknown as AdapterManager);
});

afterEach(() => {
  unregister();
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
});

describe('an agent turning a chat connection back on', () => {
  it('raises a card naming the connection, and the yes turns on this exact one', async () => {
    const call = inSession();
    const first = payloadOf(await call({ id: 'tg' }));
    expect(first).toMatchObject({ status: 'approval_required' });
    expect(JSON.stringify(approvals.listPending())).toContain('Northwind Telegram');
    expect(manager.enable).not.toHaveBeenCalled();

    approvals.grant(first.approvalId as string);
    const done = payloadOf(await call({ id: 'tg', approvalToken: first.approvalToken }));
    expect(done).toMatchObject({ ok: true, action: 'enabled' });
    expect(manager.enable).toHaveBeenCalledExactlyOnceWith('tg');
  });

  it('raises the card even when connections are Allowed', async () => {
    config.defaults.areas.connections = 'allowed';
    const first = payloadOf(await inSession()({ id: 'tg' }));
    expect(first).toMatchObject({ status: 'approval_required' });
    expect(manager.enable).not.toHaveBeenCalled();
  });

  it('refuses a turn that read outside words, with no card', async () => {
    // This chat's turn answered someone outside the team in a room.
    noteRoomTurnWords('ses-marked', true);
    try {
      const result = await inSession('ses-marked')({ id: 'tg' });
      expect(result.isError).toBe(true);
      expect(payloadOf(result).code).toBe('ENABLE_NEEDS_YES');
      expect(approvals.listPending()).toEqual([]);
      expect(manager.enable).not.toHaveBeenCalled();
    } finally {
      noteRoomTurnWords('ses-marked', false);
    }
  });

  it('refuses a caller it cannot name, with no card', async () => {
    const result = await externalUnnamed()({ id: 'tg' });
    expect(payloadOf(result).code).toBe('ENABLE_NEEDS_YES');
    expect(approvals.listPending()).toEqual([]);
    expect(manager.enable).not.toHaveBeenCalled();
  });

  it('answers at once for a connection that is already on', async () => {
    enabled = true;
    const done = payloadOf(await inSession()({ id: 'tg' }));
    expect(done).toMatchObject({ ok: true });
    expect(approvals.listPending()).toEqual([]);
  });
});
