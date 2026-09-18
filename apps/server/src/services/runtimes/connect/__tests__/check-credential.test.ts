import { describe, it, expect, vi } from 'vitest';
import { findOpenCodeDirectProvider } from '@dorkos/shared/runtime-connect';
import { checkProviderKey, checkRuntimeKey, type FetchFn } from '../check-credential.js';
import { ConnectError } from '../connect-error.js';

const SECRET = 'sk-secret-never-echo-1234';

/** One request the fake `fetch` saw: the URL and the headers it was given. */
interface SeenRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * A `fetch` double that answers with `status` and records every call, so a test
 * can assert the exact address and headers a check used.
 */
function fakeFetch(status: number): { fetchImpl: FetchFn; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(status === 200 ? '{"data":[]}' : '', { status });
  }) as unknown as FetchFn;
  return { fetchImpl, seen };
}

describe('checkProviderKey — OpenAI-style services', () => {
  it('accepts a key the service answers 200 for, and reads the model list with a bearer token', async () => {
    const { fetchImpl, seen } = fakeFetch(200);
    const result = await checkProviderKey({ providerId: 'openai', secret: SECRET }, { fetchImpl });

    expect(result).toEqual({ ok: true });
    expect(seen[0].url).toBe('https://api.openai.com/v1/models');
    expect(seen[0].headers).toEqual({ Authorization: `Bearer ${SECRET}` });
  });

  it('reports a 401 as rejected, in words a non-developer can act on', async () => {
    const { fetchImpl } = fakeFetch(401);
    const result = await checkProviderKey({ providerId: 'openai', secret: SECRET }, { fetchImpl });

    expect(result).toEqual({
      ok: false,
      reason: 'rejected',
      message: 'That key was not accepted. Check it and try again.',
    });
  });

  it('reports a 403 as rejected too — a key that exists but may not do this', async () => {
    const { fetchImpl } = fakeFetch(403);
    const result = await checkProviderKey({ providerId: 'openai', secret: SECRET }, { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
  });

  it('reports any other non-2xx as unexpected, naming the host and the status', async () => {
    const { fetchImpl } = fakeFetch(500);
    const result = await checkProviderKey({ providerId: 'openai', secret: SECRET }, { fetchImpl });

    expect(result).toEqual({
      ok: false,
      reason: 'unexpected',
      message: 'api.openai.com answered with 500. Try again in a minute.',
    });
  });

  it('reports a refused connection or a timeout as unreachable, never as a bad key', async () => {
    // A thrown fetch is what both a dead address and the bound firing look like
    // from here. Calling either "your key is wrong" would send someone hunting
    // for a typo in a key that is fine.
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    }) as unknown as FetchFn;

    const result = await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: 'https://nothing.example.com/v1' },
      { fetchImpl }
    );

    expect(result).toEqual({
      ok: false,
      reason: 'unreachable',
      message: 'Couldn’t reach nothing.example.com. Check the base URL and whether you’re online.',
    });
  });

  it('never puts the key in the URL', async () => {
    const { fetchImpl, seen } = fakeFetch(200);
    await checkProviderKey({ providerId: 'openai', secret: SECRET }, { fetchImpl });
    expect(seen[0].url).not.toContain(SECRET);
  });
});

describe('checkProviderKey — base URL normalisation', () => {
  it('uses the entered address, trimmed and without its trailing slashes', async () => {
    const { fetchImpl, seen } = fakeFetch(200);
    await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: '  https://api.example.com/v1//  ' },
      { fetchImpl }
    );
    expect(seen[0].url).toBe('https://api.example.com/v1/models');
  });

  it('appends /models verbatim rather than guessing at a missing version segment', async () => {
    // Deliberately NOT clever: an address without `/v1` is probed as given. A
    // rewrite here would break every OpenAI-compatible server that does not use
    // that path, and a person can see and fix the address they typed.
    const { fetchImpl, seen } = fakeFetch(200);
    await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: 'https://lm.example.com:8000' },
      { fetchImpl }
    );
    expect(seen[0].url).toBe('https://lm.example.com:8000/models');
  });

  it('falls back to the service’s own address when the base URL is only whitespace', async () => {
    // An empty Advanced field means "use the service's own address", not "probe
    // nothing" — otherwise clearing the field would produce a request to `/models`.
    const { fetchImpl, seen } = fakeFetch(200);
    const result = await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: '   ' },
      { fetchImpl }
    );
    expect(result).toEqual({ ok: true });
    expect(seen[0].url).toBe('https://api.openai.com/v1/models');
  });
});

describe('checkProviderKey — Anthropic', () => {
  it('reads Anthropic’s model list with x-api-key and its version header', async () => {
    const { fetchImpl, seen } = fakeFetch(200);
    const result = await checkProviderKey(
      { providerId: 'anthropic', secret: SECRET },
      { fetchImpl }
    );

    expect(result).toEqual({ ok: true });
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/models');
    expect(seen[0].headers).toEqual({
      'x-api-key': SECRET,
      'anthropic-version': '2023-06-01',
    });
    // A bearer token would be silently ignored by Anthropic and read as a bad key.
    expect(seen[0].headers.Authorization).toBeUndefined();
  });
});

