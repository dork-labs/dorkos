import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub `node:readline` at module load so the confirm() prompt path is
// controllable from individual tests. Vitest's ESM spy API cannot
// redefine native module exports, so we swap in a factory whose
// `createInterface` returns an object whose `question` handler is
// rewired per-test via `confirmAnswer`.
let confirmAnswer: string | null = null;
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => {
      cb(confirmAnswer ?? '');
    },
    close: () => {},
  }),
}));

import {
  formatBytes,
  parseCacheClearArgs,
  parseCacheListArgs,
  parseCachePruneArgs,
  renderCacheStatus,
  runCacheClear,
  runCacheList,
  runCachePrune,
} from '../commands/cache-commands.js';

/**
 * Build a fetch `Response`-like object that the api-client can consume.
 * Mirrors the helper used by `marketplace-commands.test.ts`.
 */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

const CACHE_STATUS_FIXTURE = {
  marketplaces: 2,
  packages: 14,
  totalSizeBytes: 49_283_072, // ~47 MB
};

describe('formatBytes', () => {
  it('formats bytes below 1 KB as B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB range', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1.5)).toBe('1.5 KB');
  });

  it('formats MB range', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(47 * 1024 * 1024)).toBe('47 MB');
  });

  it('formats GB range', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatBytes(1.25 * 1024 * 1024 * 1024)).toBe('1.25 GB');
  });

  it('handles negative or non-finite input defensively', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('renderCacheStatus', () => {
  it('renders three right-aligned rows', () => {
    const rendered = renderCacheStatus(CACHE_STATUS_FIXTURE);
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Marketplaces cached:');
    expect(lines[0]).toContain('2');
    expect(lines[1]).toContain('Packages cached:');
    expect(lines[1]).toContain('14');
    expect(lines[2]).toContain('Total size:');
    expect(lines[2]).toMatch(/47(\.\d+)? MB$/);
    // Right-alignment: all three lines should share the same total length.
    const lengths = new Set(lines.map((l) => l.length));
    expect(lengths.size).toBe(1);
  });

  it('handles an empty cache cleanly', () => {
    const rendered = renderCacheStatus({ marketplaces: 0, packages: 0, totalSizeBytes: 0 });
    expect(rendered).toContain('Marketplaces cached:');
    expect(rendered).toContain('0 B');
  });
});

describe('parseCacheListArgs', () => {
  it('accepts no arguments', () => {
    expect(() => parseCacheListArgs([])).not.toThrow();
  });

  it('throws on unknown option', () => {
    expect(() => parseCacheListArgs(['--nope'])).toThrow(/Unknown option for 'cache list': --nope/);
  });
});

describe('parseCachePruneArgs', () => {
  it('returns an empty object with no flags', () => {
    expect(parseCachePruneArgs([])).toEqual({});
  });

  it('parses --keep-last-n', () => {
    expect(parseCachePruneArgs(['--keep-last-n', '3'])).toEqual({ keepLastN: 3 });
  });

  it('parses --keep-last-n=5 form', () => {
    expect(parseCachePruneArgs(['--keep-last-n=5'])).toEqual({ keepLastN: 5 });
  });

  it('rejects negative keep-last-n', () => {
    expect(() => parseCachePruneArgs(['--keep-last-n=-1'])).toThrow(
      /Invalid value for --keep-last-n/
    );
  });

  it('rejects non-integer keep-last-n', () => {
    expect(() => parseCachePruneArgs(['--keep-last-n', 'abc'])).toThrow(
      /Invalid value for --keep-last-n/
    );
  });

  it('throws on unknown option', () => {
    expect(() => parseCachePruneArgs(['--force'])).toThrow(
      /Unknown option for 'cache prune': --force/
    );
  });
});

describe('parseCacheClearArgs', () => {
  it('defaults yes to false', () => {
    expect(parseCacheClearArgs([])).toEqual({ yes: false });
  });

  it('parses --yes', () => {
    expect(parseCacheClearArgs(['--yes'])).toEqual({ yes: true });
  });

  it('parses -y shorthand', () => {
    expect(parseCacheClearArgs(['-y'])).toEqual({ yes: true });
  });

  it('throws on unknown option', () => {
    expect(() => parseCacheClearArgs(['--force'])).toThrow(
      /Unknown option for 'cache clear': --force/
    );
  });
});

describe('runCacheList', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('GETs /cache and renders the status block', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, CACHE_STATUS_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCacheList();

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/cache');
    expect(init.method).toBe('GET');

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Marketplaces cached:');
    expect(allLogs).toContain('Packages cached:');
    expect(allLogs).toContain('Total size:');
    expect(allLogs).toMatch(/47(\.\d+)? MB/);
  });

  it('prints a friendly error when the server is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCacheList();

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Error:');
  });
});

describe('runCachePrune', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('POSTs to /cache/prune with an empty body by default', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        removed: new Array(7).fill({
          packageName: 'pkg',
          commitSha: 'sha',
          path: '/p',
          cachedAt: '2026-04-06T00:00:00.000Z',
        }),
        freedBytes: 23 * 1024 * 1024,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCachePrune({});

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/cache/prune');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Pruned 7 cached packages');
    expect(allLogs).toContain('23 MB');
  });

  it('forwards --keep-last-n in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        removed: [],
        freedBytes: 0,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await runCachePrune({ keepLastN: 3 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ keepLastN: 3 });
  });

  it('uses singular noun when exactly one package was removed', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        removed: [
          { packageName: 'pkg', commitSha: 'sha', path: '/p', cachedAt: '2026-04-06T00:00:00Z' },
        ],
        freedBytes: 2048,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await runCachePrune({});

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Pruned 1 cached package,');
    expect(allLogs).toContain('2 KB');
  });

  it('prints an empty-state hint when nothing was removed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { removed: [], freedBytes: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCachePrune({});

    expect(code).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Nothing to prune');
  });

  it('exits non-zero on server error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(500, { error: 'Failed to prune marketplace cache' }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCachePrune({});

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Failed to prune');
  });
});

describe('runCacheClear', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalIsTTY = process.stdin.isTTY;
    confirmAnswer = null;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
    // Restore the original TTY state so later tests are unaffected.
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('DELETEs /cache when --yes is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCacheClear({ yes: true });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/cache');
    expect(init.method).toBe('DELETE');

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Cache cleared.');
  });

  it('errors and skips DELETE when non-TTY without --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCacheClear({ yes: false });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Cache clear requires --yes in non-interactive mode.');
  });

  it('cancels without DELETE when the confirmation prompt is declined', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    confirmAnswer = 'n';

    const code = await runCacheClear({ yes: false });

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Cache clear cancelled.');
  });

  it('calls DELETE when the confirmation prompt is accepted', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    confirmAnswer = 'y';

    const code = await runCacheClear({ yes: false });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Cache cleared.');
  });

  it('exits non-zero on server failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(500, { error: 'Failed to clear marketplace cache' }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCacheClear({ yes: true });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Failed to clear');
  });
});
