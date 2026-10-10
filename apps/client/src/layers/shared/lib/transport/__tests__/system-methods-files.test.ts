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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
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

describe('writeFile', () => {
  it.each(['changed', 'no_op'] as const)(
    'preserves the actual server %s acknowledgement',
    async (effect) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ ok: true, hash: 'server-hash', effect }), { status: 200 })
          )
      );

      await expect(
        setup().writeFile('/repo', 'doc.md', 'body', { expectedHash: 'previous' })
      ).resolves.toEqual({ ok: true, hash: 'server-hash', effect });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/files/content`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        cwd: '/repo',
        path: 'doc.md',
        content: 'body',
        expectedHash: 'previous',
      });
    }
  );

  it.each([
    null,
    [],
    123,
    'not an object',
    { hash: 'h', effect: 'changed' },
    { ok: false, hash: 'h', effect: 'changed' },
    { ok: true, effect: 'changed' },
    { ok: true, hash: '', effect: 'changed' },
    { ok: true, hash: 123, effect: 'changed' },
    { ok: true, hash: 'h' },
    { ok: true, hash: 'h', effect: 'saved' },
    { ok: true, hash: 'h', effect: true },
  ])('rejects malformed success evidence %j', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    );
    await expect(setup().writeFile('/repo', 'doc.md', 'body')).rejects.toThrow(
      'Invalid file save response'
    );
  });

  it('rejects an undecodable success acknowledgement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON', { status: 200 })));
    await expect(setup().writeFile('/repo', 'doc.md', 'body')).rejects.toThrow();
  });

  it('retains current disk bytes and hash on a 409', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ currentHash: 'disk-hash', currentContent: 'disk' }), {
          status: 409,
        })
      )
    );
    await expect(setup().writeFile('/repo', 'doc.md', 'mine')).resolves.toEqual({
      ok: false,
      conflict: { currentHash: 'disk-hash', currentContent: 'disk' },
    });
  });

  it('keeps genuine server errors as thrown failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Permission denied', code: 'EACCES' }), {
          status: 403,
        })
      )
    );
    await expect(setup().writeFile('/repo', 'doc.md', 'mine')).rejects.toMatchObject({
      message: 'Permission denied',
      code: 'EACCES',
      status: 403,
    });
  });
});

describe('original document-bound writeFile response', () => {
  const documentSave = {
    documentId: 'doc-original',
    expectedGeneration: 'a'.repeat(64),
    eventId: '11111111-1111-4111-8111-111111111111',
    expectedFileHash: 'b'.repeat(64),
  };
  const receipt = (id = documentSave.eventId, status: 'recorded' | 'duplicate' = 'recorded') => ({
    receipt: { id, docSeq: 1, status },
    deliveries: [],
  });
  it('keeps the same original request ID after a lost response and validates the correlated original receipt', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            hash: 'c'.repeat(64),
            effect: 'no_op',
            documentReceipt: receipt(undefined, 'duplicate'),
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetch);
    const methods = setup();
    const options = { expectedHash: documentSave.expectedFileHash, documentSave };
    await expect(methods.writeFile('/repo', 'doc.md', 'confirmed body', options)).rejects.toThrow(
      'response lost'
    );
    await expect(
      methods.writeFile('/repo', 'doc.md', 'confirmed body', options)
    ).resolves.toMatchObject({
      ok: true,
      effect: 'no_op',
      documentReceipt: { receipt: { id: documentSave.eventId, status: 'duplicate' } },
    });
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(JSON.parse(fetch.mock.calls[0][1].body).documentSave).toEqual(documentSave);
    expect(fetch.mock.calls[0][1].credentials).toBe('include');
  });
  it.each([
    { ok: true, hash: 'c'.repeat(64), effect: 'changed' },
    {
      ok: true,
      hash: 'c'.repeat(64),
      effect: 'changed',
      documentReceipt: receipt('22222222-2222-4222-8222-222222222222'),
    },
    { ok: true, hash: 'c'.repeat(64), effect: 'no_op', documentReceipt: receipt() },
  ])('refuses a missing, foreign or false no-op completion', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    );
    await expect(
      setup().writeFile('/repo', 'doc.md', 'confirmed body', {
        expectedHash: documentSave.expectedFileHash,
        documentSave,
      })
    ).rejects.toThrow('Document save receipt');
  });
});
