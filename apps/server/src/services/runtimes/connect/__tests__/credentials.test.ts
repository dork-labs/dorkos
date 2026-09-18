import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { UserConfig } from '@dorkos/shared/config-schema';
import {
  DefaultCredentialProvider,
  type CredentialProvider,
  type CredentialStore,
} from '../../../core/credential-provider.js';
import { resolveOpenCodeProviderEnv } from '../../../core/credential-env.js';
import {
  storeRuntimeCredential,
  storeProviderCredential,
  checkProviderCredential,
  checkRuntimeCredential,
  readOpenCodeDirectSetup,
  readRuntimeKeyStatus,
  applyCodexApiKey,
} from '../credentials.js';
import { ConnectError } from '../connect-error.js';
import type { ConfigReadWrite } from '../persist-provider-credential.js';
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
      environment: { inherit: { claudeCode: [], codex: [], opencode: [] } },
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

const SECRET = 'sk-ant-secret-do-not-echo';

/**
 * A key check that always accepts. Injected everywhere a test is about STORAGE
 * rather than the check itself, so no unit test reaches the network — and so the
 * tests that DO pin the refusal are unmistakable.
 */
const acceptEverything = () => Promise.resolve({ ok: true as const });

/**
 * A key check that always refuses, with the plain-language line the form shows.
 */
const refuseEverything = () =>
  Promise.resolve({
    ok: false as const,
    reason: 'rejected' as const,
    message: 'That key was not accepted. Check it and try again.',
  });

/** A credential read port over a fixed `ref → secret` map. */
function fakeCredentials(secrets: Record<string, string>): CredentialProvider {
  return {
    resolve: async (ref: string) =>
      ref in secrets
        ? { ok: true as const, secret: secrets[ref] }
        : {
            ok: false as const,
            reason: 'unresolved' as const,
            ref,
            message: 'No secret is stored for that reference.',
          },
  };
}

