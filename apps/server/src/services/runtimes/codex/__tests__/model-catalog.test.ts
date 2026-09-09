import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '@dorkos/shared/types';
import {
  CodexModelCatalog,
  mapAppServerModel,
  queryCodexModels,
  resolveCodexAuthContext,
} from '../model-catalog.js';

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'runtimes' ? { environment: { inherit: { codex: [] } } } : undefined,
  },
}));

const ASTRA = {
  id: 'gpt-6-astra',
  model: 'gpt-6-astra',
  displayName: 'GPT-6-Astra',
  description: 'Our most capable model for complex, demanding work.',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses' },
    { reasoningEffort: 'medium', description: 'Balanced' },
    { reasoningEffort: 'max', description: 'Maximum' },
    { reasoningEffort: 'ultra', description: 'Automatic delegation' },
  ],
  inputModalities: ['text', 'image'],
  additionalSpeedTiers: ['fast'],
  serviceTiers: [],
};

const SOL = {
  ...ASTRA,
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  description: 'Reliable agentic workhorse for everyday tasks.',
  isDefault: false,
};

function option(value: string): ModelOption {
  return { value, displayName: value, description: '' };
}

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function installProtocolResponder(
  child: FakeAppServer,
  options: { userAgent?: string; singlePageModels?: Array<typeof ASTRA> } = {}
): unknown[] {
  const requests: unknown[] = [];
  let buffered = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; method: string; params?: unknown };
      requests.push(message);
      if (message.method === 'initialize') {
        child.stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: { userAgent: options.userAgent ?? 'test' },
          })}\n`
        );
      } else if (message.method === 'model/list') {
        const cursor = (message.params as { cursor?: string }).cursor;
        const result = options.singlePageModels
          ? { data: options.singlePageModels, nextCursor: null }
          : cursor
            ? { data: [SOL], nextCursor: null }
            : { data: [ASTRA], nextCursor: 'page-2' };
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    }
  });
  return requests;
}

describe('queryCodexModels', () => {
  it('spawns with the filtered auth-probe environment instead of ambient server secrets', async () => {
    for (const name of Object.keys(process.env)) vi.stubEnv(name, undefined);
    vi.stubEnv('HOME', '/synthetic/home');
    vi.stubEnv('PATH', '/synthetic/bin');
    vi.stubEnv('CODEX_API_KEY', 'codex-account-secret');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'server-only-secret');
    vi.stubEnv('MCP_API_KEY', 'external-mcp-secret');
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'agent-identity-secret');
    vi.stubEnv('DORKOS_CONNECTOR_MCP_AUTHORIZATION', 'turn-principal-secret');
    vi.stubEnv('DORKOS_CONNECTOR_MCP_RUNTIME', 'codex');
    vi.stubEnv('DORKOS_CONNECTOR_MCP_CWD', 'runtime-directory');
    try {
      const child = new FakeAppServer();
      installProtocolResponder(child, { singlePageModels: [ASTRA] });
      const spawn = vi.fn((_binary: string, _args: string[], _env: NodeJS.ProcessEnv) => child);

      await queryCodexModels('/opt/codex', { spawn: spawn as never, timeoutMs: 1_000 });

      expect(spawn).toHaveBeenCalledWith('/opt/codex', ['app-server', '--stdio'], {
        CODEX_API_KEY: 'codex-account-secret',
        HOME: '/synthetic/home',
        PATH: '/synthetic/bin',
      });
      expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('NANGO_ENCRYPTION_KEY');
      expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('MCP_API_KEY');
      expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('DORKOS_AGENT_TOKEN');
      expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('DORKOS_CONNECTOR_MCP_AUTHORIZATION');
      expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('DORKOS_CONNECTOR_MCP_RUNTIME');
      expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('DORKOS_CONNECTOR_MCP_CWD');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('initializes app-server, follows model/list pagination, and closes the child', async () => {
    const child = new FakeAppServer();
    const requests = installProtocolResponder(child);

    const models = await queryCodexModels('/opt/codex', {
      spawn: vi.fn(() => child as never),
      timeoutMs: 1_000,
    });

    expect(requests).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'dorkos', version: '0.0.0' } },
      },
      { method: 'initialized' },
      {
        id: 2,
        method: 'model/list',
        params: { cursor: null, includeHidden: false, limit: 100 },
      },
      {
        id: 3,
        method: 'model/list',
        params: { cursor: 'page-2', includeHidden: false, limit: 100 },
      },
    ]);
    expect(models.map((model) => model.value)).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed catalog instead of treating partial rows as confirmed', async () => {
    const child = new FakeAppServer();
    let buffered = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      for (const line of buffered.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; method: string };
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        } else if (message.method === 'model/list') {
          child.stdout.write(
            `${JSON.stringify({ id: message.id, result: { data: [{ model: 42 }] } })}\n`
          );
        }
      }
      buffered = '';
    });

    await expect(
      queryCodexModels('/opt/codex', { spawn: vi.fn(() => child as never), timeoutMs: 1_000 })
    ).rejects.toThrow(/invalid model\/list response/i);
  });

  it('bounds stdout before buffering a response without a newline', async () => {
    const child = new FakeAppServer();
    const result = queryCodexModels('/opt/codex', {
      spawn: vi.fn(() => child as never),
      timeoutMs: 1_000,
    });

    child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));

    await expect(result).rejects.toThrow(/byte limit/i);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('turns a broken stdin pipe into a rejected query', async () => {
    const child = new FakeAppServer();
    const result = queryCodexModels('/opt/codex', {
      spawn: vi.fn(() => child as never),
      timeoutMs: 1_000,
    });

    child.stdin.emit('error', new Error('EPIPE'));

    await expect(result).rejects.toThrow('EPIPE');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('preserves a multibyte model name split across stdout chunks', async () => {
    const child = new FakeAppServer();
    let buffered = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      for (const line of buffered.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; method: string };
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
          continue;
        }
        if (message.method !== 'model/list') continue;
        const response = Buffer.from(
          `${JSON.stringify({
            id: message.id,
            result: { data: [{ ...ASTRA, displayName: 'GPT-6 Astrá' }], nextCursor: null },
          })}\n`
        );
        const multibyteStart = response.indexOf(Buffer.from('á'));
        child.stdout.write(response.subarray(0, multibyteStart + 1));
        child.stdout.write(response.subarray(multibyteStart + 1));
      }
      buffered = '';
    });

    const models = await queryCodexModels('/opt/codex', {
      spawn: vi.fn(() => child as never),
      timeoutMs: 1_000,
    });

    expect(models[0]?.displayName).toBe('GPT-6 Astrá');
  });

  it('enriches only exact returned models with context windows from the same CLI version', async () => {
    const child = new FakeAppServer();
    installProtocolResponder(child, {
      userAgent: 'dorkos/0.153.4 (test)',
      singlePageModels: [ASTRA, SOL],
    });
    const readContextWindows = vi.fn(
      async () =>
        new Map([
          ['gpt-6-astra', 258_400],
          ['cache-only-model', 999_999],
        ])
    );

    const models = await queryCodexModels('/opt/codex', {
      spawn: vi.fn(() => child as never),
      timeoutMs: 1_000,
      readContextWindows,
    });

    expect(readContextWindows).toHaveBeenCalledWith('0.153.4');
    expect(models.find((model) => model.value === 'gpt-6-astra')?.contextWindow).toBe(258_400);
    expect(models.find((model) => model.value === 'gpt-5.6-sol')?.contextWindow).toBeUndefined();
    expect(models.some((model) => model.value === 'cache-only-model')).toBe(false);
  });

  it.each([
    ['rejects asynchronously', () => Promise.reject(new Error('cache unavailable'))],
    [
      'throws synchronously',
      () => {
        throw new Error('cache unavailable');
      },
    ],
  ])('keeps a confirmed catalog when optional context metadata %s', async (_name, read) => {
    const child = new FakeAppServer();
    installProtocolResponder(child, {
      userAgent: 'dorkos/0.153.4 (test)',
      singlePageModels: [ASTRA],
    });

    const models = await queryCodexModels('/opt/codex', {
      spawn: vi.fn(() => child as never),
      timeoutMs: 1_000,
      readContextWindows: vi.fn(read),
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.value).toBe('gpt-6-astra');
    expect(models[0]?.contextWindow).toBeUndefined();
  });

  it('returns confirmed models when optional context metadata never settles', async () => {
    const child = new FakeAppServer();
    installProtocolResponder(child, {
      userAgent: 'dorkos/0.153.4 (test)',
      singlePageModels: [ASTRA],
    });

    const models = await queryCodexModels('/opt/codex', {
      spawn: vi.fn(() => child as never),
      timeoutMs: 1_000,
      contextMetadataTimeoutMs: 10,
      readContextWindows: vi.fn(() => new Promise<ReadonlyMap<string, number>>(() => {})),
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.value).toBe('gpt-6-astra');
    expect(models[0]?.contextWindow).toBeUndefined();
  });
});

describe('mapAppServerModel', () => {
  it('preserves reported defaults and capabilities while filtering unknown effort levels', () => {
    expect(mapAppServerModel(ASTRA)).toEqual({
      value: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      description: 'Our most capable model for complex, demanding work.',
      isDefault: true,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'max'],
      supportsFastMode: true,
      supportsVision: true,
      supportsToolUse: true,
      supportsImageOutput: false,
      provider: 'openai',
    });
  });
});

describe('resolveCodexAuthContext', () => {
  it('keys the catalog by Codex home and auth-file metadata without reading its contents', async () => {
    const readMetadata = vi.fn(async () => ({ mtimeMs: 123.5, size: 456 }));

    await expect(
      resolveCodexAuthContext({ CODEX_HOME: '/accounts/codex-a' }, readMetadata)
    ).resolves.toBe('/accounts/codex-a\u0000123.5:456');
    expect(readMetadata).toHaveBeenCalledWith('/accounts/codex-a/auth.json');
  });
});

describe('CodexModelCatalog', () => {
  it('keys by effective environment names without retaining their values', async () => {
    let environment: Record<string, string> = {
      HOME: '/home/agent',
      CODEX_API_KEY: 'account-a',
    };
    const query = vi
      .fn<(binary: string, env: NodeJS.ProcessEnv) => Promise<ModelOption[]>>()
      .mockResolvedValueOnce([option('account-a-model')])
      .mockResolvedValueOnce([option('custom-provider-model')]);
    const catalog = new CodexModelCatalog({
      resolveBinary: vi.fn(async () => '/opt/codex'),
      resolveEnvironment: () => environment,
      resolveAuthContext: vi.fn(async (env) => `${env['HOME']}\u0000missing`),
      query,
      now: () => 10,
      ttlMs: 100,
      onError: vi.fn(),
    });

    await expect(catalog.getSupportedModels()).resolves.toEqual([option('account-a-model')]);
    environment = { ...environment, CODEX_API_KEY: 'account-b' };
    await expect(catalog.getSupportedModels()).resolves.toEqual([option('account-a-model')]);
    environment = { ...environment, CUSTOM_PROVIDER_KEY: 'inherited-by-new-policy' };
    await expect(catalog.getSupportedModels()).resolves.toEqual([option('custom-provider-model')]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      { HOME: '/home/agent', CODEX_API_KEY: 'account-a' },
      {
        HOME: '/home/agent',
        CODEX_API_KEY: 'account-b',
        CUSTOM_PROVIDER_KEY: 'inherited-by-new-policy',
      },
    ]);
    const cacheKey = (catalog as unknown as { cache: { key: string } | null }).cache?.key;
    expect(cacheKey).toBe(
      '/opt/codex\u0000["CODEX_API_KEY","CUSTOM_PROVIDER_KEY","HOME"]\u0000/home/agent\u0000missing'
    );
    expect(cacheKey).not.toContain('account-a');
    expect(cacheKey).not.toContain('account-b');
    expect(cacheKey).not.toContain('inherited-by-new-policy');
  });

  it('coalesces concurrent reads and reuses a fresh answer for the same binary and auth context', async () => {
    let resolveQuery!: (models: ModelOption[]) => void;
    const query = vi.fn(
      () =>
        new Promise<ModelOption[]>((resolve) => {
          resolveQuery = resolve;
        })
    );
    const catalog = new CodexModelCatalog({
      resolveBinary: vi.fn(async () => '/opt/codex'),
      resolveEnvironment: () => ({
        HOME: '/home',
        CODEX_API_KEY: 'in-flight-credential',
      }),
      resolveAuthContext: vi.fn(async () => '/home/.codex\u0000123:456'),
      query,
      now: () => 10,
      ttlMs: 100,
      onError: vi.fn(),
    });

    const first = catalog.getSupportedModels();
    const second = catalog.getSupportedModels();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const inFlightKey = (catalog as unknown as { inFlight: { key: string } | null }).inFlight?.key;
    expect(inFlightKey).toBe(
      '/opt/codex\u0000["CODEX_API_KEY","HOME"]\u0000/home/.codex\u0000123:456'
    );
    expect(inFlightKey).not.toContain('in-flight-credential');
    resolveQuery([option('gpt-6-astra')]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      [option('gpt-6-astra')],
      [option('gpt-6-astra')],
    ]);
    await expect(catalog.getSupportedModels()).resolves.toEqual([option('gpt-6-astra')]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the TTL and keeps the last good answer when that same identity fails', async () => {
    let now = 10;
    const query = vi
      .fn<() => Promise<ModelOption[]>>()
      .mockResolvedValueOnce([option('gpt-6-astra')])
      .mockRejectedValueOnce(new Error('app-server unavailable'))
      .mockRejectedValueOnce(new Error('app-server still unavailable'));
    const onError = vi.fn();
    const catalog = new CodexModelCatalog({
      resolveBinary: vi.fn(async () => '/opt/codex'),
      resolveAuthContext: vi.fn(async () => '/home/.codex\u0000123:456'),
      query,
      now: () => now,
      ttlMs: 100,
      onError,
    });

    await expect(catalog.getSupportedModels()).resolves.toEqual([option('gpt-6-astra')]);
    now = 111;
    await expect(catalog.getSupportedModels()).resolves.toEqual([option('gpt-6-astra')]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(catalog.getSupportedModels()).resolves.toEqual([option('gpt-6-astra')]);
    expect(query).toHaveBeenCalledTimes(2);

    now = 300_011;
    await expect(catalog.getSupportedModels()).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    await expect(catalog.getSupportedModels()).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('never lets a late failed refresh extend the stale deadline', async () => {
    let now = 0;
    const query = vi
      .fn<() => Promise<ModelOption[]>>()
      .mockResolvedValueOnce([option('gpt-6-astra')])
      .mockRejectedValueOnce(new Error('app-server unavailable'))
      .mockRejectedValueOnce(new Error('app-server still unavailable'));
    const catalog = new CodexModelCatalog({
      resolveBinary: vi.fn(async () => '/opt/codex'),
      resolveAuthContext: vi.fn(async () => '/home/.codex\u0000123:456'),
      query,
      now: () => now,
      ttlMs: 100,
      onError: vi.fn(),
    });

    await expect(catalog.getSupportedModels()).resolves.toEqual([option('gpt-6-astra')]);
    now = 299_999;
    await expect(catalog.getSupportedModels()).resolves.toEqual([option('gpt-6-astra')]);

    now = 300_001;
    await expect(catalog.getSupportedModels()).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('never reuses a catalog after the auth-file identity changes', async () => {
    let authContext = '/home/.codex\u0000123:456';
    const query = vi
      .fn<() => Promise<ModelOption[]>>()
      .mockResolvedValueOnce([option('gpt-6-astra')])
      .mockRejectedValueOnce(new Error('signed out'));
    const catalog = new CodexModelCatalog({
      resolveBinary: vi.fn(async () => '/opt/codex'),
      resolveAuthContext: vi.fn(async () => authContext),
      query,
      now: () => 10,
      ttlMs: 100,
      onError: vi.fn(),
    });

    await expect(catalog.getSupportedModels()).resolves.toEqual([option('gpt-6-astra')]);
    authContext = '/home/.codex\u0000789:456';
    await expect(catalog.getSupportedModels()).resolves.toEqual([]);
  });

  it('returns an unknown catalog without spawning when no binary resolves', async () => {
    const query = vi.fn();
    const catalog = new CodexModelCatalog({
      resolveBinary: vi.fn(async () => null),
      resolveAuthContext: vi.fn(async () => '/home/.codex\u0000missing'),
      query,
      onError: vi.fn(),
    });

    await expect(catalog.getSupportedModels()).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
