import { describe, expect, it } from 'vitest';
import { DoeInferenceConfigSchema, UserConfigSchema } from '../config-schema.js';
import { runtimeAuthConnectKind, runtimeDisplayName } from '../agent-runtime.js';
import { harnessForRuntime } from '../harness-schemas.js';

const local = {
  source: 'local',
  provider: 'ollama',
  protocol: 'openai-chat-completions',
  endpoint: 'http://127.0.0.1:11434/v1',
  model: 'custom',
  contextWindow: 8192,
  maxOutputTokens: 1024,
};
describe('DorkOS inference configuration', () => {
  it('adds an unconfigured runtime and preserves the existing default', () => {
    const settings = UserConfigSchema.parse({ version: 1 }).runtimes;
    expect(settings.default).toBe('claude-code');
    expect(settings.doe).toEqual({ enabled: true, inference: null, defaultTrustStop: null });
    expect(runtimeDisplayName('doe')).toBe('DorkOS');
    expect(runtimeAuthConnectKind('doe')).toBe('provider-picker');
    expect(harnessForRuntime('doe')).toBeUndefined();
  });
  it('round trips explicit model limits and every request format', () => {
    for (const protocol of ['anthropic-messages', 'openai-chat-completions', 'openai-responses']) {
      expect(DoeInferenceConfigSchema.parse({ ...local, protocol })).toEqual({
        ...local,
        protocol,
      });
    }
  });
  it('refuses remote local endpoints, embedded secrets and incoherent limits', () => {
    for (const patch of [
      { endpoint: 'https://localhost/v1' },
      { endpoint: 'http://example.com/v1' },
      { endpoint: 'malformed' },
      { endpoint: 'http://localhost/v1?api_key=secret' },
      { endpoint: 'http://secret:secret@localhost/v1' },
      { maxOutputTokens: 10000 },
      { apiKey: 'secret' },
      { credentialRef: 'env:OPENAI_API_KEY' },
    ]) {
      expect(DoeInferenceConfigSchema.safeParse({ ...local, ...patch }).success).toBe(false);
    }
  });
});
