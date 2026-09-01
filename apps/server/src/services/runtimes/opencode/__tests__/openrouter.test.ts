import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { CredentialStore } from '../../../core/credential-provider.js';
import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCodeForKey,
  validateOpenRouterKey,
  storeOpenRouterKeyReference,
  handleOpenRouterCallback,
  OpenRouterOAuthStore,
  OpenRouterError,
  fetchOpenRouterCatalog,
  resetOpenRouterCatalogCache,
  type ConfigReadWrite,
  type FetchFn,
} from '../providers/openrouter.js';

/** Build a fetch double resolving one canned Response. */
function resp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fakeStore(): CredentialStore & { put: ReturnType<typeof vi.fn> } {
  return {
    put: vi.fn(async (name: string) => `file:${name}`),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
  };
}

function fakeConfig(): ConfigReadWrite & { state: Partial<UserConfig> } {
  const state: Partial<UserConfig> = {
    providers: {},
    runtimes: {
      default: 'claude-code',
      defaultTrustStop: null,
      dorkosTools: false,
      claudeCode: {
        defaultAccount: null,
        accounts: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
        persistentSession: false,
      },
      opencode: {
        enabled: true,
        binaryPath: null,
        port: 0,
        provider: null,
        baseURL: null,
        defaultModel: null,
        defaultTrustStop: null,
      },
      codex: {
        enabled: true,
        binaryPath: null,
        credentialRef: null,
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
      },
    },
  };
  return {
    state,
    get: (<K extends keyof UserConfig>(k: K) => state[k]) as ConfigReadWrite['get'],
    set: (<K extends keyof UserConfig>(k: K, v: UserConfig[K]) => {
      state[k] = v;
    }) as ConfigReadWrite['set'],
  };
}

describe('generatePkce', () => {
  it('produces a 43-char verifier and an S256 challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toHaveLength(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the OpenRouter /auth URL with callback_url, challenge, and S256 method', () => {
    const url = new URL(buildAuthorizeUrl('http://127.0.0.1:4242/cb?state=abc', 'CHAL'));
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:4242/cb?state=abc');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('exchangeCodeForKey', () => {
  it('exchanges a code + verifier for a scoped key', async () => {
    const fetchImpl = vi.fn(async () =>
      resp(200, { key: 'sk-or-v1-scoped', user_id: 'user_1' })
    ) as unknown as FetchFn;
    const result = await exchangeCodeForKey({ code: 'auth_code', verifier: 'ver' }, { fetchImpl });

    expect(result).toEqual({ key: 'sk-or-v1-scoped', userId: 'user_1' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      code: 'auth_code',
      code_verifier: 'ver',
      code_challenge_method: 'S256',
    });
  });

  it('throws an honest error on a 403 (bad code / not signed in)', async () => {
    const fetchImpl = vi.fn(async () => resp(403, { error: 'invalid' })) as unknown as FetchFn;
    await expect(
      exchangeCodeForKey({ code: 'x', verifier: 'v' }, { fetchImpl })
    ).rejects.toBeInstanceOf(OpenRouterError);
  });

  it('throws when the response carries no key', async () => {
    const fetchImpl = vi.fn(async () => resp(200, {})) as unknown as FetchFn;
    await expect(
      exchangeCodeForKey({ code: 'x', verifier: 'v' }, { fetchImpl })
    ).rejects.toBeInstanceOf(OpenRouterError);
  });
});

describe('validateOpenRouterKey', () => {
  it('returns true for a live key (200) and sends a bearer header', async () => {
    const fetchImpl = vi.fn(async () => resp(200, { data: {} })) as unknown as FetchFn;
    await expect(validateOpenRouterKey('sk-or-live', { fetchImpl })).resolves.toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-live');
  });

  it('returns false for an invalid key (401)', async () => {
    const fetchImpl = vi.fn(async () => resp(401, {})) as unknown as FetchFn;
    await expect(validateOpenRouterKey('bad', { fetchImpl })).resolves.toBe(false);
  });
});

describe('storeOpenRouterKeyReference', () => {
  it('validates then stores a valid key as a reference and selects OpenRouter', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const fetchImpl = vi.fn(async () => resp(200, { data: {} })) as unknown as FetchFn;

    const result = await storeOpenRouterKeyReference('sk-or-valid', { store, config, fetchImpl });

    expect(store.put).toHaveBeenCalledWith('openrouter', 'sk-or-valid');
    expect(config.state.providers).toEqual({ openrouter: 'file:openrouter' });
    expect(config.state.runtimes?.opencode.provider).toBe('openrouter');
    expect(result).toEqual({ ref: 'file:openrouter' });
    expect(JSON.stringify(result)).not.toContain('sk-or-valid');
  });

  it('rejects an invalid key and stores nothing', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const fetchImpl = vi.fn(async () => resp(401, {})) as unknown as FetchFn;

    await expect(
      storeOpenRouterKeyReference('bad', { store, config, fetchImpl })
    ).rejects.toBeInstanceOf(OpenRouterError);
    expect(store.put).not.toHaveBeenCalled();
    expect(config.state.providers).toEqual({});
  });
});

