import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token-every-format.json' with { type: 'json' };
import { InferenceTokenSchema } from '@dork-labs/cloud-api';
import { describe, expect, it, vi } from 'vitest';
import type { InferenceModel } from '@dork-labs/cloud-api';
import { UserConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import {
  EncryptedFileCredentialStore,
  DefaultCredentialProvider,
} from '../../../core/credential-provider.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freezeDoeInference,
  inspectDoeInference,
  inspectDoeCreditsReady,
  resolveDoeInference,
} from '../credentials.js';
import type { ConfigReadWrite } from '../../connect/persist-provider-credential.js';
import { storeDoeCredential, doeCredentialId } from '../../connect/doe-credentials.js';

const inference: DoeInferenceConfig = {
  source: 'api-key',
  provider: 'openai',
  protocol: 'openai-chat-completions',
  endpoint: 'https://api.openai.com/v1',
  model: 'test-model',
  contextWindow: 8192,
  maxOutputTokens: 1024,
};
const model: InferenceModel = {
  id: 'test-model',
  displayName: 'Test',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  supports: { tools: true, promptCaching: false, streaming: true, thinking: false },
  protocols: ['openaiChat'],
};
function configFixture() {
  const state = UserConfigSchema.parse({ version: 1 });
  const config: ConfigReadWrite = {
    get: (key) => state[key],
    set: (key, value) => {
      state[key] = value;
    },
  };
  vi.spyOn(config, 'get');
  vi.spyOn(config, 'set');
  return config;
}

describe('DorkOS inference credential boundaries', () => {
  it('checks linked token, format and known model metadata without resolving or minting', () => {
    const config = { ...inference, source: 'dorkos-credits' as const };
    expect(
      inspectDoeInference(
        config,
        () => ({}),
        () => false
      )
    ).toEqual({ configured: false, source: 'dorkos-credits' });
    const token = InferenceTokenSchema.parse(tokenFixture);
    const ports = { linked: () => true, token: () => token, models: () => [model] };
    expect(inspectDoeCreditsReady(config, ports)).toBe(true);
    expect(inspectDoeCreditsReady(config, { ...ports, linked: () => false })).toBe(false);
    expect(inspectDoeCreditsReady(config, { ...ports, token: () => null })).toBe(false);
    expect(inspectDoeCreditsReady(config, { ...ports, models: () => [] })).toBe(false);
    expect(inspectDoeCreditsReady({ ...config, protocol: 'anthropic-messages' }, ports)).toBe(
      false
    );
  });
  it('does not resolve secrets during readiness, listing, or model assembly', async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ ok: true as const, secret: 'unit-test-key' })),
    };
    expect(
      inspectDoeInference(inference, () => ({
        [doeCredentialId(inference.endpoint)]: 'env:UNIT_TEST',
      }))
    ).toEqual({ configured: true, source: 'api-key' });
    const descriptor = await resolveDoeInference(inference, {
      credentials,
      providers: () => ({ [doeCredentialId(inference.endpoint)]: 'env:UNIT_TEST' }),
    });
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(descriptor.protocol).toBe('openai-completions');
    expect(await descriptor.credentials(new AbortController().signal)).toBe('unit-test-key');
    expect(credentials.resolve).toHaveBeenCalledTimes(1);
  });
  it('rejects subscription tokens before touching store or configuration', async () => {
    const store = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
    const config = configFixture();
    await expect(
      storeDoeCredential(inference, 'sk-ant-oat-test-only', { store, config })
    ).rejects.toThrow('subscription tokens');
    expect(store.put).not.toHaveBeenCalled();
    expect(config.get).not.toHaveBeenCalled();
  });
  it('keeps encrypted keys out of config and binds them to their endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doe-credentials-'));
    try {
      const store = new EncryptedFileCredentialStore(dir);
      const config = configFixture();
      const saved = await storeDoeCredential(inference, 'test-secret-never-public', {
        store,
        config,
      });
      expect(JSON.stringify(saved)).not.toContain('test-secret-never-public');
      expect(JSON.stringify(config.get('runtimes'))).not.toContain('test-secret-never-public');
      const descriptor = await resolveDoeInference(saved, {
        credentials: new DefaultCredentialProvider({ store, env: {} }),
      });
      expect(await descriptor.credentials(new AbortController().signal)).toBe(
        'test-secret-never-public'
      );
      await expect(
        resolveDoeInference({ ...saved, endpoint: 'https://example.com/v1' })
      ).rejects.toThrow('Save an API key');
      const ciphertext = await readFile(
        join(dir, 'extension-secrets', 'runtime-credentials.json'),
        'utf8'
      );
      expect(ciphertext).not.toContain('test-secret-never-public');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('never inherits a different endpoint key or leaks secret-bearing resolver failures', async () => {
    const descriptor = await resolveDoeInference(
      { ...inference, endpoint: 'https://example.com/v1' },
      { providers: () => ({ [doeCredentialId(inference.endpoint)]: 'env:UNIT_TEST' }) }
    );
    await expect(descriptor.credentials(new AbortController().signal)).rejects.toThrow(
      'Save an API key'
    );
    const failed = await resolveDoeInference(
      { ...inference, credentialRef: 'env:UNIT_TEST', credentialEndpoint: inference.endpoint },
      {
        credentials: {
          resolve: async () => {
            throw new Error('sensitive-key');
          },
        },
      }
    );
    await expect(failed.credentials(new AbortController().signal)).rejects.toThrow(
      'The saved API key is unavailable.'
    );
  });
  it('strictly keeps credits chosen by the existing ladder and refuses unknown models', async () => {
    const frozen = freezeDoeInference({
      config: {
        ...inference,
        credentialRef: 'env:UNIT_TEST',
        credentialEndpoint: inference.endpoint,
      },
      creditsChosen: true,
    });
    expect(frozen.source).toBe('dorkos-credits');
    expect(frozen.credentialRef).toBeUndefined();
    const credentials = { resolve: vi.fn() };
    const credits = vi.fn();
    await expect(
      resolveDoeInference(frozen, { credentials, credits, creditsModels: async () => [] })
    ).rejects.toMatchObject({ reason: 'no-models' });
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(credits).not.toHaveBeenCalled();
  });
  it('refreshes credits on every request using the explicitly selected format', async () => {
    const credits = vi.fn(async (protocol: DoeInferenceConfig['protocol']) => ({
      protocol,
      baseUrl: 'https://credits.example/v1',
      token: 'test-token',
      tokenId: 'one',
      expiresAt: '2099-01-01T00:00:00Z',
    }));
    for (const protocol of [
      'anthropic-messages',
      'openai-chat-completions',
      'openai-responses',
    ] as const) {
      const descriptor = await resolveDoeInference(
        { ...inference, source: 'dorkos-credits', protocol },
        { credits, creditsModels: async () => [model] }
      );
      expect(await descriptor.credentials(new AbortController().signal)).toBe('test-token');
      expect(credits).toHaveBeenLastCalledWith(protocol);
    }
  });
});