describe('storeRuntimeCredential', () => {
  it('stores a Claude key as a reference in providers.anthropic and never echoes the secret', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const result = await storeRuntimeCredential('claude-code', SECRET, {
      store,
      config,
      checkKey: acceptEverything,
    });

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
    const result = await storeRuntimeCredential('codex', SECRET, {
      store,
      config,
      applyCodex,
      checkKey: acceptEverything,
    });

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
      storeRuntimeCredential('codex', SECRET, {
        store,
        config,
        applyCodex,
        checkKey: acceptEverything,
      })
    ).rejects.toBeInstanceOf(ConnectError);

    // Nothing was stored, so there is nothing to roll back, and config is untouched.
    expect(store.put).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(config.state.runtimes?.codex.credentialRef).toBeNull();
  });

  it('rejects an unknown runtime type', async () => {
    await expect(
      storeRuntimeCredential('opencode', SECRET, {
        store: fakeStore(),
        config: fakeConfig(),
        checkKey: acceptEverything,
      })
    ).rejects.toBeInstanceOf(ConnectError);
  });

  it('rejects an empty secret', async () => {
    await expect(
      storeRuntimeCredential('claude-code', '   ', {
        store: fakeStore(),
        config: fakeConfig(),
        checkKey: acceptEverything,
      })
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
      { store, config, checkKey: acceptEverything }
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

    await storeProviderCredential(
      { providerId: 'openai', secret: SECRET },
      { store, config, checkKey: acceptEverything }
    );
    expect(config.state.runtimes?.opencode.baseURL).toBe('https://stale.example.com');

    await storeProviderCredential(
      { providerId: 'openai', secret: SECRET, baseURL: null },
      { store, config, checkKey: acceptEverything }
    );
    expect(config.state.runtimes?.opencode.baseURL).toBeNull();
  });

  it('recycles the OpenCode sidecar so a first-ever credential reaches it', async () => {
    // A sidecar already running when the key is stored holds the old (keyless)
    // env; storing must trigger a reboot so the next use picks up the new key.
    const store = fakeStore();
    const config = fakeConfig();
    const recycleSidecar = vi.fn(async () => {});

    await storeProviderCredential(
      { providerId: 'openrouter', secret: SECRET },
      { store, config, recycleSidecar, checkKey: acceptEverything }
    );

    expect(recycleSidecar).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty provider id or empty secret without storing', async () => {
    const store = fakeStore();
    await expect(
      storeProviderCredential(
        { providerId: '  ', secret: SECRET },
        { store, config: fakeConfig(), checkKey: acceptEverything }
      )
    ).rejects.toBeInstanceOf(ConnectError);
    await expect(
      storeProviderCredential(
        { providerId: 'openai', secret: '  ' },
        { store, config: fakeConfig(), checkKey: acceptEverything }
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
      { store, config, checkKey: acceptEverything }
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

describe('the key is checked BEFORE anything is saved (DOR-2123)', () => {
  it('refuses to store a runtime key the service will not accept, and writes nothing', async () => {
    const store = fakeStore();
    const config = fakeConfig();

    await expect(
      storeRuntimeCredential('claude-code', SECRET, {
        store,
        config,
        checkKey: refuseEverything,
      })
    ).rejects.toThrow('That key was not accepted. Check it and try again.');

    expect(store.put).not.toHaveBeenCalled();
    expect(config.state.providers).toEqual({});
  });

  it('refuses to store a provider key the service will not accept, and writes nothing', async () => {
    const store = fakeStore();
    const config = fakeConfig();

    await expect(
      storeProviderCredential(
        { providerId: 'openai', secret: SECRET, baseURL: 'https://api.example.com/v1' },
        { store, config, checkKey: refuseEverything }
      )
    ).rejects.toBeInstanceOf(ConnectError);

    expect(store.put).not.toHaveBeenCalled();
    expect(config.state.providers).toEqual({});
    expect(config.state.runtimes?.opencode.provider).toBeNull();
    expect(config.state.runtimes?.opencode.baseURL).toBeNull();
  });

  it('checks the key against the base URL being saved, not the one already stored', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const checkKey = vi.fn(acceptEverything);

    await storeProviderCredential(
      { providerId: 'openai', secret: SECRET, baseURL: 'https://new.example.com/v1' },
      { store, config, checkKey }
    );

    expect(checkKey).toHaveBeenCalledWith({
      providerId: 'openai',
      secret: SECRET,
      baseURL: 'https://new.example.com/v1',
    });
  });

  // Listed AND unlisted: the trim has to happen before anything branches on
  // whether the list serves this id, or an id headed for a refusal could write
  // `"   "` into the stored address on its way there.
  it.each(['openai', 'openrouter'])(
    'stores a blank base URL as no override rather than as an empty address (%s)',
    async (providerId) => {
      const store = fakeStore();
      const config = fakeConfig();
      config.state.runtimes!.opencode.baseURL = 'https://stale.example.com';

      await storeProviderCredential(
        { providerId, secret: SECRET, baseURL: '   ' },
        { store, config, checkKey: acceptEverything }
      );

      expect(config.state.runtimes?.opencode.baseURL).toBeNull();
      expect(config.state.runtimes?.opencode.provider).toBe(providerId);
    }
  );
});

describe('a saved key only ever goes to the address it is saved for', () => {
  it('IGNORES a caller-named address and checks the saved key at the stored one', async () => {
    // The exfiltration shape this refuses: name any address, send no key, and
    // have DorkOS deliver the key it already holds to the address you named.
    const store = fakeStore();
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };
    config.state.runtimes!.opencode.provider = 'openai';
    config.state.runtimes!.opencode.baseURL = 'https://api.example.com/v1';
    const checkKey = vi.fn(acceptEverything);

    await storeProviderCredential(
      { providerId: 'openai', secret: '', baseURL: 'https://attacker.example.com/v1' },
      { store, config, checkKey, credentials: fakeCredentials({ 'file:openai': SECRET }) }
    );

    // The stored address, never the requested one.
    expect(checkKey).toHaveBeenCalledWith({
      providerId: 'openai',
      secret: SECRET,
      baseURL: 'https://api.example.com/v1',
    });
    expect(config.state.runtimes?.opencode.baseURL).toBe('https://api.example.com/v1');
    // And the key was kept rather than re-encrypted under a new reference.
    expect(store.put).not.toHaveBeenCalled();
  });

  it('does the same on the Test path, which would otherwise be the same hole', async () => {
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };
    config.state.runtimes!.opencode.provider = 'openai';
    config.state.runtimes!.opencode.baseURL = 'https://api.example.com/v1';
    const checkKey = vi.fn(acceptEverything);

    await checkProviderCredential(
      { providerId: 'openai', secret: null, baseURL: 'https://attacker.example.com/v1' },
      { config, checkKey, credentials: fakeCredentials({ 'file:openai': SECRET }) }
    );

    expect(checkKey).toHaveBeenCalledWith({
      providerId: 'openai',
      secret: SECRET,
      baseURL: 'https://api.example.com/v1',
    });
  });

  it('honours a caller-named address once the key is actually pasted', async () => {
    // Pasting the key is the person's own deliberate act, so the address they
    // name with it is theirs to name. That is what makes the rule above a
    // speed bump for a person and a wall for anyone else.
    const store = fakeStore();
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };
    config.state.runtimes!.opencode.provider = 'openai';
    config.state.runtimes!.opencode.baseURL = 'https://api.example.com/v1';
    const checkKey = vi.fn(acceptEverything);

    await storeProviderCredential(
      {
        providerId: 'openai',
        secret: 'sk-freshly-pasted',
        baseURL: 'https://moved.example.com/v1',
      },
      { store, config, checkKey, credentials: fakeCredentials({ 'file:openai': SECRET }) }
    );

    expect(checkKey).toHaveBeenCalledWith({
      providerId: 'openai',
      secret: 'sk-freshly-pasted',
      baseURL: 'https://moved.example.com/v1',
    });
    expect(config.state.runtimes?.opencode.baseURL).toBe('https://moved.example.com/v1');
  });

  it('does not inherit another service’s address when switching with a saved key', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    config.state.providers = { anthropic: 'file:anthropic' };
    config.state.runtimes!.opencode.provider = 'openai';
    config.state.runtimes!.opencode.baseURL = 'https://api.example.com/v1';
    const checkKey = vi.fn(acceptEverything);

    await storeProviderCredential(
      { providerId: 'anthropic', secret: '' },
      { store, config, checkKey, credentials: fakeCredentials({ 'file:anthropic': SECRET }) }
    );

    // The stored address belonged to OpenAI, so Anthropic gets none of it.
    expect(checkKey).toHaveBeenCalledWith({
      providerId: 'anthropic',
      secret: SECRET,
      baseURL: null,
    });
    expect(config.state.runtimes?.opencode.baseURL).toBeNull();
  });

  it('saves nothing when the saved key no longer works', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };

    await expect(
      storeProviderCredential(
        { providerId: 'openai', secret: '' },
        {
          store,
          config,
          checkKey: refuseEverything,
          credentials: fakeCredentials({ 'file:openai': SECRET }),
        }
      )
    ).rejects.toBeInstanceOf(ConnectError);

    expect(config.state.runtimes?.opencode.provider).toBeNull();
  });

  it('still refuses an empty key when nothing is saved for that service', async () => {
    const store = fakeStore();
    await expect(
      storeProviderCredential(
        { providerId: 'openai', secret: '' },
        {
          store,
          config: fakeConfig(),
          checkKey: acceptEverything,
          credentials: fakeCredentials({}),
        }
      )
    ).rejects.toThrow('A non-empty API key is required.');
    expect(store.put).not.toHaveBeenCalled();
  });
});

