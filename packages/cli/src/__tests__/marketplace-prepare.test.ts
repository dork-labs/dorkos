import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import {
  parseMarketplacePrepareArgs,
  runMarketplacePrepare,
} from '../commands/marketplace-prepare.js';

/** Build a fetch `Response`-like object that the api-client can consume. */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

describe('parseMarketplacePrepareArgs', () => {
  // Purpose: the command names one package, optionally scoped to a project.
  it('parses the name, --project and --json', () => {
    expect(parseMarketplacePrepareArgs(['flow', '--project', '/work/a', '--json'])).toEqual({
      name: 'flow',
      projectPath: '/work/a',
      json: true,
    });
  });

  // Purpose: without a name there is nothing to prepare; say how to call it.
  it('refuses a missing name with the usage line', () => {
    expect(() => parseMarketplacePrepareArgs([])).toThrow(/Usage: dorkos marketplace prepare/);
  });
});

describe('runMarketplacePrepare (DOR-2320)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  // Purpose: a rebuilt (or already recorded) install exits 0 and prints the
  // server's sentence; the request names the package and the project.
  it('POSTs the package and prints the answer', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, {
        outcome: 'rebuilt',
        message: "DorkOS now knows which of flow's files are yours.",
      })
    );

    const code = await runMarketplacePrepare({ name: 'flow', projectPath: '/work/a', json: false });

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/marketplace\/packages\/flow\/prepare$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ projectPath: '/work/a' });
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('flow');
  });

  // Purpose: an install that could not be prepared exits 1 (scripts can tell),
  // still with the reason in words.
  it.each(['mismatch', 'fetch-failed', 'no-source'])('exits 1 on %s', async (outcome) => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { outcome, message: 'why not' }));
    expect(await runMarketplacePrepare({ name: 'flow', json: false })).toBe(1);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('why not');
  });

  // Purpose: --json prints the server's answer untouched.
  it('--json prints the answer as JSON', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fetchMock.mockResolvedValueOnce(mockResponse(200, { outcome: 'not-needed', message: 'm' }));
    expect(await runMarketplacePrepare({ name: 'flow', json: true })).toBe(0);
    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();
    expect(JSON.parse(written)).toEqual({ outcome: 'not-needed', message: 'm' });
  });
});
