/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { DoeInferenceConfigSchema } from '@dorkos/shared/config-schema';
import {
  DOE_PRESETS,
  PresetModelsUnreachableError,
  listPresetModels,
  parseModelList,
  pickPresetModel,
  presetInference,
  type PresetFetch,
} from '../presets.js';

/** A fake `/models` endpoint answering one body. No request leaves the test. */
function fakeList(body: unknown, status = 200) {
  return vi.fn<PresetFetch>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('DOE_PRESETS', () => {
  it('saves every preset as a valid DorkOS model setup', () => {
    for (const preset of Object.values(DOE_PRESETS)) {
      expect(() => DoeInferenceConfigSchema.parse(presetInference(preset))).not.toThrow();
    }
  });

  it('points Anthropic at the base its client appends /v1/messages to', () => {
    expect(DOE_PRESETS.anthropic.endpoint).toBe('https://api.anthropic.com');
    expect(DOE_PRESETS.anthropic.modelsUrl).toBe('https://api.anthropic.com/v1/models');
    expect(DOE_PRESETS.openai.endpoint).toBe('https://api.openai.com/v1');
    expect(DOE_PRESETS.openrouter.protocol).toBe('openai-chat-completions');
    expect(DOE_PRESETS.local).toMatchObject({
      source: 'local',
      endpoint: 'http://127.0.0.1:11434/v1',
      limits: { contextWindow: 32_768, maxOutputTokens: 4_096 },
    });
  });
});

describe('listPresetModels', () => {
  it('sends an OpenAI-shaped key as a bearer token', async () => {
    const fetch = fakeList({ data: [{ id: 'gpt-5' }] });
    await listPresetModels(DOE_PRESETS.openai, 'sk-test', fetch);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sk-test' }),
      })
    );
  });

  it('sends an Anthropic key with its version header and no bearer token', async () => {
    const fetch = fakeList({ data: [{ id: 'claude-sonnet-4-5' }] });
    await listPresetModels(DOE_PRESETS.anthropic, 'sk-ant-api-test', fetch);
    const headers = fetch.mock.calls[0]![1].headers;
    expect(headers).toMatchObject({
      'x-api-key': 'sk-ant-api-test',
      'anthropic-version': '2023-06-01',
    });
    expect(headers).not.toHaveProperty('authorization');
  });

  it('sends no key to a local model', async () => {
    const fetch = fakeList({ data: [{ id: 'llama3.2' }] });
    await listPresetModels(DOE_PRESETS.local, undefined, fetch);
    expect(fetch.mock.calls[0]![1].headers).toEqual({ accept: 'application/json' });
  });

  it('refuses a failed, broken or empty list', async () => {
    await expect(
      listPresetModels(DOE_PRESETS.openai, 'k', fakeList({ error: 'no' }, 401))
    ).rejects.toBeInstanceOf(PresetModelsUnreachableError);
    await expect(
      listPresetModels(DOE_PRESETS.openai, 'k', fakeList({ data: [] }))
    ).rejects.toBeInstanceOf(PresetModelsUnreachableError);
    const throwing = vi.fn<PresetFetch>(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(listPresetModels(DOE_PRESETS.local, undefined, throwing)).rejects.toBeInstanceOf(
      PresetModelsUnreachableError
    );
  });
});

describe('PresetModelsUnreachableError.keyRefused', () => {
  it('is true only when the service answered 401 or 403', async () => {
    const statuses = [401, 403, 404, 429, 500];
    const refused = await Promise.all(
      statuses.map((status) =>
        listPresetModels(DOE_PRESETS.openai, 'k', fakeList({}, status)).catch(
          (e: PresetModelsUnreachableError) => e.keyRefused
        )
      )
    );
    expect(refused).toEqual([true, true, false, false, false]);
    const offline = vi.fn<PresetFetch>(async () => {
      throw new Error('ECONNREFUSED');
    });
    const error = await listPresetModels(DOE_PRESETS.openai, 'k', offline).catch(
      (e: PresetModelsUnreachableError) => e
    );
    expect(error).toBeInstanceOf(PresetModelsUnreachableError);
    expect((error as PresetModelsUnreachableError).keyRefused).toBe(false);
  });
});

