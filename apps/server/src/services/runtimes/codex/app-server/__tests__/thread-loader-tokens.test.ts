/**
 * The identity token a Codex thread load mints (DOR-5264): its process holds
 * it while the thread is loaded, reported through the process token port, so
 * it names the chat until that thread unloads, that process exits or the load
 * fails, and never past another process's end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../../core/agent-identity/agent-identity-service.js';
import { resolveAgentTokenEnv } from '../../../../core/agent-identity/agent-token-env.js';
import { setProcessTokenPort } from '../../../shared/references/process-token-port.js';
import { wireProcessTokenPort } from '../../../../../startup/steps/work-graph.js';
import { FakeAppServerHost } from '../../__tests__/fake-app-server.js';
import { CodexAppServerPool } from '../process-pool.js';
import { CodexThreadLoader, type ThreadLoadInput } from '../thread-loader.js';
import type { CodexTurnTools } from '../../transport/codex-transport.js';

const HOME = '/fake/home';
const NO_TOOLS: CodexTurnTools = {
  filePolicy: {
    roots: {
      cwd: '/project',
      home: HOME,
      data: '/fake/data',
      accounts: [],
      agentFolders: [],
      agentHomes: [],
    },
    writable: [],
  },
  agentTokenEnv: {},
  managed: { servers: {}, env: {} },
  dorkosTools: null,
  connectorTools: null,
};

const pools: CodexAppServerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

async function setup() {
  const host = new FakeAppServerHost();
  const pool = new CodexAppServerPool({ spawn: host.spawn, timing: { shutdownStepMs: 10 } });
  pools.push(pool);
  const loader = new CodexThreadLoader({
    threadKeys: () => undefined,
    realpath: (p) => `/real${p}`,
  });
  const process = await pool.acquire({
    binary: '/opt/codex',
    codexHome: HOME,
    env: { CODEX_HOME: HOME },
  });
  const fake = host.home(HOME).processes[0]!;
  const input = (overrides: Partial<ThreadLoadInput> = {}): ThreadLoadInput => ({
    process,
    home: 'person',
    sessionId: 's1',
    boundThreadId: undefined,
    cwd: '/project',
    settings: { permissionMode: 'default' },
    tools: NO_TOOLS,
    ...overrides,
  });
  return { host, pool, loader, process, fake, input };
}

describe('DOR-5264: the token a load mints names its chat until the thread goes', () => {
  beforeEach(() => wireProcessTokenPort());
  afterEach(() => {
    setProcessTokenPort(undefined);
    resetAgentIdentityService();
  });

  it.each(['the thread unloads', 'its process exits'] as const)(
    'names the chat, then forgets it when %s',
    async (how) => {
      const identities = initAgentIdentityService(createTestDb());
      const { loader, input, process, fake } = await setup();
      const minted: string[] = [];
      const tools: CodexTurnTools = {
        ...NO_TOOLS,
        mintAgentToken: async () => {
          const env = await resolveAgentTokenEnv('/agents/ana', 'Ana');
          minted.push(env.DORKOS_AGENT_TOKEN!);
          return env;
        },
      };
      const loaded = await loader.ensureLoaded(input({ tools }));
      expect((await identities.resolve(minted[0]!))?.chatId).toBe('s1');
      if (how === 'the thread unloads') loader.dropThread(process, loaded.threadId);
      else fake.exit(1);
      await vi.waitFor(async () =>
        expect((await identities.resolve(minted[0]!))?.chatId).toBeUndefined()
      );
    }
  );

  it('a load that failed names no chat with the token it minted', async () => {
    const identities = initAgentIdentityService(createTestDb());
    const { loader, input, host } = await setup();
    const minted: string[] = [];
    const tools: CodexTurnTools = {
      ...NO_TOOLS,
      mintAgentToken: async () => {
        const env = await resolveAgentTokenEnv('/agents/ana', 'Ana');
        minted.push(env.DORKOS_AGENT_TOKEN!);
        return env;
      },
    };
    host.home(HOME).threadStartError = 'refused';
    await expect(loader.ensureLoaded(input({ tools }))).rejects.toBeDefined();
    expect(minted).toHaveLength(1);
    expect((await identities.resolve(minted[0]!))?.chatId).toBeUndefined();
    expect(identities.chats.size).toBe(0);
  });

  it('an old process exiting after a new one loaded the chat forgets only its own token', async () => {
    const identities = initAgentIdentityService(createTestDb());
    const { loader, input, pool, host } = await setup();
    const minted: string[] = [];
    const tools: CodexTurnTools = {
      ...NO_TOOLS,
      mintAgentToken: async () => {
        const env = await resolveAgentTokenEnv('/agents/ana', 'Ana');
        minted.push(env.DORKOS_AGENT_TOKEN!);
        return env;
      },
    };
    await loader.ensureLoaded(input({ tools }));
    // Another home, so the pool keeps the first process running until it exits below.
    const replacement = await pool.acquire({
      binary: '/opt/codex',
      codexHome: `${HOME}-next`,
      env: { CODEX_HOME: `${HOME}-next` },
    });
    await loader.ensureLoaded(input({ process: replacement, tools }));
    expect(minted).toHaveLength(2);

    host.home(HOME).processes[0]!.exit(1);
    await vi.waitFor(async () =>
      expect((await identities.resolve(minted[0]!))?.chatId).toBeUndefined()
    );
    expect((await identities.resolve(minted[1]!))?.chatId).toBe('s1');
  });
});