describe('checkProviderKey — services DorkOS cannot pass a key to', () => {
  it('refuses a free-text service name up front, instead of at the first turn', async () => {
    // The report behind DOR-2123: "Valut Cloud" saved cleanly and then died at
    // the env seam with no key mapping at all.
    const { fetchImpl } = fakeFetch(200);
    await expect(
      checkProviderKey({ providerId: 'Valut Cloud', secret: SECRET }, { fetchImpl })
    ).rejects.toBeInstanceOf(ConnectError);

    await expect(
      checkProviderKey({ providerId: 'Valut Cloud', secret: SECRET }, { fetchImpl })
    ).rejects.toThrow(/Choose OpenAI or Anthropic/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows the cloud path’s own service id', async () => {
    // OpenRouter has its own validator; it must stay checkable through here so
    // one code path answers "is this key live" for every service.
    const { fetchImpl } = fakeFetch(200);
    await expect(
      checkProviderKey({ providerId: 'openrouter', secret: SECRET }, { fetchImpl })
    ).resolves.toEqual({ ok: true });
  });

  it('reports an OpenRouter key the service refuses as rejected', async () => {
    const { fetchImpl } = fakeFetch(401);
    await expect(
      checkProviderKey({ providerId: 'openrouter', secret: SECRET }, { fetchImpl })
    ).resolves.toMatchObject({ ok: false, reason: 'rejected' });
  });
});

describe('checkRuntimeKey', () => {
  it('checks a Claude Code key against Anthropic', async () => {
    const { fetchImpl, seen } = fakeFetch(200);
    await expect(checkRuntimeKey('claude-code', SECRET, { fetchImpl })).resolves.toEqual({
      ok: true,
    });
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/models');
  });

  it('checks a Codex key against OpenAI', async () => {
    const { fetchImpl, seen } = fakeFetch(200);
    await expect(checkRuntimeKey('codex', SECRET, { fetchImpl })).resolves.toEqual({ ok: true });
    expect(seen[0].url).toBe('https://api.openai.com/v1/models');
  });

  it('refuses a runtime that has no key of its own', async () => {
    await expect(checkRuntimeKey('opencode', SECRET)).rejects.toBeInstanceOf(ConnectError);
  });
});

describe('OPENCODE_DIRECT_PROVIDERS — the one list both sides read', () => {
  it('is the allow-list: every listed service is checkable, and nothing else is', async () => {
    // Asserted OVER the list rather than against a copy of it, so adding a
    // service cannot leave this test passing about services that no longer exist.
    const { OPENCODE_DIRECT_PROVIDERS } = await import('@dorkos/shared/runtime-connect');
    expect(OPENCODE_DIRECT_PROVIDERS.length).toBeGreaterThan(0);

    for (const entry of OPENCODE_DIRECT_PROVIDERS) {
      expect(findOpenCodeDirectProvider(entry.id)).toBe(entry);
      // Every listed service has an address and a way to get a key, because the
      // picker renders both without asking whether they are there.
      expect(entry.defaultBaseURL).toMatch(/^https?:\/\//);
      expect(entry.getKeyUrl).toMatch(/^https:\/\//);

      const { fetchImpl } = fakeFetch(200);
      await expect(
        checkProviderKey({ providerId: entry.id, secret: SECRET }, { fetchImpl })
      ).resolves.toEqual({ ok: true });
    }

    expect(findOpenCodeDirectProvider('Valut Cloud')).toBeUndefined();
    await expect(
      checkProviderKey({ providerId: 'Valut Cloud', secret: SECRET }, fakeFetch(200))
    ).rejects.toBeInstanceOf(ConnectError);
  });
});

describe('checkProviderKey — the key must not leave the address it was sent to', () => {
  it('does not follow a redirect, and reports it as an address problem', async () => {
    // The request carries the key in a header, and `fetch` re-sends headers on a
    // cross-origin redirect — so following one would bounce the key to a host the
    // person never named.
    const { fetchImpl, seen } = fakeFetch(302);
    const result = await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: 'https://redirector.example.com/v1' },
      { fetchImpl }
    );

    expect(result).toEqual({
      ok: false,
      reason: 'unexpected',
      message: 'redirector.example.com answered with 302. Check the base URL.',
    });
    // One request, and no second one to wherever it pointed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('asks fetch not to follow redirects at all', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as FetchFn;
    await checkProviderKey({ providerId: 'openai', secret: SECRET }, { fetchImpl });

    const init = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('refuses a base URL that is not an http(s) address, before attaching the key', async () => {
    const { fetchImpl } = fakeFetch(200);
    const result = await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: 'file:///etc' },
      { fetchImpl }
    );

    expect(result).toEqual({
      ok: false,
      reason: 'unreachable',
      message: 'The base URL must start with http:// or https://',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a loopback and a private address on purpose', async () => {
    // People run model servers on localhost and on a LAN box. This endpoint is
    // loopback-gated and driven by the machine's own operator, so blocking those
    // would break the honest case to defend against one that does not exist here.
    const { fetchImpl, seen } = fakeFetch(200);
    await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: 'http://127.0.0.1:1234/v1' },
      { fetchImpl }
    );
    await checkProviderKey(
      { providerId: 'openai', secret: SECRET, baseURL: 'http://192.168.1.50:8080/v1' },
      { fetchImpl }
    );

    expect(seen.map((request) => request.url)).toEqual([
      'http://127.0.0.1:1234/v1/models',
      'http://192.168.1.50:8080/v1/models',
    ]);
  });
});

describe('checkProviderKey — the bound actually fires', () => {
  it('aborts a fetch that never resolves, and clears its timer either way', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      // A fetch that only ever settles by being aborted — what a black-holed
      // address looks like from here.
      const fetchImpl = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ) as unknown as FetchFn;

      const pending = checkProviderKey({ providerId: 'openai', secret: SECRET }, { fetchImpl });
      // Nothing has given up yet one tick before the bound.
      await vi.advanceTimersByTimeAsync(7_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).resolves.toEqual({
        ok: false,
        reason: 'unreachable',
        message: 'Couldn’t reach api.openai.com. Check the base URL and whether you’re online.',
      });
      // The timer is cleared on every path, so a resolved check leaves nothing
      // holding the event loop open.
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
