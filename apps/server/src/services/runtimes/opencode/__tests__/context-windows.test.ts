/**
 * The OpenCode context-window cache (DOR-2732): a reply's usage names its
 * model but not its window, so the window is read from the sidecar's catalog —
 * once, not on every reply.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import {
  CONTEXT_WINDOW_RETRY_MS,
  CONTEXT_WINDOW_TTL_MS,
  OpenCodeContextWindows,
  contextWindowsFrom,
} from '../providers/context-windows.js';

const catalog = {
  all: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: {
        'claude-sonnet-4-5': {
          id: 'claude-sonnet-4-5',
          limit: { context: 200_000, output: 64_000 },
        },
        'no-window': { id: 'no-window', limit: { context: 0, output: 0 } },
      },
    },
    {
      id: 'ollama',
      name: 'Ollama',
      models: { 'qwen3:8b': { id: 'qwen3:8b', limit: { context: 40_960, output: 8_192 } } },
    },
  ],
  default: {},
  connected: ['anthropic'],
};

function client(list: ReturnType<typeof vi.fn>): OpencodeClient {
  return { provider: { list } } as unknown as OpencodeClient;
}

describe('contextWindowsFrom', () => {
  it('keys every model with a positive window by provider/model, and leaves the rest out', () => {
    const table = contextWindowsFrom(catalog as never);
    expect([...table.entries()]).toEqual([
      ['anthropic/claude-sonnet-4-5', 200_000],
      ['ollama/qwen3:8b', 40_960],
    ]);
  });
});

describe('OpenCodeContextWindows', () => {
  it('reads the catalog once for many replies, and answers per model', async () => {
    const list = vi.fn(async () => ({ data: catalog }));
    const windows = new OpenCodeContextWindows();
    const sidecar = client(list);
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')).toBe(200_000);
    expect(await windows.lookup(sidecar, '/p', 'ollama', 'qwen3:8b')).toBe(40_960);
    // Unknown, or known without a window: no guess.
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'no-window')).toBeUndefined();
    expect(await windows.lookup(sidecar, '/p', 'nobody', 'nothing')).toBeUndefined();
    expect(await windows.lookup(sidecar, '/p', undefined, 'claude-sonnet-4-5')).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ query: { directory: '/p' } });
  });

  it('reads it again once the cached copy is old, and per sidecar client', async () => {
    let now = 0;
    const list = vi.fn(async () => ({ data: catalog }));
    const windows = new OpenCodeContextWindows({ now: () => now });
    const sidecar = client(list);
    await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5');
    now = CONTEXT_WINDOW_TTL_MS - 1;
    await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5');
    expect(list).toHaveBeenCalledTimes(1);
    now = CONTEXT_WINDOW_TTL_MS + 1;
    await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5');
    expect(list).toHaveBeenCalledTimes(2);
    // A restarted sidecar is a new client, with a catalog of its own.
    const other = vi.fn(async () => ({ data: catalog }));
    await windows.lookup(client(other), '/p', 'anthropic', 'claude-sonnet-4-5');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('answers nothing when the catalog cannot be read, and tries again only after a while', async () => {
    let now = 0;
    const list = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: 'down' } })
      .mockResolvedValue({ data: catalog });
    const windows = new OpenCodeContextWindows({ now: () => now });
    const sidecar = client(list);
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')).toBeUndefined();
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
    now = CONTEXT_WINDOW_RETRY_MS + 1;
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')).toBe(200_000);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('OpenCodeContextWindows — never costs a reply', () => {
  it('answers without a window once the bound passes on a catalog that never answers', async () => {
    const list = vi.fn(() => new Promise(() => {}));
    const windows = new OpenCodeContextWindows({ readTimeoutMs: 20 });
    const started = Date.now();
    expect(
      await windows.lookup(client(list), '/p', 'anthropic', 'claude-sonnet-4-5')
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('survives a catalog call that throws before it returns, and tries again later', async () => {
    let now = 0;
    const list = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sidecar gone');
      })
      .mockResolvedValue({ data: catalog });
    const windows = new OpenCodeContextWindows({ now: () => now });
    const sidecar = client(list);
    await expect(
      windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')
    ).resolves.toBeUndefined();
    await expect(
      windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')
    ).resolves.toBeUndefined();
    now = CONTEXT_WINDOW_RETRY_MS + 1;
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')).toBe(200_000);
  });

  it('reads each project directory’s catalog of its own (opencode.json can resize a model)', async () => {
    const resized = {
      ...catalog,
      all: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-sonnet-4-5': {
              id: 'claude-sonnet-4-5',
              limit: { context: 1_000_000, output: 64_000 },
            },
          },
        },
      ],
    };
    const list = vi.fn(async (options: { query: { directory: string } }) => ({
      data: options.query.directory === '/big' ? resized : catalog,
    }));
    const windows = new OpenCodeContextWindows();
    const sidecar = client(list as unknown as ReturnType<typeof vi.fn>);
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')).toBe(200_000);
    expect(await windows.lookup(sidecar, '/big', 'anthropic', 'claude-sonnet-4-5')).toBe(1_000_000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('starts the read at prefetch, so the lookup finds it done', async () => {
    const list = vi.fn(async () => ({ data: catalog }));
    const windows = new OpenCodeContextWindows();
    const sidecar = client(list);
    windows.prefetch(sidecar, '/p');
    expect(list).toHaveBeenCalledTimes(1);
    expect(await windows.lookup(sidecar, '/p', 'anthropic', 'claude-sonnet-4-5')).toBe(200_000);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
