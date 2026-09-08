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

function installProtocolResponder(child: FakeAppServer): unknown[] {
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
          `${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`
        );
      } else if (message.method === 'model/list') {
        const cursor = (message.params as { cursor?: string }).cursor;
        const result = cursor
          ? { data: [SOL], nextCursor: null }
          : { data: [ASTRA], nextCursor: 'page-2' };
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    }
  });
  return requests;
}

describe('queryCodexModels', () => {
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
      resolveAuthContext: vi.fn(async () => '/home/.codex\u0000123:456'),
      query,
      now: () => 10,
      ttlMs: 100,
      onError: vi.fn(),
    });

    const first = catalog.getSupportedModels();
    const second = catalog.getSupportedModels();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
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