describe('OpenRouterOAuthStore', () => {
  it('mints and claims a verifier by state, and rejects unknown state', () => {
    const store = new OpenRouterOAuthStore();
    const { state, challenge } = store.start();
    expect(challenge).toBeTruthy();
    expect(store.claimVerifier(state)).toBeTruthy();
    expect(store.claimVerifier('unknown')).toBeNull();
  });

  it('tracks connected and error status; unknown state reads as an error', () => {
    const store = new OpenRouterOAuthStore();
    const { state } = store.start();
    expect(store.status(state)).toEqual({ status: 'pending' });
    store.markConnected(state);
    expect(store.status(state)).toEqual({ status: 'connected' });
    expect(store.status('nope').status).toBe('error');
  });
});

describe('handleOpenRouterCallback', () => {
  it('exchanges and stores on a matching state + code (happy path)', async () => {
    const flowStore = new OpenRouterOAuthStore();
    const { state } = flowStore.start();
    const store = fakeStore();
    const config = fakeConfig();
    const fetchImpl = vi.fn(async () =>
      resp(200, { key: 'sk-or-scoped', user_id: 'u' })
    ) as unknown as FetchFn;

    const result = await handleOpenRouterCallback(
      { state, code: 'auth_code' },
      { flowStore, store, config, fetchImpl }
    );

    expect(result.status).toBe('connected');
    expect(store.put).toHaveBeenCalledWith('openrouter', 'sk-or-scoped');
    expect(flowStore.status(state)).toEqual({ status: 'connected' });
  });

  it('rejects a mismatched state and stores nothing', async () => {
    const flowStore = new OpenRouterOAuthStore();
    flowStore.start();
    const store = fakeStore();
    const fetchImpl = vi.fn() as unknown as FetchFn;

    const result = await handleOpenRouterCallback(
      { state: 'bogus', code: 'auth_code' },
      { flowStore, store, config: fakeConfig(), fetchImpl }
    );

    expect(result.status).toBe('error');
    expect(store.put).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an error on a denied authorization (no code), storing nothing', async () => {
    const flowStore = new OpenRouterOAuthStore();
    const { state } = flowStore.start();
    const store = fakeStore();

    const result = await handleOpenRouterCallback(
      { state, error: 'access_denied' },
      { flowStore, store, config: fakeConfig() }
    );

    expect(result.status).toBe('error');
    expect(store.put).not.toHaveBeenCalled();
    expect(flowStore.status(state).status).toBe('error');
  });

  it('is one-shot: a replayed callback with the same state does not re-exchange or re-store', async () => {
    const flowStore = new OpenRouterOAuthStore();
    const { state } = flowStore.start();
    const store = fakeStore();
    const config = fakeConfig();
    const fetchImpl = vi.fn(async () =>
      resp(200, { key: 'sk-or-scoped', user_id: 'u' })
    ) as unknown as FetchFn;

    const first = await handleOpenRouterCallback(
      { state, code: 'auth_code' },
      { flowStore, store, config, fetchImpl }
    );
    expect(first.status).toBe('connected');

    // Replaying the same state+code must be rejected — the verifier was consumed.
    const replay = await handleOpenRouterCallback(
      { state, code: 'auth_code' },
      { flowStore, store, config, fetchImpl }
    );
    expect(replay.status).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    // The original connected status is preserved (the replay never clobbered it).
    expect(flowStore.status(state)).toEqual({ status: 'connected' });
  });
});

