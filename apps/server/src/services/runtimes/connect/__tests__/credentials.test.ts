import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { UserConfig } from '@dorkos/shared/config-schema';
import {
  DefaultCredentialProvider,
  type CredentialStore,
} from '../../../core/credential-provider.js';
import { resolveOpenCodeProviderEnv } from '../../../core/credential-env.js';
import {
  storeRuntimeCredential,
  storeProviderCredential,
  applyCodexApiKey,
  ConnectError,
  type ConfigReadWrite,
} from '../credentials.js';
import type { SpawnFn } from '../delegated-login.js';

/** In-memory encrypted-store double: `put` returns a `file:<name>` reference. */
function fakeStore(): CredentialStore & {
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    put: vi.fn(async (name: string) => `file:${name}`),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
  };
}

/** Config double seeded with the schema-shaped sections the endpoints touch. */
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

const SECRET = 'sk-ant-secret-do-not-echo';

describe('storeRuntimeCredential', () => {
  it('stores a Claude key as a reference in providers.anthropic and never echoes the secret', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const result = await storeRuntimeCredential('claude-code', SECRET, { store, config });

    expect(store.put).toHaveBeenCalledWith('anthropic', SECRET);
    expect(config.state.providers).toEqual({ anthropic: 'file:anthropic' });
    expect(result).toEqual({ ref: 'file:anthropic' });
    // The reference — not the secret — is what surfaces.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('applies a Codex key via codex login and stores NOTHING at rest (ref: null)', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const applyCodex = vi.fn(async () => ({ ok: true }));
    const result = await storeRuntimeCredential('codex', SECRET, { store, config, applyCodex });

    expect(applyCodex).toHaveBeenCalledWith(SECRET);
    // The key lives in $CODEX_HOME/auth.json; DorkOS keeps no encrypted copy and
    // no config credentialRef (nothing reads one — `codex login status` is truth).
    expect(store.put).not.toHaveBeenCalled();
    expect(config.state.runtimes?.codex.credentialRef).toBeNull();
    expect(result).toEqual({ ref: null });
  });

  it('throws without touching the store or config when the Codex apply fails', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const applyCodex = vi.fn(async () => ({ ok: false, error: 'invalid key' }));

    await expect(
      storeRuntimeCredential('codex', SECRET, { store, config, applyCodex })
    ).rejects.toBeInstanceOf(ConnectError);

    // Nothing was stored, so there is nothing to roll back, and config is untouched.
    expect(store.put).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(config.state.runtimes?.codex.credentialRef).toBeNull();
  });

  it('rejects an unknown runtime type', async () => {
    await expect(
      storeRuntimeCredential('opencode', SECRET, { store: fakeStore(), config: fakeConfig() })
    ).rejects.toBeInstanceOf(ConnectError);
  });

  it('rejects an empty secret', async () => {
    await expect(
      storeRuntimeCredential('claude-code', '   ', { store: fakeStore(), config: fakeConfig() })
    ).rejects.toBeInstanceOf(ConnectError);
  });
});

describe('applyCodexApiKey', () => {
  it('reports not-available when the Codex CLI cannot be resolved', async () => {
    const result = await applyCodexApiKey(SECRET, { resolveCodexBinary: async () => null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Codex CLI/i);
  });

  it('pipes the key to `codex login --with-api-key` via stdin (never argv)', async () => {
    const child = new (class extends EventEmitter {
      stdin = { end: vi.fn() };
      stderr = new EventEmitter();
      kill = vi.fn();
    })();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    // resolveCodexBinary is async, so the spawn attaches its exit listener a tick
    // later — schedule the exit from the spawn so it never races ahead of it.
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    }) as unknown as SpawnFn;

    const result = await applyCodexApiKey(SECRET, {
      spawn,
      resolveCodexBinary: async () => '/bin/codex',
    });
    expect(result).toEqual({ ok: true });

    expect(calls[0]).toEqual({ cmd: '/bin/codex', args: ['login', '--with-api-key'] });
    expect(child.stdin.end).toHaveBeenCalledWith(SECRET);
    expect(calls[0].args.join(' ')).not.toContain(SECRET);
  });
});

describe('storeProviderCredential', () => {
  it('validates, stores the key by reference, and selects the provider (+ base URL)', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const result = await storeProviderCredential(
      { providerId: 'openai', secret: SECRET, baseURL: 'https://api.example.com/v1' },
      { store, config }
    );

    expect(store.put).toHaveBeenCalledWith('openai', SECRET);
    expect(config.state.providers).toEqual({ openai: 'file:openai' });
    expect(config.state.runtimes?.opencode.provider).toBe('openai');
    expect(config.state.runtimes?.opencode.baseURL).toBe('https://api.example.com/v1');
    expect(result).toEqual({ ref: 'file:openai' });
    // The reference — not the secret — is what surfaces.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('leaves baseURL untouched when omitted, and clears it when explicitly null', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    config.state.runtimes!.opencode.baseURL = 'https://stale.example.com';

    await storeProviderCredential({ providerId: 'openai', secret: SECRET }, { store, config });
    expect(config.state.runtimes?.opencode.baseURL).toBe('https://stale.example.com');

    await storeProviderCredential(
      { providerId: 'openai', secret: SECRET, baseURL: null },
      { store, config }
    );
    expect(config.state.runtimes?.opencode.baseURL).toBeNull();
  });

  it('rejects an empty provider id or empty secret without storing', async () => {
    const store = fakeStore();
    await expect(
      storeProviderCredential({ providerId: '  ', secret: SECRET }, { store, config: fakeConfig() })
    ).rejects.toBeInstanceOf(ConnectError);
    await expect(
      storeProviderCredential(
        { providerId: 'openai', secret: '  ' },
        { store, config: fakeConfig() }
      )
    ).rejects.toBeInstanceOf(ConnectError);
    expect(store.put).not.toHaveBeenCalled();
  });
});

describe('storeProviderCredential → resolveOpenCodeProviderEnv (end-to-end env seam)', () => {
  it('a Direct-provider connect is picked up as OPENAI_API_KEY + OPENAI_BASE_URL at the sidecar seam', async () => {
    // A real in-memory encrypted-store double so put()/get() round-trip.
    const secrets = new Map<string, string>();
    const store: CredentialStore = {
      put: async (name, secret) => {
        secrets.set(name, secret);
        return `file:${name}`;
      },
      get: async (name) => secrets.get(name) ?? null,
      delete: async (name) => {
        secrets.delete(name);
      },
    };
    const config = fakeConfig();

    await storeProviderCredential(
      { providerId: 'openai', secret: SECRET, baseURL: 'https://api.example.com/v1' },
      { store, config }
    );

    // The same store backs the read port that resolves the `file:` reference.
    const provider = new DefaultCredentialProvider({ store });
    const env = await resolveOpenCodeProviderEnv(provider, config);

    expect(env).toEqual({
      OPENAI_API_KEY: SECRET,
      OPENAI_BASE_URL: 'https://api.example.com/v1',
    });
  });
});
