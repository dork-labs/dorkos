import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

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

describe('renderCacheStatus', () => {
  it('adds one line when automatic cleanup is paused', () => {
    // Purpose: a paused cleanup removes nothing; this is where a person sees it.
    const rendered = renderCacheStatus({
      ...CACHE_STATUS_FIXTURE,
      cleanup: {
        paused: true,
        reason: "couldn't read /Volumes/Work/app (the folder is missing)",
        since: '2026-09-23T10:00:00.000Z',
      },
    });
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(
      "Automatic cleanup is paused: couldn't read /Volumes/Work/app (the folder is missing)"
    );
  });
});

describe('runCacheList', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

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
});

describe('runCachePrune', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

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
          lastUsedAt: '2026-04-06T00:00:00.000Z',
        }),
        freedBytes: 23 * 1024 * 1024,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runCachePrune();

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/cache/prune');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Removed 7 cached packages');
    expect(allLogs).toContain('23 MB');
  });
});

describe('runCacheClear', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;
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
});
