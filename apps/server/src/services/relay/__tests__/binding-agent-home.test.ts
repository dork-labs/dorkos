/**
 * Which agent a chat a binding creates records, for each place the session-cwd
 * chain can put that agent (DOR-5055). The router hands `createSession` the
 * folder the chain chose (the agent's home, its managed checkout, or the
 * default folder) and the agent's home as Mesh lists it. The chat records that
 * agent, reads its manifest from that home, runs where it was placed, and its
 * turns are that agent's.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRuntimeLike } from '@dorkos/relay';
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { resolveLevelAgent } from '../../core/turn-power/agent-level-bound.js';
import { createTurnDeskCheck } from '../../core/agent-identity/turn-desk-check.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { BindingSubsystem } from '../binding-subsystem.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';

let scratch: string;
let agent: string;
let checkout: string;
let fallback: string;
let db: Db;
let runtime: FakeAgentRuntime;

beforeAll(() => {
  runtime = new FakeAgentRuntime('claude-code');
  runtimeRegistry.register(runtime as never);
});

beforeEach(async () => {
  scratch = realpathSync(await mkdtemp(path.join(tmpdir(), 'binding-agent-home-')));
  agent = path.join(scratch, 'agents', 'ana');
  checkout = path.join(scratch, 'workspaces', 'ana-checkout');
  fallback = path.join(scratch, 'default');
  for (const dir of [path.join(agent, '.dork'), checkout, fallback]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    path.join(agent, '.dork', 'agent.json'),
    JSON.stringify({
      id: 'ana',
      name: 'Ana',
      runtime: 'claude-code',
      model: 'claude-haiku-4-5',
      registeredAt: '2026-11-22T10:00:00.000Z',
      registeredBy: 'test',
    })
  );
  registerTestHomes([agent], { managed: { [checkout]: agent } });
  db = createTestDb();
  runtimeRegistry.setDb(db);
  runtime.ensureSession.mockClear();
});

afterEach(async () => {
  clearTestHomes();
  await rm(scratch, { recursive: true, force: true });
});

/** Create a chat through the seam the router uses: working in `cwd`, for the agent at its home. */
async function createChatIn(cwd: string): Promise<string> {
  const subsystem = await BindingSubsystem.init({
    relayCore: {
      publish: vi.fn(async () => ({ messageId: 'm', deliveredTo: 0 })),
      subscribe: vi.fn(() => () => {}),
    } as never,
    meshCore: { getProjectPath: vi.fn(() => agent) } as unknown as AdapterMeshCoreLike,
    agentRuntimes: new Map([['claude-code', runtime as unknown as AgentRuntimeLike]]),
    configPath: path.join(scratch, 'adapters.json'),
  });
  const router = subsystem.getBindingRouter() as unknown as {
    deps: {
      agentManager: {
        createSession(cwd: string, mode: string, agentPath: string): Promise<{ id: string }>;
      };
    };
  };
  return (await router.deps.agentManager.createSession(cwd, 'default', agent)).id;
}

describe('a chat a binding creates', () => {
  it.each([
    ['its home', () => agent, 'agent-home', undefined],
    ['its managed checkout', () => checkout, 'agent-managed', undefined],
    ['the default folder', () => fallback, 'default', undefined],
    ['the default folder, its home refused', () => fallback, 'default', 'boundary'],
  ])(
    'is the binding’s agent’s when the agent stands in %s',
    async (_label, folder, rung, degraded) => {
      const cwd = folder();
      const id = await createChatIn(cwd);
      const row = db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();

      expect(row?.agentPath).toBe(agent);
      expect(runtime.ensureSession).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ cwd, permissionMode: 'default', model: 'claude-haiku-4-5' })
      );
      expect(row?.permissionMode ?? null).toBeNull();
      const desk = createTurnDeskCheck({
        sessionAgentPath: async () => row?.agentPath ?? null,
        placementOf: async () => ({ cwd, rung, ...(degraded ? { degraded } : {}) }),
      });
      await expect(
        desk({ cwd, agentDirectory: undefined, forAgent: agent, sessionKey: id })
      ).resolves.toBeNull();
      for (const named of [undefined, { forAgent: agent }]) {
        expect(resolveLevelAgent(cwd, named as never, row?.agentPath)).toEqual({
          agentPath: agent,
          exact: true,
        });
      }
    }
  );
});
