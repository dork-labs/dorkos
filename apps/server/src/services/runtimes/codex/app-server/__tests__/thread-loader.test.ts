import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorThreadKeyRegistry } from '../../../../connectors/principal/thread-keys.js';
import { FakeAppServerHost } from '../../__tests__/fake-app-server.js';
import { CodexAppServerPool } from '../process-pool.js';
import {
  CodexThreadLoader,
  THREAD_STARTS_FRESH_NOTICE,
  buildLoadOverrides,
  trustLevelFor,
  type ThreadLoadInput,
} from '../thread-loader.js';
import type { CodexTurnTools } from '../../transport/codex-transport.js';

const HOME = '/fake/home';
const NO_TOOLS: CodexTurnTools = {
  agentTokenEnv: {},
  managed: { servers: {}, env: {} },
  dorkosTools: null,
  connectorTools: null,
};
const TOOLS: CodexTurnTools = {
  agentTokenEnv: { DORKOS_AGENT_TOKEN: 'identity-secret' },
  managed: {
    servers: {
      notion: {
        url: 'https://n.example/mcp',
        env_http_headers: { Authorization: 'DORKOS_MCP_HDR_NOTION_AUTHORIZATION' },
      },
    },
    env: { DORKOS_MCP_HDR_NOTION_AUTHORIZATION: 'Bearer notion-secret' },
  },
  dorkosTools: {
    url: 'http://127.0.0.1:9/agent',
    headers: { Authorization: 'Bearer turn-bearer' },
  },
  connectorTools: {
    url: 'http://127.0.0.1:9/mcp',
    agentToolsUrl: 'http://127.0.0.1:9/agent',
    headers: {},
  },
};

/** The load config, typed as far as these assertions read it. */
interface LoadConfig {
  mcp_servers: Record<string, { url?: string; http_headers?: Record<string, string> }>;
  shell_environment_policy?: unknown;
  projects?: unknown;
}

const pools: CodexAppServerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

