import { describe, it, expect } from 'vitest';
import type { ProviderListResponse } from '@opencode-ai/sdk';
import { projectModelOptions } from '../models.js';

/** Build a provider-list model entry with just the fields projectModelOptions reads. */
function model(id: string, name: string, status?: 'deprecated') {
  return {
    id,
    name,
    ...(status ? { status } : {}),
    limit: { context: 128_000, output: 8_192 },
  };
}

/** Build a minimal ProviderListResponse for a set of providers → models. */
function payload(
  providers: Array<{ id: string; name: string; models: ReturnType<typeof model>[] }>,
  opts: { connected?: string[]; default?: Record<string, string> } = {}
): ProviderListResponse {
  return {
    all: providers.map((p) => ({
      id: p.id,
      name: p.name,
      env: [],
      models: Object.fromEntries(p.models.map((m) => [m.id, m])),
    })),
    default: opts.default ?? {},
    connected: opts.connected ?? providers.map((p) => p.id),
  } as unknown as ProviderListResponse;
}

describe('projectModelOptions', () => {
  it('tags tiers, marks Ollama models local, and returns picker order', () => {
    const options = projectModelOptions(
      payload(
        [
          {
            id: 'ollama',
            name: 'Ollama',
            models: [
              model('qwen2.5-coder:7b', 'Qwen Coder 7B'),
              model('llama3.3:70b', 'Llama 70B'),
            ],
          },
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: [model('claude-opus-4', 'Claude Opus 4')],
          },
        ],
        { default: { anthropic: 'claude-opus-4' } }
      )
    );

    // Frontier first, then solid coders, then quick helpers.
    expect(options.map((o) => o.value)).toEqual([
      'anthropic/claude-opus-4',
      'ollama/llama3.3:70b',
      'ollama/qwen2.5-coder:7b',
    ]);

    const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
    expect(byValue['anthropic/claude-opus-4'].tier).toBe('frontier');
    expect(byValue['ollama/llama3.3:70b'].tier).toBe('solid-coder');
    expect(byValue['ollama/qwen2.5-coder:7b'].tier).toBe('quick-helper');

    // Local marking follows the provider, not the tier.
    expect(byValue['ollama/llama3.3:70b'].local).toBe(true);
    expect(byValue['ollama/qwen2.5-coder:7b'].local).toBe(true);
    expect(byValue['anthropic/claude-opus-4'].local).toBeUndefined();
  });

  it('drops deprecated models and leaves untiered models untagged', () => {
    const options = projectModelOptions(
      payload([
        {
          id: 'custom',
          name: 'Custom',
          models: [model('mystery-model', 'Mystery'), model('old-model', 'Old', 'deprecated')],
        },
      ])
    );

    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('custom/mystery-model');
    expect(options[0].tier).toBeUndefined();
    expect(options[0].local).toBeUndefined();
  });
});
