import { describe, it, expect } from 'vitest';
import type { ProviderListResponse } from '@opencode-ai/sdk';
import { projectModelOptions, projectedProviderIds } from '../providers/models.js';
import type { OpenRouterCatalog } from '../providers/openrouter.js';

/** Build a live-OpenRouter catalog from `id -> [tools, vision, imageOutput]`. */
function liveCatalog(entries: Record<string, [boolean, boolean, boolean]>): OpenRouterCatalog {
  return new Map(
    Object.entries(entries).map(([id, [tools, vision, image]]) => [
      id,
      { supportsTools: tools, supportsVision: vision, supportsImageOutput: image },
    ])
  );
}

/** Build a live catalog whose entries report NOTHING (every field unreported). */
function silentLiveCatalog(ids: string[]): OpenRouterCatalog {
  return new Map(ids.map((id) => [id, {}]));
}

/** Capability fields a provider-list model entry may carry (all optional here). */
interface ModelCaps {
  tool_call?: boolean;
  modalities?: { input: string[]; output: string[] };
}

/**
 * Build a provider-list model entry with just the fields projectModelOptions
 * reads. Capabilities are omitted by default on purpose — plenty of models.dev
 * rows carry none, and "not reported" must never read as "cannot".
 */
function model(id: string, name: string, status?: 'deprecated', caps: ModelCaps = {}) {
  return {
    id,
    name,
    ...(status ? { status } : {}),
    ...caps,
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

describe('projectModelOptions — honest capabilities (DOR-1660)', () => {
  it('reports what a model can do, and never drops one for being limited', () => {
    const options = projectModelOptions(
      payload([
        {
          id: 'openrouter',
          name: 'OpenRouter',
          models: [
            model('google/lyria-3-clip-preview', 'Lyria 3', undefined, {
              tool_call: false,
              modalities: { input: ['text'], output: ['audio'] },
            }),
            model('google/gemini-3-pro-image', 'Gemini 3 Pro Image', undefined, {
              tool_call: true,
              modalities: { input: ['text', 'image'], output: ['text', 'image'] },
            }),
            model('anthropic/claude-opus-5', 'Claude Opus 5', undefined, {
              tool_call: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
            }),
          ],
        },
      ])
    );

    // Badge, do not hide: every model is still offered.
    expect(options.map((o) => o.value).sort()).toEqual(
      ['anthropic/claude-opus-5', 'google/gemini-3-pro-image', 'google/lyria-3-clip-preview'].map(
        (id) => `openrouter/${id}`
      )
    );

    const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
    // A model that cannot call a tool says so, so the picker can group it apart.
    expect(byValue['openrouter/google/lyria-3-clip-preview'].supportsToolUse).toBe(false);
    expect(byValue['openrouter/google/lyria-3-clip-preview'].supportsImageOutput).toBe(false);
    // The operator's real failing case: tool-capable, but it answers with images.
    expect(byValue['openrouter/google/gemini-3-pro-image'].supportsToolUse).toBe(true);
    expect(byValue['openrouter/google/gemini-3-pro-image'].supportsImageOutput).toBe(true);
    expect(byValue['openrouter/google/gemini-3-pro-image'].supportsVision).toBe(true);
    // An ordinary coding model reads as capable with no image output.
    expect(byValue['openrouter/anthropic/claude-opus-5'].supportsToolUse).toBe(true);
    expect(byValue['openrouter/anthropic/claude-opus-5'].supportsImageOutput).toBe(false);
    expect(byValue['openrouter/anthropic/claude-opus-5'].supportsVision).toBe(true);
  });

  it('leaves capabilities unreported when the catalog does not report them', () => {
    const options = projectModelOptions(
      payload([{ id: 'custom', name: 'Custom', models: [model('mystery', 'Mystery')] }])
    );

    // Absent, not false: an unknown model must not be demoted to "cannot".
    expect(options[0].supportsToolUse).toBeUndefined();
    expect(options[0].supportsVision).toBeUndefined();
    expect(options[0].supportsImageOutput).toBeUndefined();
  });

  it('reports capabilities for local ollama models too', () => {
    const options = projectModelOptions(
      payload([
        {
          id: 'ollama',
          name: 'Ollama',
          models: [
            model('qwen2.5-coder:7b', 'Qwen Coder 7B', undefined, {
              tool_call: true,
              modalities: { input: ['text'], output: ['text'] },
            }),
          ],
        },
      ])
    );

    expect(options[0].supportsToolUse).toBe(true);
    expect(options[0].supportsVision).toBe(false);
  });
});

describe('projectModelOptions — live OpenRouter intersection (DOR-1660)', () => {
  const catalog = payload([
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [
        model('anthropic/claude-opus-5', 'Claude Opus 5', undefined, { tool_call: true }),
        // models.dev lists this; OpenRouter serves zero endpoints for it.
        model('anthropic/claude-opus-5-fast', 'Claude Opus 5 Fast', undefined, {
          tool_call: true,
        }),
      ],
    },
    { id: 'ollama', name: 'Ollama', models: [model('llama3.3:70b', 'Llama 70B')] },
  ]);

  it('drops models OpenRouter no longer serves and takes capabilities from the live entry', () => {
    const options = projectModelOptions(catalog, {
      openRouterCatalog: liveCatalog({ 'anthropic/claude-opus-5': [false, true, true] }),
      installedOllamaTags: null,
    });

    const values = options.map((o) => o.value);
    // The phantom id is gone — it cannot work, so offering it can only fail.
    expect(values).not.toContain('openrouter/anthropic/claude-opus-5-fast');
    expect(values).toContain('openrouter/anthropic/claude-opus-5');

    // Live truth overrules the sidecar's stale `tool_call: true`.
    const live = options.find((o) => o.value === 'openrouter/anthropic/claude-opus-5')!;
    expect(live.supportsToolUse).toBe(false);
    expect(live.supportsVision).toBe(true);
    expect(live.supportsImageOutput).toBe(true);
  });

  it('degrades to the full catalog when the OpenRouter probe is unavailable (null)', () => {
    // null → do not filter: an optimistic full menu beats an empty one.
    const degraded = projectModelOptions(catalog, { openRouterCatalog: null });
    expect(degraded.map((o) => o.value)).toContain('openrouter/anthropic/claude-opus-5-fast');
    // Sidecar metadata still stands when the live probe could not answer.
    expect(
      degraded.find((o) => o.value === 'openrouter/anthropic/claude-opus-5')!.supportsToolUse
    ).toBe(true);

    // Omitting the input entirely is the same as null (backward compatible).
    expect(projectModelOptions(catalog).map((o) => o.value)).toEqual(degraded.map((o) => o.value));
  });

  it('leaves non-openrouter providers untouched by the live filter', () => {
    // A live catalog that knows one of the two openrouter ids is above the
    // coverage floor, so it filters — and must not touch Ollama either way.
    const options = projectModelOptions(catalog, {
      openRouterCatalog: liveCatalog({ 'anthropic/claude-opus-5': [true, false, false] }),
      installedOllamaTags: null,
    });

    const values = options.map((o) => o.value);
    expect(values).toContain('ollama/llama3.3:70b');
    expect(values).toContain('openrouter/anthropic/claude-opus-5');
    expect(values).not.toContain('openrouter/anthropic/claude-opus-5-fast');
  });

  it('distrusts a live catalog that recognises none of the provider ids', () => {
    // Zero coverage is a broken answer, not "OpenRouter dropped everything" —
    // obeying it would empty the provider while reporting success.
    const options = projectModelOptions(catalog, { openRouterCatalog: liveCatalog({}) });

    const values = options.map((o) => o.value);
    expect(values).toContain('openrouter/anthropic/claude-opus-5');
    expect(values).toContain('openrouter/anthropic/claude-opus-5-fast');
  });
});

describe('projectModelOptions — bounded unverified fallback (DOR-1660)', () => {
  /** A provider whose models are all untiered, so they sort into the tail. */
  function bulkProvider(id: string, count: number) {
    return {
      id,
      name: id,
      models: Array.from({ length: count }, (_, i) =>
        model(`${id}-model-${String(i).padStart(4, '0')}`, `${id} model ${i}`)
      ),
    };
  }

  it('caps the menu when OpenCode reports no connected provider', () => {
    const options = projectModelOptions(
      payload([bulkProvider('alpha', 300), bulkProvider('beta', 300)], { connected: [] })
    );

    // 600 offered, bounded to the documented limit — an unverified menu is
    // still optimistic, but it can no longer be thousands of rows long.
    expect(options).toHaveLength(200);
  });

  it('keeps the provider default inside the cap so the picker still has one', () => {
    const options = projectModelOptions(
      payload([bulkProvider('zulu', 400)], {
        connected: [],
        // Sorts last alphabetically among 400 untiered rows, so a blind slice
        // would drop it.
        default: { zulu: 'zulu-model-0399' },
      })
    );

    expect(options).toHaveLength(200);
    const defaults = options.filter((o) => o.isDefault);
    expect(defaults.map((o) => o.value)).toEqual(['zulu/zulu-model-0399']);
  });

  it('never caps a menu built from genuinely connected providers', () => {
    const options = projectModelOptions(
      payload([bulkProvider('alpha', 300)], { connected: ['alpha'] })
    );

    // Connected means verified: the person really does have 300 models.
    expect(options).toHaveLength(300);
  });
});

describe('projectedProviderIds (DOR-1660)', () => {
  it('is the connected set when anything is connected', () => {
    const ids = projectedProviderIds(
      payload([{ id: 'ollama', name: 'Ollama', models: [model('a', 'A')] }], {
        connected: ['ollama'],
      })
    );
    expect([...ids]).toEqual(['ollama']);
  });

  it('does NOT answer yes for every provider models.dev has heard of', () => {
    // The bug this exists to prevent: a gate written against `payload.all`
    // never closes, so an Ollama-only user probes OpenRouter over the network
    // on the model write path for models that will never reach their menu.
    const ids = projectedProviderIds(
      payload(
        [
          { id: 'ollama', name: 'Ollama', models: [model('a', 'A')] },
          { id: 'openrouter', name: 'OpenRouter', models: [model('b', 'B')] },
        ],
        { connected: ['ollama'] }
      )
    );
    expect(ids.has('openrouter')).toBe(false);
  });

  it('falls back to every provider when nothing is connected', () => {
    const ids = projectedProviderIds(
      payload(
        [
          { id: 'ollama', name: 'Ollama', models: [model('a', 'A')] },
          { id: 'openrouter', name: 'OpenRouter', models: [model('b', 'B')] },
        ],
        { connected: [] }
      )
    );
    expect([...ids].sort()).toEqual(['ollama', 'openrouter']);
  });
});

describe('projectModelOptions — a live answer of "unknown" never overwrites (DOR-1660)', () => {
  const catalog = payload([
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [
        model('anthropic/claude-opus-5', 'Claude Opus 5', undefined, {
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        }),
      ],
    },
  ]);

  it('keeps the sidecar capability when the live entry reports nothing', () => {
    // If OpenRouter renamed `supported_parameters`, every id would still parse
    // and the size guard would not fire. Merging (not replacing) is what stops
    // that from marking the whole catalog unable to do agent work.
    const options = projectModelOptions(catalog, {
      openRouterCatalog: silentLiveCatalog(['anthropic/claude-opus-5']),
    });

    expect(options).toHaveLength(1);
    expect(options[0].supportsToolUse).toBe(true);
    expect(options[0].supportsVision).toBe(true);
    expect(options[0].supportsImageOutput).toBe(false);
  });

  it('still lets a live answer that IS given win', () => {
    const options = projectModelOptions(catalog, {
      // An explicitly-undefined field is still "not reported", not "no".
      openRouterCatalog: new Map([['anthropic/claude-opus-5', { supportsTools: undefined }]]),
    });
    // Nothing reported → sidecar stands.
    expect(options[0].supportsToolUse).toBe(true);

    const overruled = projectModelOptions(catalog, {
      openRouterCatalog: new Map([['anthropic/claude-opus-5', { supportsTools: false }]]),
    });
    expect(overruled[0].supportsToolUse).toBe(false);
    // The fields the live entry stayed silent about keep the sidecar's answer.
    expect(overruled[0].supportsVision).toBe(true);
  });
});

