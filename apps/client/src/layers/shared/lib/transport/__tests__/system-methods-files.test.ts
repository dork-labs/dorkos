// @vitest-environment jsdom
/**
 * The file-explorer Transport methods that can only be tested here.
 *
 * `revealEntry` answers `204 No Content`. That is invisible above this seam —
 * a mock Transport resolves whatever it is told to — but it is the whole
 * contract with `POST /api/files/reveal`: parsing an empty body as JSON rejects,
 * so a success would have surfaced to the user as a failure toast. These drive
 * a REAL `Response`, not a hand-shaped object, so the body semantics are the
 * browser's own.
 *
 * `copyEntry` is here for the other half of the same contract: its URL and
 * method are only checked at runtime, where a component test cannot see them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSystemMethods } from '../system-methods';

const BASE = 'http://localhost:4242/api';

function setup() {
  return createSystemMethods(BASE);
}

/** The URL and `RequestInit` the last `fetch` call was made with. */
function lastCall(): [string, RequestInit] {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('revealEntry', () => {
  it('resolves on a real empty 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(setup().revealEntry('/repo', 'README.md')).resolves.toBeUndefined();
  });

  it('posts the path to the reveal route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await setup().revealEntry('/repo', 'src/index.ts');

    const [url, init] = lastCall();
    expect(url).toBe(`${BASE}/files/reveal`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ cwd: '/repo', path: 'src/index.ts' }));
  });

  it('rejects with the server code when the entry is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Path not found', code: 'NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(setup().revealEntry('/repo', 'gone.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('copyEntry', () => {
  it('posts both paths to the copy route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(setup().copyEntry('/repo', 'a.txt', 'b.txt')).resolves.toEqual({ ok: true });

    const [url, init] = lastCall();
    expect(url).toBe(`${BASE}/files/copy`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ cwd: '/repo', from: 'a.txt', to: 'b.txt' }));
  });

  it('rejects with CONFLICT when the destination is taken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Target already exists', code: 'CONFLICT' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(setup().copyEntry('/repo', 'a.txt', 'b.txt')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
