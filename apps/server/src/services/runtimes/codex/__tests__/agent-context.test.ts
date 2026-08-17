/**
 * What a Codex agent actually receives per turn: the runtime-neutral DorkOS
 * context block in its prompt, and its identity token in the `codex exec`
 * environment.
 *
 * Before this, `buildSystemPromptAppend` and `resolveAgentTokenEnv` had exactly
 * one caller each (the Claude adapter's `message-sender.ts`), so a Codex agent ran
 * with no identity, no persona, no safety boundaries, and no pointer to its own
 * capabilities. Two consequences worth naming: no activity attribution
 * (`actorType: 'agent'` needs a resolvable token) and no tier ceiling.
 *
 * These tests read the REAL prompt string handed to `runStreamed` and the REAL
 * options handed to the `Codex` constructor, and mint against a real
 * `AgentIdentityService` over a test DB, so a token that does not resolve fails
 * here.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  AGENT_TOKEN_ENV_VAR,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/index.js';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';
import { codexSimpleTurn, makeMockThread } from './codex-scenarios.js';

vi.mock('../check-dependencies.js', () => ({ checkCodexDependencies: vi.fn(() => []) }));
vi.mock('../enumerate-mcp-servers.js', () => ({
  enumerateCodexMcpServers: vi.fn(async () => null),
}));
vi.mock('../scan-skill-commands.js', () => ({ scanSkillCommands: vi.fn(() => []) }));

/** Records every `Codex` construction and every prompt `runStreamed` receives. */
const sdkMocks = vi.hoisted(() => ({
  constructorOptions: [] as (Record<string, unknown> | undefined)[],
  prompts: [] as string[],
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options?: Record<string, unknown>) {
      sdkMocks.constructorOptions.push(options);
    }
    startThread(): unknown {
      return {
        id: 'codex-thread-0001',
        runStreamed: async (prompt: string) => {
          sdkMocks.prompts.push(prompt);
          return { events: makeMockThread(codexSimpleTurn('ok')).runStreamed() };
        },
      };
    }
    resumeThread(): unknown {
      return this.startThread();
    }
  },
}));

/**
 * A mesh registry that reports exactly one agent, rooted at `agentPath`.
 *
 * The default is the pair a real manifest carries and the reason DOR-1264
 * existed: a SLUG that addresses the agent and a DISPLAY NAME that renders it,
 * two different strings. A fake that gave them the same value could not tell
 * which one the runtime minted its token under.
 */
function meshWithAgent(
  agentPath: string,
  agent: { name: string; displayName?: string } = {
    name: 'researcher',
    displayName: 'Researcher',
  }
): AgentRegistryPort {
  return {
    getByPath: (cwd: string) =>
      cwd === agentPath ? { id: '01JAGENT0000000000000000', ...agent } : undefined,
    listWithPaths: () => [],
    updateLastSeen: () => {},
  } as unknown as AgentRegistryPort;
}

/** Drain a sendMessage generator, discarding the events. */
async function drain(gen: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of gen) {
    // The prompt and the constructor options are what these tests read.
  }
}