describe('checkProviderCredential / checkRuntimeCredential (the Test button)', () => {
  it('tries a typed key and saves nothing', async () => {
    const store = fakeStore();
    const config = fakeConfig();

    const result = await checkProviderCredential(
      { providerId: 'openai', secret: SECRET, baseURL: null },
      { store, config, checkKey: acceptEverything }
    );

    expect(result).toEqual({ ok: true });
    expect(store.put).not.toHaveBeenCalled();
    expect(config.state.runtimes?.opencode.provider).toBeNull();
  });

  it('tries the SAVED key when the key field is empty', async () => {
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };
    const checkKey = vi.fn(acceptEverything);

    await checkProviderCredential(
      { providerId: 'openai', secret: null },
      { config, checkKey, credentials: fakeCredentials({ 'file:openai': SECRET }) }
    );

    expect(checkKey).toHaveBeenCalledWith({
      providerId: 'openai',
      secret: SECRET,
      baseURL: null,
    });
  });

  it('asks for a key when there is nothing typed and nothing saved', async () => {
    await expect(
      checkProviderCredential(
        { providerId: 'openai', secret: null },
        { config: fakeConfig(), checkKey: acceptEverything, credentials: fakeCredentials({}) }
      )
    ).rejects.toThrow('Paste the key to check it.');
  });

  it('tries Claude Code’s saved key, and asks Codex for a pasted one', async () => {
    const config = fakeConfig();
    config.state.providers = { anthropic: 'file:anthropic' };
    const credentials = fakeCredentials({ 'file:anthropic': SECRET });
    const checkKey = vi.fn(() => Promise.resolve({ ok: true as const }));

    await expect(
      checkRuntimeCredential('claude-code', null, { config, credentials, checkKey })
    ).resolves.toEqual({ ok: true });
    expect(checkKey).toHaveBeenCalledWith('claude-code', SECRET);

    // Codex's key lives in Codex's own login store, so DorkOS holds no copy to try.
    await expect(
      checkRuntimeCredential('codex', null, { config, credentials, checkKey })
    ).rejects.toThrow('Paste the key to check it.');
  });

  it('refuses a runtime with no key of its own', async () => {
    await expect(checkRuntimeCredential('opencode', SECRET)).rejects.toBeInstanceOf(ConnectError);
  });
});

