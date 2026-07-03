import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { CredentialStore } from '../../../core/credential-provider.js';
import {
  storeRuntimeCredential,
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

  it('stores a Codex key, applies it via codex login, and sets runtimes.codex.credentialRef', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const applyCodex = vi.fn(async () => ({ ok: true }));
    const result = await storeRuntimeCredential('codex', SECRET, { store, config, applyCodex });

    expect(store.put).toHaveBeenCalledWith('codex', SECRET);
    expect(applyCodex).toHaveBeenCalledWith(SECRET);
    expect(config.state.runtimes?.codex.credentialRef).toBe('file:codex');
    expect(result).toEqual({ ref: 'file:codex' });
  });

  it('rolls back the reference and throws when the Codex apply fails (never records a dead ref)', async () => {
    const store = fakeStore();
    const config = fakeConfig();
    const applyCodex = vi.fn(async () => ({ ok: false, error: 'invalid key' }));

    await expect(
      storeRuntimeCredential('codex', SECRET, { store, config, applyCodex })
    ).rejects.toBeInstanceOf(ConnectError);

    expect(store.delete).toHaveBeenCalledWith('codex');
    // Config must NOT record a reference the CLI rejected.
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