async function setup(withKeys = true) {
  const host = new FakeAppServerHost();
  const pool = new CodexAppServerPool({ spawn: host.spawn, timing: { shutdownStepMs: 10 } });
  pools.push(pool);
  const keys = new ConnectorThreadKeyRegistry();
  const loader = new CodexThreadLoader({
    threadKeys: () => (withKeys ? keys : undefined),
    realpath: (path) => `/real${path}`,
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
  return { host, pool, keys, loader, process, fake, input };
}

describe('the load table (§6)', () => {
  it('starts a thread for an unbound session and does not bind it yet', async () => {
    const { loader, fake, input } = await setup();
    const loaded = await loader.ensureLoaded(input());
    expect(loaded).toMatchObject({ needsBinding: true, replaces: undefined, notice: undefined });
    expect(fake.requestsOf('thread/start')).toHaveLength(1);
    // A retry of the same unbound session reuses that thread rather than leaking another.
    const again = await loader.ensureLoaded(input());
    expect(again.threadId).toBe(loaded.threadId);
    expect(fake.requestsOf('thread/start')).toHaveLength(1);
  });

  it('cold-resumes a bound thread with its config, and leaves a loaded match alone', async () => {
    const { host, loader, fake, input, process } = await setup();
    host.home(HOME).threads.set('t-old', { id: 't-old', hasRollout: true });
    const loaded = await loader.ensureLoaded(input({ boundThreadId: 't-old' }));
    expect(loaded).toMatchObject({ threadId: 't-old', needsBinding: false });
    expect(fake.requestsOf('thread/resume')[0]).toMatchObject({
      threadId: 't-old',
      sandbox: 'read-only',
    });
    await loader.ensureLoaded(input({ boundThreadId: 't-old' }));
    expect(fake.requestsOf('thread/resume')).toHaveLength(1);
    expect(process.stale).toBe(false);
  });

  it('uses a loaded thread as is when the turn wants other config, and marks the process stale', async () => {
    const { host, loader, fake, input, process } = await setup();
    host.home(HOME).threads.set('t1', { id: 't1', hasRollout: true });
    await loader.ensureLoaded(input({ boundThreadId: 't1' }));
    const loaded = await loader.ensureLoaded(
      input({ boundThreadId: 't1', settings: { permissionMode: 'acceptEdits' } })
    );
    expect(loaded.threadId).toBe('t1');
    expect(process.stale).toBe(true);
    // Nothing was sent: a resume would have been silently ignored anyway.
    expect(fake.requestsOf('thread/resume')).toHaveLength(1);
    expect(fake.loaded.get('t1')!.loadParams.sandbox).toBe('read-only');
  });

  it('starts fresh and replaces the binding when the bound thread has no rollout', async () => {
    const { host, loader, input } = await setup();
    host.home(HOME).threads.set('t-empty', { id: 't-empty', hasRollout: false });
    const loaded = await loader.ensureLoaded(input({ boundThreadId: 't-empty' }));
    expect(loaded).toMatchObject({ needsBinding: true, replaces: 't-empty', notice: undefined });
    expect(loaded.threadId).not.toBe('t-empty');
  });

  it('starts fresh, says so, and replaces the binding when Codex lost the thread', async () => {
    const { loader, input } = await setup();
    const loaded = await loader.ensureLoaded(input({ boundThreadId: 'deleted-in-codex' }));
    expect(loaded).toMatchObject({
      needsBinding: true,
      replaces: 'deleted-in-codex',
      notice: { type: 'system_status', data: { message: THREAD_STARTS_FRESH_NOTICE } },
    });
  });
});

describe('load config (§9)', () => {
  it('carries tools, identity and trust over the wire, authenticated by a thread key', async () => {
    const { loader, fake, input, keys } = await setup();
    const loaded = await loader.ensureLoaded(
      input({ tools: TOOLS, settings: { permissionMode: 'acceptEdits', model: 'gpt-x' } })
    );
    const params = fake.requestsOf('thread/start')[0]!;
    expect(params).toMatchObject({
      cwd: '/project',
      model: 'gpt-x',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });
    const config = params.config as LoadConfig;
    const authorization = config.mcp_servers.dorkos!.http_headers!.Authorization!;
    expect(authorization).toMatch(/^Bearer dtk_/);
    expect(config.mcp_servers.dorkos_connections!.http_headers!.Authorization).toBe(authorization);
    expect(config.mcp_servers.dorkos_connections!.url).toBe('http://127.0.0.1:9/mcp');
    // The turn bearer is never fixed into config.
    expect(JSON.stringify(config)).not.toContain('turn-bearer');
    expect(config.mcp_servers.notion).toEqual({
      url: 'https://n.example/mcp',
      http_headers: { Authorization: 'Bearer notion-secret' },
    });
    expect(config.shell_environment_policy).toEqual({
      set: { DORKOS_AGENT_TOKEN: 'identity-secret' },
    });
    expect(config.projects).toEqual({ '/real/project': { trust_level: 'trusted' } });
    // The key resolves to this session, and nothing is attached yet.
    const key = keys.lookup(authorization.slice('Bearer '.length));
    expect(key).toMatchObject({
      keyId: loaded.keyId,
      bindingId: undefined,
      scope: { canonicalSessionId: 's1', canonicalCwd: '/project' },
    });
  });

  it('mints no key, and injects no listener-backed server, when thread keys are not wired', async () => {
    const { loader, fake, input } = await setup(false);
    const loaded = await loader.ensureLoaded(input({ tools: TOOLS }));
    expect(loaded.keyId).toBeUndefined();
    const config = fake.requestsOf('thread/start')[0]!.config as LoadConfig;
    expect(Object.keys(config.mcp_servers)).toEqual(['notion']);
  });

  it('keeps the person’s own recorded trust verdict', async () => {
    const { host, loader, fake, input } = await setup();
    host.home(HOME).projects['/real/project'] = { trust_level: 'untrusted' };
    await loader.ensureLoaded(input({ settings: { permissionMode: 'bypassPermissions' } }));
    expect(
      (fake.requestsOf('thread/start')[0]!.config as Record<string, unknown>).projects
    ).toEqual({
      '/real/project': { trust_level: 'untrusted' },
    });
  });

  it('applies the trust rule: credits never trust; the person’s home trusts writable modes only', () => {
    expect(trustLevelFor('credits', 'danger-full-access', 'trusted')).toBe('untrusted');
    expect(trustLevelFor('person', 'read-only', undefined)).toBeUndefined();
    expect(trustLevelFor('person', 'workspace-write', undefined)).toBe('trusted');
    expect(trustLevelFor('person', 'workspace-write', 'untrusted')).toBe('untrusted');
  });

  it('points a credits thread at the relay with its key, and turns web search off', () => {
    const overrides = buildLoadOverrides(
      {
        cwd: '/p',
        settings: { permissionMode: 'default' },
        tools: NO_TOOLS,
        creditsRelay: { baseUrl: 'http://127.0.0.1:5/v1', key: 'relay-key' },
      },
      { threadKey: undefined, trust: 'untrusted', realCwd: '/p' }
    );
    expect(overrides.config).toMatchObject({
      model_provider: 'dorkos-credits',
      model_providers: {
        'dorkos-credits': {
          base_url: 'http://127.0.0.1:5/v1',
          experimental_bearer_token: 'relay-key',
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
      web_search: 'disabled',
      projects: { '/p': { trust_level: 'untrusted' } },
    });
  });
});

describe('thread key lifecycle', () => {
  it('revokes every key of a process when it exits', async () => {
    const { loader, fake, input, keys } = await setup();
    await loader.ensureLoaded(input({ tools: TOOLS }));
    expect(keys.size).toBe(1);
    fake.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(keys.size).toBe(0);
  });

  it('revokes a key minted for a load that failed, and on drop', async () => {
    const { loader, fake, input, keys, process } = await setup();
    fake.overloadNext = 10;
    await expect(loader.ensureLoaded(input({ tools: TOOLS }))).rejects.toThrow();
    expect(keys.size).toBe(0);
    fake.overloadNext = 0;
    const loaded = await loader.ensureLoaded(input({ tools: TOOLS }));
    expect(keys.size).toBe(1);
    loader.dropThread(process, loaded.threadId);
    expect(keys.size).toBe(0);
    expect(loader.holdsSession('s1')).toBe(false);
  });
});
