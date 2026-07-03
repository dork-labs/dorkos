/**
 * Credential env-injection resolver tests (ADR-0315, effortless-runtime-switching
 * T1 2.2). Verifies each runtime seam turns a stored REFERENCE into the correct
 * env var ONLY when configured, degrades honestly on a dangling reference
 * (`{}`, never a throw or a leaked secret), and never logs the secret.
 */
import { describe, it, expect, vi } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { CredentialProvider, CredentialResolution } from '../credential-provider.js';
import { resolveClaudeCredentialEnv, resolveOpenCodeProviderEnv } from '../credential-env.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: (err: unknown) => ({ error: String(err) }),
}));

const RESOLVED_SECRET = 'sk-resolved-secret-abc123';

/** A provider that resolves every reference to a fixed secret. */
function okProvider(secret = RESOLVED_SECRET): CredentialProvider {
  return { resolve: vi.fn(async (): Promise<CredentialResolution> => ({ ok: true, secret })) };
}

/** A provider that reports every reference as dangling. */
function danglingProvider(): CredentialProvider {
  return {
    resolve: vi.fn(
      async (ref: string): Promise<CredentialResolution> => ({
        ok: false,
        reason: 'unresolved',
        ref,
        message: 'dangling',
      })
    ),
  };
}

/** Build a structural config reader stub for the resolver's injected `config` param. */
function fakeConfig(overrides: {
  providers?: UserConfig['providers'];
  opencode?: Partial<UserConfig['runtimes']['opencode']>;
}) {
  const data: Record<string, unknown> = {
    providers: overrides.providers ?? {},
    runtimes: {
      default: 'claude-code',
      codex: { enabled: true, binaryPath: null, credentialRef: null },
      opencode: {
        enabled: true,
        binaryPath: null,
        port: 0,
        provider: null,
        baseURL: null,
        ...overrides.opencode,
      },
    },
  };
  // `never` is assignable to the resolver's non-exported ConfigReader param.
  return { get: (key: string) => data[key] } as never;
}

describe('resolveClaudeCredentialEnv', () => {
  it('injects ANTHROPIC_API_KEY when a Claude reference is configured', async () => {
    const provider = okProvider();
    const env = await resolveClaudeCredentialEnv(
      provider,
      fakeConfig({ providers: { anthropic: 'file:anthropic' } })
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: RESOLVED_SECRET });
    expect(provider.resolve).toHaveBeenCalledWith('file:anthropic');
  });

  it('injects nothing (and never calls the provider) when no reference is configured', async () => {
    const provider = okProvider();
    const env = await resolveClaudeCredentialEnv(provider, fakeConfig({ providers: {} }));
    expect(env).toEqual({});
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('degrades to {} on a dangling reference (never throws, never an empty-string secret)', async () => {
    const env = await resolveClaudeCredentialEnv(
      danglingProvider(),
      fakeConfig({ providers: { anthropic: 'file:anthropic' } })
    );
    expect(env).toEqual({});
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('resolveOpenCodeProviderEnv', () => {
  it('injects the mapped provider key when a provider is selected and configured', async () => {
    const provider = okProvider();
    const env = await resolveOpenCodeProviderEnv(
      provider,
      fakeConfig({
        providers: { openrouter: 'file:openrouter' },
        opencode: { provider: 'openrouter' },
      })
    );
    expect(env).toEqual({ OPENROUTER_API_KEY: RESOLVED_SECRET });
    expect(provider.resolve).toHaveBeenCalledWith('file:openrouter');
  });

  it('maps openai to OPENAI_API_KEY', async () => {
    const env = await resolveOpenCodeProviderEnv(
      okProvider(),
      fakeConfig({ providers: { openai: 'env:OPENAI_API_KEY' }, opencode: { provider: 'openai' } })
    );
    expect(env).toEqual({ OPENAI_API_KEY: RESOLVED_SECRET });
  });

  it('injects nothing when no provider is selected', async () => {
    const provider = okProvider();
    const env = await resolveOpenCodeProviderEnv(
      provider,
      fakeConfig({ opencode: { provider: null } })
    );
    expect(env).toEqual({});
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('injects OPENAI_BASE_URL when a custom base URL is configured', async () => {
    const env = await resolveOpenCodeProviderEnv(
      okProvider(),
      fakeConfig({
        providers: { openai: 'file:openai' },
        opencode: { provider: 'openai', baseURL: 'https://proxy.example/v1' },
      })
    );
    expect(env).toEqual({
      OPENAI_API_KEY: RESOLVED_SECRET,
      OPENAI_BASE_URL: 'https://proxy.example/v1',
    });
  });

  it('injects nothing for an unrecognized provider id (no guessed env var), without throwing', async () => {
    const provider = okProvider();
    const env = await resolveOpenCodeProviderEnv(
      provider,
      fakeConfig({ providers: { mystery: 'file:mystery' }, opencode: { provider: 'mystery' } })
    );
    expect(env).toEqual({});
    // No env var mapping exists, so the secret is never resolved for injection.
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('degrades to {} on a dangling provider reference', async () => {
    const env = await resolveOpenCodeProviderEnv(
      danglingProvider(),
      fakeConfig({
        providers: { openrouter: 'file:openrouter' },
        opencode: { provider: 'openrouter' },
      })
    );
    expect(env).toEqual({});
  });
});