describe('what a Codex turn carries', () => {
  let agentDir: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    sdkMocks.constructorOptions.length = 0;
    sdkMocks.prompts.length = 0;
    agentDir = await mkdtemp(path.join(tmpdir(), 'codex-agent-context-'));
    await mkdir(path.join(agentDir, '.dork'), { recursive: true });
    await writeFile(
      path.join(agentDir, '.dork', 'agent.json'),
      JSON.stringify({
        id: '01JAGENT0000000000000000',
        name: 'researcher',
        description: 'Reads things carefully.',
        runtime: 'codex',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: '2026-01-01T00:00:00.000Z',
        registeredBy: 'test',
      }),
      'utf-8'
    );
    db = createTestDb();
    initAgentIdentityService(db);
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(agentDir, { recursive: true, force: true });
  });

  /** A runtime whose mesh knows about `agentDir`, unless `mesh: null`. */
  function makeRuntime(opts: { mesh?: AgentRegistryPort | null } = {}): CodexRuntime {
    const runtime = new CodexRuntime({
      threadMap: new CodexThreadMap(db),
      binaryPath: null,
      defaultCwd: agentDir,
    });
    const mesh = opts.mesh === undefined ? meshWithAgent(agentDir) : opts.mesh;
    if (mesh) runtime.setMeshCore(mesh);
    return runtime;
  }

  it('injects the runtime-neutral DorkOS context into the prompt', async () => {
    const runtime = makeRuntime();
    await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

    const prompt = sdkMocks.prompts[0] ?? '';
    // Identity, so the agent knows who it is.
    expect(prompt).toContain('<agent_identity>');
    expect(prompt).toContain('Name: researcher');
    // Orientation, so it knows how to reach its capabilities from a shell.
    expect(prompt).toContain('<dorkos_context>');
    expect(prompt).toContain('dorkos capabilities');
    expect(prompt).toContain('dorkos call');
    // Environment, so it knows where it is running.
    expect(prompt).toContain('<env>');
    expect(prompt).toContain(`Working directory: ${agentDir}`);
  });

  it('keeps the user message last and byte-identical', async () => {
    const runtime = makeRuntime();
    await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

    expect(sdkMocks.prompts[0]?.endsWith('hello')).toBe(true);
  });

  it('puts the DorkOS context before a caller-supplied systemPromptAppend', async () => {
    const runtime = makeRuntime();
    await drain(
      runtime.sendMessage('s1', 'hello', { cwd: agentDir, systemPromptAppend: '<scheduled_run/>' })
    );

    const prompt = sdkMocks.prompts[0] ?? '';
    expect(prompt.indexOf('<dorkos_context>')).toBeLessThan(prompt.indexOf('<scheduled_run/>'));
  });

  it('mints an identity token into the codex exec environment', async () => {
    const runtime = makeRuntime();
    await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

    // The boot client (no env) plus this turn's client (env with the token).
    const env = sdkMocks.constructorOptions.at(-1)?.env as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env?.[AGENT_TOKEN_ENV_VAR]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('resolves that token back to the agent, so activity is attributed to it', async () => {
    const runtime = makeRuntime();
    await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

    const env = sdkMocks.constructorOptions.at(-1)?.env as Record<string, string>;
    const identity = await initAgentIdentityService(db).resolve(env[AGENT_TOKEN_ENV_VAR]!);

    // This is what `createCapabilityAttributionObserver` needs to emit
    // `actorType: 'agent'` with a real actorId, and what `enforceCapabilityTier`
    // reads the ceiling from.
    expect(identity?.agentPath).toBe(agentDir);
    expect(identity?.displayName).toBe('Researcher');
    expect(identity?.tierCeiling).toBe('destructive');
  });

  it('mints under the name a person reads, never the agent addressing slug', async () => {
    const runtime = makeRuntime();
    await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

    const env = sdkMocks.constructorOptions.at(-1)?.env as Record<string, string>;
    const identity = await initAgentIdentityService(db).resolve(env[AGENT_TOKEN_ENV_VAR]!);

    // The token's label is replayed onto this agent's author row every time it
    // uses a room tool (`AuthorRegistry.resolveAgent`), so a token minted under
    // `researcher` renames it in every message it writes and in the member list
    // (DOR-1264).
    expect(identity?.displayName).not.toBe('researcher');
    expect(identity?.displayName).toBe('Researcher');
  });

  it('falls back to the slug for an agent that has no display name of its own', async () => {
    const runtime = makeRuntime({ mesh: meshWithAgent(agentDir, { name: 'researcher' }) });
    await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

    const env = sdkMocks.constructorOptions.at(-1)?.env as Record<string, string>;
    const identity = await initAgentIdentityService(db).resolve(env[AGENT_TOKEN_ENV_VAR]!);

    // Nothing is invented: an agent whose manifest names no display name is
    // honestly called by its slug, which is also the only string there is.
    expect(identity?.displayName).toBe('researcher');
  });

  it('keeps inheriting the parent environment when it adds the token', async () => {
    vi.stubEnv('DORKOS_AGENT_CONTEXT_PROBE', 'inherited');
    try {
      const runtime = makeRuntime();
      await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

      // Setting CodexOptions.env stops the SDK inheriting process.env, so the
      // adapter must spread it back in. Losing PATH/HOME/CODEX_HOME here would
      // break every Codex turn.
      const env = sdkMocks.constructorOptions.at(-1)?.env as Record<string, string>;
      expect(env.DORKOS_AGENT_CONTEXT_PROBE).toBe('inherited');
      expect(env.PATH ?? env.Path).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('runs unattributed, on the shared client, when the cwd hosts no registered agent', async () => {
    const runtime = makeRuntime({ mesh: null });
    await drain(runtime.sendMessage('s1', 'hello', { cwd: agentDir }));

    // Exactly one construction (the boot client), and no env override on it.
    expect(sdkMocks.constructorOptions).toHaveLength(1);
    expect(sdkMocks.constructorOptions[0]).not.toHaveProperty('env');
    // The context block still lands: knowing who you are does not require a token.
    expect(sdkMocks.prompts[0]).toContain('<agent_identity>');
  });
});
