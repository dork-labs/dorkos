import { describe, it, expect, vi } from 'vitest';
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

describe('checkProviderKey — a service named by its own id, not its wire id', () => {
  it('accepts `vault-cloud` and checks it at ITS address, not OpenAI’s', async () => {
    // The client sends the wire id, so this is the stale-client / curl path. It
    // must not degrade into "openai with no address", which is a different
    // service holding a different key.
    const { fetchImpl, seen } = fakeFetch(200);
    const result = await checkProviderKey(
      { providerId: 'vault-cloud', secret: SECRET },
      { fetchImpl }
    );

    expect(result).toEqual({ ok: true });
    expect(seen[0].url).toBe('http://176.9.158.22:8000/v1/models');
    expect(seen[0].headers).toEqual({ Authorization: `Bearer ${SECRET}` });
  });

  it('still lets an explicit address win over the service’s own', async () => {
    const { fetchImpl, seen } = fakeFetch(200);
    await checkProviderKey(
      { providerId: 'vault-cloud', secret: SECRET, baseURL: 'http://192.0.2.10:9000/v1' },
      { fetchImpl }
    );
    expect(seen[0].url).toBe('http://192.0.2.10:9000/v1/models');
  });
});

describe('OPENCODE_DIRECT_PROVIDERS — the one list both sides read', () => {
  it('lists OpenAI, Anthropic and Vault Cloud, each with a wire id the env mapping knows', async () => {
    const { OPENCODE_DIRECT_PROVIDERS } = await import('@dorkos/shared/runtime-connect');
    expect(OPENCODE_DIRECT_PROVIDERS.map((entry) => entry.id)).toEqual([
      'openai',
      'anthropic',
      'vault-cloud',
    ]);
    // Every entry speaks a wire the sidecar env mapping already has a variable
    // for — that is what lets a new service be added with no server change.
    expect(new Set(OPENCODE_DIRECT_PROVIDERS.map((entry) => entry.wireId))).toEqual(
      new Set(['openai', 'anthropic'])
    );
    const vault = OPENCODE_DIRECT_PROVIDERS.find((entry) => entry.id === 'vault-cloud');
    expect(vault).toMatchObject({
      wireId: 'openai',
      label: 'Vault Cloud',
      defaultBaseURL: 'http://176.9.158.22:8000/v1',
    });
    // Plain http on purpose: the address serves no TLS at all, so an https
    // default would fail to connect rather than merely being slower.
    expect(vault?.defaultBaseURL.startsWith('http://')).toBe(true);
  });
});
