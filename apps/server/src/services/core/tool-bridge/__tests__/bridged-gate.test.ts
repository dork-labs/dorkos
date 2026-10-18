/**
 * A bridged call against the REAL gate (DOR-2939 part 6): the live runner, the
 * hub's real external MCP server, the real tier and permission gate. What the
 * bridge promises about the card is read off what the handler did, never off
 * the shape of an answer.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../../../env.js', () => ({ env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined } }));
vi.mock('../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/manifest')>()),
  readManifest: vi.fn().mockResolvedValue(null),
}));

import { createExternalMcpServer } from '../../mcp-server.js';
import { mcpCallerIdentity, type McpCaller } from '../../../../routes/mcp.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../capabilities/tier-enforcement.js';
import { resetPermissionGate } from '../../capabilities/permission-enforcement.js';
import { askFor } from '../../capabilities/__tests__/permission-gate-fixtures.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import { lastTurnLevelOf, recordTurnLevels } from '../../turn-power/turn-levels.js';
import { resolveCallPermission } from '../../capabilities/permission-enforcement.js';
import { gatedActionForMcpTool } from '../../mcp-tool-tiers.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { createMcpBridgedToolRunner } from '../mcp-tool-runner.js';
import type { BridgedToolRun } from '../bridged-tool-call.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridged-gate-'));
const HOME = path.join(ROOT, 'scout');
fs.mkdirSync(HOME, { recursive: true });
registerTestHomes([HOME]);
afterAll(() => {
  clearTestHomes();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

let deleted: string[];
let created: unknown[];

function createDeps(): McpToolDeps {
  return {
    transcriptReader: { listSessions: vi.fn().mockResolvedValue([]) },
    defaultCwd: ROOT,
    taskStore: {
      getTask: () => undefined,
      deleteTask: (id: string) => {
        deleted.push(id);
        return true;
      },
      createTask: (input: unknown) => {
        created.push(input);
        return { id: 't-new', ...(input as object) };
      },
    },
    meshCore: { get: () => undefined },
    bindingStore: {},
    bindingRouter: {},
    adapterManager: {},
    traceStore: {},
    extensionManager: {},
  } as unknown as McpToolDeps;
}

/** The hub's factory, as `/mcp` builds it: the identity marked by the caller kind. */
const factory = (caller: McpCaller) =>
  createExternalMcpServer(createDeps(), undefined, undefined, mcpCallerIdentity(caller));

const run = (over: Partial<BridgedToolRun['identity']> = {}): BridgedToolRun => ({
  caller: 'agent-computer',
  identity: { agentPath: HOME, displayName: 'Scout', createdAt: new Date().toISOString(), ...over },
  sessionId: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c',
  computerId: 'cc-1',
});

beforeEach(() => {
  deleted = [];
  created = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
  // Trusted, with nothing changed: a destructive tool in an Allowed area runs.
  askFor();
});

afterEach(() => {
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
});

describe('a destructive tool from an agent computer', () => {
  it('asks a person on a Trusted install, where the same agent on /mcp runs it', async () => {
    // The control: the agent on its own /mcp, no bridge, deletes without a card.
    const direct = createExternalMcpServer(createDeps(), undefined, undefined, run().identity);
    const directRunner = createMcpBridgedToolRunner(() => direct);
    // Built by hand without the caller kind, to show the kind is what asks.
    const plain = await directRunner.call({ ...run(), tool: 'tasks_delete', input: { id: 't1' } });
    expect(plain).toMatchObject({ ok: true });
    expect(deleted).toEqual(['t1']);

    deleted = [];
    const bridged = await createMcpBridgedToolRunner(factory).call({
      ...run(),
      tool: 'tasks_delete',
      input: { id: 't2' },
    });
    expect(bridged).toMatchObject({ ok: true, output: { status: 'approval_required' } });
    expect(deleted).toEqual([]);
  });
});

describe('a revoked agent', () => {
  it('is refused as /mcp refuses it', async () => {
    const result = await createMcpBridgedToolRunner(factory).call({
      ...run({ inactive: 'revoked' }),
      tool: 'tasks_create',
      input: { name: 'n', prompt: 'p', cron: '0 * * * *', target: 'global', reason: 'r' },
    });
    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expect(created).toEqual([]);
  });
});

describe('the outsider cap', () => {
  it('asks before a capped act call that changes permissions', async () => {
    const action = { ...gatedActionForMcpTool('tasks_create'), area: 'permissions' as const };
    const uncapped = await resolveCallPermission({ action, identity: run().identity });
    expect(uncapped?.state).toBe('allowed');
    const capped = await resolveCallPermission({
      action,
      identity: run({ outsiderCapped: true }).identity,
    });
    expect(capped?.state).toBe('ask');
  });

  it('cannot be lifted by a session record that says the turn read nothing', async () => {
    const sessionId = 'calm-session';
    const runtime = {
      getCapabilities: () => ({
        permissionModes: {
          default: 'default',
          values: [{ id: 'default', asks: 'risky', reach: 'write' }],
        },
      }),
      sendMessage: async function* () {},
    } as unknown as AgentRuntime;
    // The hub's record of a turn on that session that read no outsider's words.
    const wrapped = recordTurnLevels(runtime, () => 'default');
    for await (const _ of wrapped.sendMessage(sessionId, 'hi')) {
      // no events
    }
    expect(lastTurnLevelOf(sessionId)?.outsider).toBeUndefined();
    const action = { ...gatedActionForMcpTool('tasks_create'), area: 'permissions' as const };
    const capped = await resolveCallPermission({
      action,
      sessionId,
      identity: run({ outsiderCapped: true }).identity,
    });
    expect(capped?.state).toBe('ask');
  });
});
