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
  type ConfigReadWrite,
  type FetchFn,
} from '../openrouter.js';

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
      opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
      codex: { enabled: true, binaryPath: null, credentialRef: null },
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
