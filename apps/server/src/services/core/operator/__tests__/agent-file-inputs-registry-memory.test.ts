/** Registry/MCP parser regression for DOR-3470. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import { readConventionFile, writeConventionFile } from '@dorkos/shared/convention-files-io';
import { CONVENTION_FILES } from '@dorkos/shared/convention-files';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { initBoundary } from '../../../../lib/boundary.js';
import { operatorDomain } from '../operator-capabilities.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { invokeCapabilityAsMcpResult } from '../../capabilities/mcp-projection.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../capabilities/permission-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { choseFullAutonomy, resetChosenTurns } from '../../turn-power/full-autonomy.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';

const SEED = {
  id: '01M054RMQAMZPXHWHRKPGY9Z87',
  name: 'warden',
  displayName: 'Warden',
  description: 'Checks changes.',
  runtime: 'claude-code',
  capabilities: ['review'],
  behavior: { responseMode: 'always' },
  conventions: { soul: true, memory: true, dorkosKnowledge: true },
  registeredAt: '2026-08-16T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  mcpServers: [],
} as unknown as AgentManifest;

let agentPath: string;
let sessionId: string;
let registry: CapabilityRegistry;
let db: ReturnType<typeof createTestDb>;

async function invoke(patch: Record<string, unknown>, identified = true) {
  const result = await invokeCapabilityAsMcpResult(
    registry,
    'operator.update_agent',
    { cwd: agentPath, ...patch },
    identified
      ? { sessionId, identity: { agentPath, displayName: 'Warden', createdAt: SEED.registeredAt } }
      : undefined
  );
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('Expected MCP text payload');
  return { isError: result.isError === true, payload: JSON.parse(block.text) };
}

/** Compare every file this mixed patch can affect, using real on-disk bytes. */
async function snapshot() {
  return {
    manifest: await readFile(join(agentPath, '.dork', 'agent.json'), 'utf8'),
    memory: await readConventionFile(agentPath, CONVENTION_FILES.memory),
    soul: await readConventionFile(agentPath, CONVENTION_FILES.soul),
    heartbeat: await readConventionFile(agentPath, CONVENTION_FILES.heartbeat),
  };
}

beforeEach(async () => {
  agentPath = await realpath(await mkdtemp(join(tmpdir(), 'memory-registry-refusal-')));
  sessionId = `memory-refusal:${agentPath}`;
  vi.stubEnv('DORK_HOME', join(agentPath, 'owned-dork-home'));
  await mkdir(join(agentPath, '.dork'), { recursive: true });
  await writeManifest(agentPath, SEED);
  await writeConventionFile(agentPath, CONVENTION_FILES.memory, 'Person-set memory stays.');
  await writeConventionFile(agentPath, CONVENTION_FILES.soul, 'Original agent prose.');
  await writeConventionFile(agentPath, CONVENTION_FILES.heartbeat, 'Original beat.');
  await initBoundary(agentPath);
  db = createTestDb();
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(db) });
  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
  // Same Full-level recorder seam used by marked-full-keeper.test.ts. No SDK or network.
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'record fixture level')) {
    // Drain only the local test recorder; this invokes no external runtime.
  }
  expect(choseFullAutonomy(sessionId)).toBe(true);
  registry = composeRegistry([operatorDomain], {
    logger: noopLogger,
    // Established agent-boundaries-gate fixture: cwd resolves the real temp agent;
    // no mesh selector is used and no file operation is mocked.
    operatorDeps: {} as McpToolDeps,
  });
});

afterEach(async () => {
  resetCapabilityTierGate();
  resetPermissionGate();
  resetChosenTurns();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db?.$client.close();
  if (agentPath) await rm(agentPath, { recursive: true, force: true });
});

describe('update_agent keeps person-set memory visible to the refusal guard', () => {
  it.each(['replacement memory', null, 42, { text: 'not a writable memory payload' }])(
    'refuses memoryContent=%j at Full without applying any sibling field',
    async (memoryContent) => {
      const before = await snapshot();
      const result = await invoke({
        memoryContent,
        displayName: 'Must not be applied',
        soulContent: 'Must not be written either.',
        heartbeatContent: 'Nor this beat.',
      });
      expect(result.isError).toBe(true);
      expect(result.payload).toMatchObject({ code: 'OPERATOR_ONLY' });
      expect(result.payload.fields).toContain('memoryContent');
      expect(typeof result.payload.error).toBe('string');
      expect(result.payload.error.length).toBeGreaterThan(0);
      expect(await snapshot()).toEqual(before);
      expect((await readManifest(agentPath))?.displayName).toBe('Warden');
    }
  );

  it('refuses memoryContent for an identityless tool caller without applying sibling writes', async () => {
    const before = await snapshot();
    const result = await invoke(
      {
        memoryContent: 'Identityless tools must not write person-set memory.',
        displayName: 'Must not be applied',
        soulContent: 'Must not be written either.',
      },
      false
    );
    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({
      code: 'OPERATOR_ONLY',
      fields: ['memoryContent'],
      error: 'memoryContent cannot be changed with this tool.',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('still applies an allowed SOUL update through the same real registry and files', async () => {
    const memoryBefore = await readConventionFile(agentPath, CONVENTION_FILES.memory);
    const result = await invoke({ soulContent: 'Helpful agent prose.', displayName: 'Warden Two' });
    expect(result.isError).toBe(false);
    expect((await readManifest(agentPath))?.displayName).toBe('Warden Two');
    expect(await readConventionFile(agentPath, CONVENTION_FILES.soul)).toContain(
      'Helpful agent prose.'
    );
    expect(await readConventionFile(agentPath, CONVENTION_FILES.memory)).toBe(memoryBefore);
  });
});