describe('fetchOpenRouterCatalog (DOR-1660)', () => {
  beforeEach(() => resetOpenRouterCatalogCache());

  /**
   * One `GET /api/v1/models` row, shaped exactly like the live response
   * (verified live 2026-09-01: `data[].id`, `supported_parameters[]`,
   * `architecture.input_modalities` / `.output_modalities`).
   */
  function liveModel(
    id: string,
    opts: {
      tools?: boolean;
      input?: string[];
      output?: string[];
      /** Omit `supported_parameters` entirely — the renamed/dropped-field case. */
      omitParams?: boolean;
      /** Omit `architecture` entirely. */
      omitArchitecture?: boolean;
    } = {}
  ) {
    return {
      id,
      ...(opts.omitParams
        ? {}
        : {
            supported_parameters: opts.tools === false ? ['temperature'] : ['temperature', 'tools'],
          }),
      ...(opts.omitArchitecture
        ? {}
        : {
            architecture: {
              input_modalities: opts.input ?? ['text'],
              output_modalities: opts.output ?? ['text'],
            },
          }),
    };
  }

  it('reads tools, vision, and image output off the public catalog', async () => {
    const fetchImpl = vi.fn(async () =>
      resp(200, {
        data: [
          liveModel('anthropic/claude-opus-5', { input: ['text', 'image'] }),
          liveModel('google/gemini-3-pro-image', {
            input: ['text', 'image'],
            output: ['text', 'image'],
          }),
          liveModel('google/lyria-3-clip-preview', { tools: false, output: ['audio'] }),
        ],
      })
    ) as unknown as FetchFn;

    const catalog = await fetchOpenRouterCatalog({ fetchImpl });

    expect(catalog?.size).toBe(3);
    expect(catalog?.get('anthropic/claude-opus-5')).toEqual({
      supportsTools: true,
      supportsVision: true,
      supportsImageOutput: false,
    });
    expect(catalog?.get('google/gemini-3-pro-image')).toEqual({
      supportsTools: true,
      supportsVision: true,
      supportsImageOutput: true,
    });
    expect(catalog?.get('google/lyria-3-clip-preview')).toEqual({
      supportsTools: false,
      supportsVision: false,
      supportsImageOutput: false,
    });
    // No key is sent — this endpoint is public, and a credential-free probe
    // must never start depending on one.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit | undefined;
    expect(JSON.stringify(init?.headers ?? {})).not.toContain('Authorization');
  });

  it('serves a second call from the short-TTL cache instead of re-fetching', async () => {
    const fetchImpl = vi.fn(async () =>
      resp(200, { data: [liveModel('anthropic/claude-opus-5')] })
    ) as unknown as FetchFn;

    await fetchOpenRouterCatalog({ fetchImpl });
    await fetchOpenRouterCatalog({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      why: 'the request fails',
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    },
    { why: 'OpenRouter answers non-2xx', fetchImpl: vi.fn(async () => resp(503, {})) },
    {
      why: 'the body is unparseable',
      fetchImpl: vi.fn(
        async () => ({ ok: true, status: 200, json: async () => JSON.parse('nope') }) as unknown
      ),
    },
    { why: 'the list is empty', fetchImpl: vi.fn(async () => resp(200, { data: [] })) },
  ])('resolves null (unknown, never "nothing available") when $why', async ({ fetchImpl }) => {
    const catalog = await fetchOpenRouterCatalog({ fetchImpl: fetchImpl as unknown as FetchFn });
    expect(catalog).toBeNull();
  });

  // Failure caching (and its short window) is asserted in its own block below:
  // a failure is remembered briefly so the write path never re-pays a timeout,
  // then forgotten so a transient outage heals.

  it('skips rows with no usable id rather than failing the whole probe', async () => {
    const fetchImpl = vi.fn(async () =>
      resp(200, { data: [{ id: 42 }, { id: '' }, liveModel('anthropic/claude-opus-5')] })
    ) as unknown as FetchFn;

    const catalog = await fetchOpenRouterCatalog({ fetchImpl });
    expect([...(catalog?.keys() ?? [])]).toEqual(['anthropic/claude-opus-5']);
  });
});

describe('fetchOpenRouterCatalog — unknown is not "no" (DOR-1660)', () => {
  beforeEach(() => resetOpenRouterCatalogCache());

  /** As above, but reachable from this block. */
  function row(id: string, extra: Record<string, unknown> = {}) {
    return { id, ...extra };
  }

  it('leaves a capability unreported when OpenRouter does not report it', async () => {
    // The blast-radius case: if `supported_parameters` were renamed or dropped
    // upstream, collapsing its absence to `false` would mark EVERY OpenRouter
    // model unable to do agent work — a total menu wipe reported as a success.
    const fetchImpl = vi.fn(async () =>
      resp(200, {
        data: [
          row('anthropic/claude-opus-5', {
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          }),
        ],
      })
    ) as unknown as FetchFn;

    const catalog = await fetchOpenRouterCatalog({ fetchImpl });

    const entry = catalog?.get('anthropic/claude-opus-5');
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('supportsTools');
    expect(entry?.supportsTools).toBeUndefined();
    // The fields it DID report are still read.
    expect(entry?.supportsVision).toBe(false);
    expect(entry?.supportsImageOutput).toBe(false);
  });

  it('leaves modality answers unreported when architecture is missing', async () => {
    const fetchImpl = vi.fn(async () =>
      resp(200, { data: [row('anthropic/claude-opus-5', { supported_parameters: ['tools'] })] })
    ) as unknown as FetchFn;

    const entry = (await fetchOpenRouterCatalog({ fetchImpl }))?.get('anthropic/claude-opus-5');
    expect(entry?.supportsTools).toBe(true);
    expect(entry?.supportsVision).toBeUndefined();
    expect(entry?.supportsImageOutput).toBeUndefined();
  });

  it('reads a malformed (non-array) field as unreported, not as false', async () => {
    const fetchImpl = vi.fn(async () =>
      resp(200, {
        data: [
          row('anthropic/claude-opus-5', {
            supported_parameters: 'tools',
            architecture: { input_modalities: null, output_modalities: 42 },
          }),
        ],
      })
    ) as unknown as FetchFn;

    const entry = (await fetchOpenRouterCatalog({ fetchImpl }))?.get('anthropic/claude-opus-5');
    expect(entry?.supportsTools).toBeUndefined();
    expect(entry?.supportsVision).toBeUndefined();
    expect(entry?.supportsImageOutput).toBeUndefined();
  });
});

describe('fetchOpenRouterCatalog — a failed probe is not re-paid (DOR-1660)', () => {
  beforeEach(() => resetOpenRouterCatalogCache());

  it('caches a failure, so a write-path caller does not re-pay the timeout', async () => {
    // The whole point: this probe sits behind getSupportedModels(), which the
    // model-write path calls on every model change. An unreachable OpenRouter
    // must cost one timeout, not one per PATCH.
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchFn;

    expect(await fetchOpenRouterCatalog({ fetchImpl })).toBeNull();
    expect(await fetchOpenRouterCatalog({ fetchImpl })).toBeNull();
    expect(await fetchOpenRouterCatalog({ fetchImpl })).toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the short negative window has passed', async () => {
    vi.useFakeTimers();
    try {
      const failing = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as FetchFn;
      expect(await fetchOpenRouterCatalog({ fetchImpl: failing })).toBeNull();
      expect(await fetchOpenRouterCatalog({ fetchImpl: failing })).toBeNull();
      expect(failing).toHaveBeenCalledTimes(1);

      // Past the negative TTL a transient outage heals — the failure is
      // remembered briefly, never permanently.
      vi.advanceTimersByTime(15_001);
      const recovered = vi.fn(async () =>
        resp(200, {
          data: [{ id: 'anthropic/claude-opus-5', supported_parameters: ['tools'] }],
        })
      ) as unknown as FetchFn;
      expect((await fetchOpenRouterCatalog({ fetchImpl: recovered }))?.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the probe on its own tight bound, not the ten-second auth bound', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const hanging = vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as FetchFn;

      const pending = fetchOpenRouterCatalog({ fetchImpl: hanging });
      // Still in flight at the Ollama-style short end...
      await vi.advanceTimersByTimeAsync(3_999);
      expect(signal?.aborted).toBe(false);
      // ...and given up on well before the 10s the auth calls are allowed.
      await vi.advanceTimersByTimeAsync(2);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the abort signal armed through the body read', async () => {
    // A ~700KB body that stalls mid-stream is as much of a hang as a stalled
    // connection; releasing the timer at headers would fall through to undici's
    // multi-minute default.
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const stallingBody = vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        } as unknown as Response);
      }) as unknown as FetchFn;

      const pending = fetchOpenRouterCatalog({ fetchImpl: stallingBody });
      await vi.advanceTimersByTimeAsync(4_001);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