describe('parseModelList', () => {
  it('reads the sizes each service reports, and skips entries with no id', () => {
    expect(
      parseModelList({
        data: [
          { id: 'a', context_length: 200_000, top_provider: { max_completion_tokens: 64_000 } },
          { id: 'b', max_input_tokens: 100_000, max_tokens: 4_000 },
          { id: '' },
          { name: 'no id' },
          { id: 'c', context_length: -1 },
        ],
      })
    ).toEqual([
      { id: 'a', contextWindow: 200_000, maxOutputTokens: 64_000 },
      { id: 'b', contextWindow: 100_000, maxOutputTokens: 4_000 },
      { id: 'c', contextWindow: undefined, maxOutputTokens: undefined },
    ]);
    expect(parseModelList({ models: [] })).toEqual([]);
  });
});

describe('pickPresetModel', () => {
  it('OpenAI: takes the exact preferred id over dated, mini and pro variants', () => {
    // Shaped like a real /v1/models answer: unordered, full of variants.
    const listed = [
      'gpt-5-mini',
      'dall-e-3',
      'gpt-5-pro',
      'text-embedding-3-small',
      'gpt-4o-realtime-preview',
      'gpt-5-nano',
      'gpt-5-2025-08-07',
      'gpt-5',
      'gpt-4o-mini-tts',
      'gpt-4.1',
    ].map((id) => ({ id }));
    expect(pickPresetModel(DOE_PRESETS.openai, listed).model).toBe('gpt-5');
  });

  it('OpenAI: a prefix never lands on a variant when a plain one is listed', () => {
    const listed = ['gpt-5.1-mini', 'gpt-5.1-codex', 'gpt-5.1-2026-01-01'].map((id) => ({ id }));
    expect(pickPresetModel(DOE_PRESETS.openai, listed).model).toBe('gpt-5.1-codex');
  });

  it('Anthropic: the newest Sonnet the list names first', () => {
    const listed = [
      { id: 'claude-opus-4-1-20250805' },
      { id: 'claude-sonnet-4-5-20250929' },
      { id: 'claude-sonnet-4-20250514' },
      { id: 'claude-haiku-4-5-20251001' },
    ];
    expect(pickPresetModel(DOE_PRESETS.anthropic, listed).model).toBe('claude-sonnet-4-5-20250929');
  });

  it('OpenRouter: skips a search or image variant of the preferred family', () => {
    const listed = [
      'openai/gpt-5-image',
      'anthropic/claude-sonnet-4.5:search',
      'anthropic/claude-sonnet-4.5',
    ].map((id) => ({ id }));
    expect(pickPresetModel(DOE_PRESETS.openrouter, listed).model).toBe(
      'anthropic/claude-sonnet-4.5'
    );
  });

  it('with no preference matching, the first listed id that is no variant', () => {
    const listed = ['nomic-embed-text', 'whisper-transcribe', 'llama3.2'].map((id) => ({ id }));
    expect(pickPresetModel(DOE_PRESETS.local, [{ id: 'x-embedding' }, ...listed]).model).toBe(
      'nomic-embed-text'
    );
  });

  it('takes the first listed id matching a preference, in the preferences’ order', () => {
    const picked = pickPresetModel(DOE_PRESETS.openai, [
      { id: 'dall-e-3' },
      { id: 'gpt-4.1' },
      { id: 'gpt-5' },
    ]);
    expect(picked).toEqual({ model: 'gpt-5', contextWindow: 128_000, maxOutputTokens: 8_192 });
  });

  it('falls back to the first listed id, with the preset’s limits', () => {
    expect(pickPresetModel(DOE_PRESETS.local, [{ id: 'qwen3' }, { id: 'llama3.2' }])).toEqual({
      model: 'qwen3',
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    });
  });

  it('uses the sizes the list reports, never letting output exceed the context', () => {
    expect(
      pickPresetModel(DOE_PRESETS.openrouter, [
        { id: 'anthropic/claude-sonnet-4.5', contextWindow: 4_000, maxOutputTokens: 9_000 },
      ])
    ).toEqual({
      model: 'anthropic/claude-sonnet-4.5',
      contextWindow: 4_000,
      maxOutputTokens: 4_000,
    });
  });
});