describe('projectModelOptions — a broken live catalog is distrusted (DOR-1660)', () => {
  /** Twenty openrouter models, as models.dev would list them. */
  const catalog = payload([
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: Array.from({ length: 20 }, (_, i) =>
        model(`vendor/model-${i}`, `Model ${i}`, undefined, { tool_call: true })
      ),
    },
  ]);

  it('ignores a truncated response instead of deleting most of the menu', () => {
    // A 5-of-20 page parses fine and is non-empty, so the size guard does not
    // fire. Obeying it would silently delete 15 models and cache that as
    // success. Below the coverage floor the sidecar's catalog stands instead.
    const truncated = liveCatalog({
      'vendor/model-0': [true, false, false],
      'vendor/model-1': [true, false, false],
      'vendor/model-2': [true, false, false],
      'vendor/model-3': [true, false, false],
      'vendor/model-4': [true, false, false],
    });

    const options = projectModelOptions(catalog, { openRouterCatalog: truncated });
    expect(options).toHaveLength(20);
  });

  it('still trusts a healthy catalog that drops only a few dead ids', () => {
    // The real measured shape: ~99% coverage, a couple of ids retired upstream.
    const healthy = liveCatalog(
      Object.fromEntries(
        Array.from({ length: 18 }, (_, i) => [`vendor/model-${i}`, [true, false, false]])
      ) as Record<string, [boolean, boolean, boolean]>
    );

    const options = projectModelOptions(catalog, { openRouterCatalog: healthy });
    expect(options).toHaveLength(18);
    expect(options.map((o) => o.value)).not.toContain('openrouter/vendor/model-18');
  });
});

describe('projectModelOptions — the shortened menu admits it (DOR-1660)', () => {
  it('marks every row of a nothing-connected menu unverified', () => {
    const options = projectModelOptions(
      payload([{ id: 'alpha', name: 'Alpha', models: [model('a', 'A'), model('b', 'B')] }], {
        connected: [],
      })
    );

    expect(options).toHaveLength(2);
    expect(options.every((o) => o.unverified === true)).toBe(true);
  });

  it('never marks a menu built from genuinely connected providers', () => {
    const options = projectModelOptions(
      payload([{ id: 'alpha', name: 'Alpha', models: [model('a', 'A')] }], {
        connected: ['alpha'],
      })
    );

    expect(options[0].unverified).toBeUndefined();
  });
});
