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

  it('caps local frontier-family models below frontier while cloud ones stay frontier', () => {
    const options = projectModelOptions(
      payload([
        { id: 'ollama', name: 'Ollama', models: [model('deepseek-r1:14b', 'DeepSeek-R1 14B')] },
        {
          id: 'openrouter',
          name: 'OpenRouter',
          models: [model('deepseek/deepseek-r1', 'DeepSeek R1')],
        },
      ])
    );

    const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
    // Local DeepSeek-R1 is demoted (14B → solid-coder) and marked local — frontier stays cloud-only.
    expect(byValue['ollama/deepseek-r1:14b'].tier).toBe('solid-coder');
    expect(byValue['ollama/deepseek-r1:14b'].local).toBe(true);
    // The same family via a cloud gateway keeps its frontier badge.
    expect(byValue['openrouter/deepseek/deepseek-r1'].tier).toBe('frontier');
    expect(byValue['openrouter/deepseek/deepseek-r1'].local).toBeUndefined();
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

describe('projectModelOptions — honest local availability (spec §10)', () => {
  it('offers only installed ollama tags, intersecting the catalog with /api/tags', () => {
    const options = projectModelOptions(
      payload([
        {
          id: 'ollama',
          name: 'Ollama',
          models: [
            model('qwen2.5-coder:7b', 'Qwen Coder 7B'),
            model('qwen2.5-coder:32b', 'Qwen Coder 32B'),
            model('llama3.3:70b', 'Llama 70B'),
          ],
        },
      ]),
      // Only the 7b tag is actually on disk.
      { installedOllamaTags: ['qwen2.5-coder:7b'] }
    );

    expect(options.map((o) => o.value)).toEqual(['ollama/qwen2.5-coder:7b']);
    // Catalog metadata wins on a tag match: the human name is kept.
    expect(options[0].displayName).toBe('Qwen Coder 7B');
    expect(options[0].local).toBe(true);
    expect(options[0].tier).toBe('quick-helper');
  });

  it('appends installed tags missing from the catalog as plain local options (custom pull)', () => {
    const options = projectModelOptions(
      payload([
        {
          id: 'ollama',
          name: 'Ollama',
          models: [model('qwen2.5-coder:7b', 'Qwen Coder 7B')],
        },
      ]),
      { installedOllamaTags: ['qwen2.5-coder:7b', 'my-finetune:latest'] }
    );

    const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
    // The uncatalogued tag is offered, displayName is the tag itself, marked local.
    expect(byValue['ollama/my-finetune:latest'].displayName).toBe('my-finetune:latest');
    expect(byValue['ollama/my-finetune:latest'].local).toBe(true);
    // Catalog model keeps its human name.
    expect(byValue['ollama/qwen2.5-coder:7b'].displayName).toBe('Qwen Coder 7B');
  });

  it('degrades to the full catalog when the tags probe is unavailable (null)', () => {
    const catalog = payload([
      {
        id: 'ollama',
        name: 'Ollama',
        models: [model('qwen2.5-coder:7b', 'Qwen Coder 7B'), model('llama3.3:70b', 'Llama 70B')],
      },
    ]);

    // null → do not filter: an optimistic full menu beats an empty one.
    expect(projectModelOptions(catalog, { installedOllamaTags: null }).map((o) => o.value)).toEqual(
      ['ollama/llama3.3:70b', 'ollama/qwen2.5-coder:7b']
    );
    // Omitting the input entirely is the same as null (backward compatible).
    expect(projectModelOptions(catalog).map((o) => o.value)).toEqual([
      'ollama/llama3.3:70b',
      'ollama/qwen2.5-coder:7b',
    ]);
  });

  it('leaves non-ollama providers untouched by the installed-tags filter', () => {
    const options = projectModelOptions(
      payload([
        { id: 'ollama', name: 'Ollama', models: [model('qwen2.5-coder:7b', 'Qwen Coder 7B')] },
        {
          id: 'openrouter',
          name: 'OpenRouter',
          models: [
            model('anthropic/claude-opus-4', 'Claude Opus 4'),
            model('openai/gpt-5', 'GPT-5'),
          ],
        },
      ]),
      // An empty installed list empties ollama but must not touch OpenRouter.
      { installedOllamaTags: [] }
    );

    const values = options.map((o) => o.value);
    expect(values).toContain('openrouter/anthropic/claude-opus-4');
    expect(values).toContain('openrouter/openai/gpt-5');
    expect(values.some((v) => v.startsWith('ollama/'))).toBe(false);
  });
});