describe('reading back what is saved (the form remembers)', () => {
  it('reports the saved service, base URL, and the last FOUR characters of the key', async () => {
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };
    config.state.runtimes!.opencode.provider = 'openai';
    config.state.runtimes!.opencode.baseURL = 'https://api.example.com/v1';

    const setup = await readOpenCodeDirectSetup({
      config,
      credentials: fakeCredentials({ 'file:openai': SECRET }),
    });

    expect(setup).toEqual({
      providerId: 'openai',
      baseURL: 'https://api.example.com/v1',
      key: { saved: true, last4: SECRET.slice(-4) },
    });
    // Everything BUT the last four characters stays on the server.
    expect(JSON.stringify(setup)).not.toContain(SECRET);
  });

  it('reports nothing saved when no service has been chosen', async () => {
    const setup = await readOpenCodeDirectSetup({
      config: fakeConfig(),
      credentials: fakeCredentials({}),
    });
    expect(setup).toEqual({ providerId: null, baseURL: null, key: { saved: false } });
  });

  it('reports nothing saved when the stored reference no longer resolves', async () => {
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };
    config.state.runtimes!.opencode.provider = 'openai';

    const setup = await readOpenCodeDirectSetup({ config, credentials: fakeCredentials({}) });
    expect(setup.key).toEqual({ saved: false });
  });

  it('reports Claude Code’s saved key by its last four, and Codex as never saved', async () => {
    const config = fakeConfig();
    config.state.providers = { anthropic: 'file:anthropic' };
    const credentials = fakeCredentials({ 'file:anthropic': SECRET });

    await expect(readRuntimeKeyStatus('claude-code', { config, credentials })).resolves.toEqual({
      key: { saved: true, last4: SECRET.slice(-4) },
    });
    // Codex's key is written to $CODEX_HOME/auth.json and DorkOS keeps no copy,
    // so "not saved" is the truth here, not a gap.
    await expect(readRuntimeKeyStatus('codex', { config, credentials })).resolves.toEqual({
      key: { saved: false },
    });
  });

  it('refuses a runtime with no native key path', async () => {
    await expect(readRuntimeKeyStatus('opencode')).rejects.toBeInstanceOf(ConnectError);
  });
});

describe('the real check runs on a save, not just an injected stand-in', () => {
  it('refuses to store a key the service itself turns down, with only fetch stubbed', async () => {
    // Every other test here injects `checkKey`, which proves the wiring but not
    // the check. This one drives the GENUINE checker and stubs only the network,
    // so a stub that happened to agree with the test cannot carry the assertion.
    const store = fakeStore();
    const config = fakeConfig();
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 })
    ) as unknown as typeof fetch;

    await expect(
      storeProviderCredential(
        { providerId: 'openai', secret: SECRET },
        { store, config, fetchImpl }
      )
    ).rejects.toThrow('That key was not accepted. Check it and try again.');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.put).not.toHaveBeenCalled();
    expect(config.state.providers).toEqual({});
    expect(config.state.runtimes?.opencode.provider).toBeNull();
  });

  it('stores it when the genuine check passes', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const fetchImpl = vi.fn(
      async () => new Response('{"data":[]}', { status: 200 })
    ) as unknown as typeof fetch;

    await storeProviderCredential(
      { providerId: 'openai', secret: SECRET },
      { store, config, fetchImpl }
    );

    expect(store.put).toHaveBeenCalledWith('openai', SECRET);
    expect(config.state.runtimes?.opencode.provider).toBe('openai');
  });

  it('runs the genuine check on a runtime key too', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 })
    ) as unknown as typeof fetch;

    await expect(
      storeRuntimeCredential('claude-code', SECRET, { store, config, fetchImpl })
    ).rejects.toThrow('That key was not accepted. Check it and try again.');

    expect(store.put).not.toHaveBeenCalled();
    expect(config.state.providers).toEqual({});
  });
});

describe('the last-4 hint never becomes the whole key', () => {
  it('reports a short key as saved with no hint at all', async () => {
    const config = fakeConfig();
    config.state.providers = { openai: 'file:openai' };
    config.state.runtimes!.opencode.provider = 'openai';

    // Exactly four characters: "the last four" would BE the key.
    const setup = await readOpenCodeDirectSetup({
      config,
      credentials: fakeCredentials({ 'file:openai': 'abcd' }),
    });
    expect(setup.key).toEqual({ saved: true, last4: '' });

    const longer = await readOpenCodeDirectSetup({
      config,
      credentials: fakeCredentials({ 'file:openai': 'abcde' }),
    });
    expect(longer.key).toEqual({ saved: true, last4: 'bcde' });
  });
});
