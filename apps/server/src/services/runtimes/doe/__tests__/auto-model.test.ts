import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token-every-format.json' with { type: 'json' };
import { InferenceTokenSchema, type InferenceModel } from '@dork-labs/cloud-api';
import type { RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { CHOSEN_BY_DORKOS } from '@dorkos/shared/runtime-connect';
import {
  chooseDoeCreditsInference,
  doeCreditsInUse,
  doeCreditsReady,
  listDoeCreditsModels,
  peekDoeCreditsPick,
} from '../auto-model.js';
import { creditsFormatOf } from '../../../core/cloud/credits-protocols.js';

/** The stored credits settings `doeCreditsInUse` reads. */
const stored = vi.hoisted(() => ({
  settings: { defaults: {}, offer: 'none', agents: [], linkedTo: null } as {
    defaults: Record<string, { runsOn: string }>;
    offer: string;
    agents: string[];
    linkedTo: null;
  },
}));
vi.mock('../../../core/cloud/credits-defaults.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/cloud/credits-defaults.js')>()),
  readCreditsSettings: () => stored.settings,
}));

const everyFormat = InferenceTokenSchema.parse(tokenFixture);
const openaiOnly = InferenceTokenSchema.parse({
  ...tokenFixture,
  served: ['openaiChat', 'openaiResponses'],
});
const chatOnly = InferenceTokenSchema.parse({ ...tokenFixture, served: ['openaiChat'] });

function model(id: string, protocols: string[], recommendedOn: string[] = []): InferenceModel {
  return {
    id,
    displayName: `Name ${id}`,
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supports: { tools: true, promptCaching: false, streaming: true, thinking: false },
    protocols,
    recommendedOn,
  };
}

/** A catalog: anthropic recommends `a-best`, responses `r-best`, chat `c-best`. */
const CATALOG = [
  model('a-other', ['anthropicMessages']),
  model('a-best', ['anthropicMessages'], ['anthropicMessages']),
  model('r-best', ['openaiResponses', 'openaiChat'], ['openaiResponses']),
  model('c-best', ['openaiChat'], ['openaiChat']),
  model('c-only', ['openaiChat']),
];
/** The catalog as `creditsModelsFor` answers it: filtered by format. */
function inFormat(catalog: readonly InferenceModel[]) {
  return (protocol: RuntimeCreditsProtocol) =>
    catalog.filter((m) => m.protocols?.includes(creditsFormatOf(protocol)));
}
const asyncInFormat = (catalog: readonly InferenceModel[]) => {
  const read = inFormat(catalog);
  return async (protocol: RuntimeCreditsProtocol) => read(protocol);
};
/** Serves any model on the format's list, the way the shared rule does once filtered. */
const launchModel = vi.fn(
  async (capabilities: { credits?: { protocol: RuntimeCreditsProtocol } }, requested?: string) => {
    const served = inFormat(CATALOG)(capabilities.credits!.protocol).some(
      (m) => m.id === requested
    );
    return served
      ? ({ kind: 'as-named', model: requested } as const)
      : ({ kind: 'replaced', model: 'x', from: requested!, toName: 'x' } as const);
  }
);

describe('DorkOS picks the model', () => {
  it('freezes the recommended model of the first served format in preference order', async () => {
    const choice = await chooseDoeCreditsInference([], {
      token: async () => everyFormat,
      models: asyncInFormat(CATALOG),
      launchModel,
    });
    expect(choice).toEqual({
      inference: {
        source: 'dorkos-credits',
        provider: 'dorkos',
        protocol: 'anthropic-messages',
        endpoint: everyFormat.endpoints.anthropicMessages,
        model: 'a-best',
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      },
    });
  });

  it('skips formats the token does not serve: responses before chat completions', async () => {
    const responses = await chooseDoeCreditsInference([], {
      token: async () => openaiOnly,
      models: asyncInFormat(CATALOG),
      launchModel,
    });
    expect(responses.inference).toMatchObject({ protocol: 'openai-responses', model: 'r-best' });
    const chat = await chooseDoeCreditsInference([], {
      token: async () => chatOnly,
      models: asyncInFormat(CATALOG),
      launchModel,
    });
    expect(chat.inference).toMatchObject({
      protocol: 'openai-chat-completions',
      model: 'c-best',
      endpoint: chatOnly.endpoints.openaiChat,
    });
  });

  it('keeps a model the person chose when credits serve it, in the format that serves it', async () => {
    const choice = await chooseDoeCreditsInference(['c-only'], {
      token: async () => everyFormat,
      models: asyncInFormat(CATALOG),
      launchModel,
    });
    expect(choice.inference).toMatchObject({
      protocol: 'openai-chat-completions',
      model: 'c-only',
    });
    expect(choice.replaced).toBeUndefined();
  });

  it('runs the pick instead of a model credits do not serve, and says which it replaced', async () => {
    const choice = await chooseDoeCreditsInference(['gone'], {
      token: async () => everyFormat,
      models: asyncInFormat(CATALOG),
      launchModel,
    });
    expect(choice.inference.model).toBe('a-best');
    expect(choice.replaced).toEqual({ from: 'gone', fromName: 'gone', toName: 'Name a-best' });
  });

  it('matches a variant id by its base model, and freezes the catalog id', async () => {
    const choice = await chooseDoeCreditsInference(['c-only[1m]'], {
      token: async () => everyFormat,
      models: asyncInFormat(CATALOG),
      launchModel: async () => ({ kind: 'as-named', model: 'c-only[1m]' }),
    });
    expect(choice.inference).toMatchObject({
      protocol: 'openai-chat-completions',
      model: 'c-only',
    });
    expect(choice.replaced).toBeUndefined();
  });

  it('takes the first served candidate, and says which model it stood in for', async () => {
    const choice = await chooseDoeCreditsInference(['gone', 'also-gone', 'a-other'], {
      token: async () => everyFormat,
      models: asyncInFormat(CATALOG),
      launchModel,
    });
    expect(choice.inference.model).toBe('a-other');
    expect(choice.replaced).toEqual({ from: 'gone', fromName: 'gone', toName: 'Name a-other' });
  });

  it('names a replaced model by its catalog name when a format lists it', async () => {
    // Listed only in a format this token does not serve.
    const choice = await chooseDoeCreditsInference(['r-best'], {
      token: async () =>
        InferenceTokenSchema.parse({ ...tokenFixture, served: ['anthropicMessages'] }),
      models: asyncInFormat(CATALOG),
      launchModel,
    });
    expect(choice.replaced).toEqual({
      from: 'r-best',
      fromName: 'Name r-best',
      toName: 'Name a-best',
    });
  });

  it('refuses with no-models when no served format has a recommended model, never another payer', async () => {
    const unrecommended = CATALOG.map((m) => ({ ...m, recommendedOn: [] }));
    await expect(
      chooseDoeCreditsInference([], {
        token: async () => everyFormat,
        models: asyncInFormat(unrecommended),
        launchModel,
      })
    ).rejects.toMatchObject({ code: 'credits_unavailable', reason: 'no-models' });
    // A recommendation only in a format the token does not serve is no match either.
    await expect(
      chooseDoeCreditsInference([], {
        token: async () => chatOnly,
        models: asyncInFormat([model('a-best', ['anthropicMessages'], ['anthropicMessages'])]),
        launchModel,
      })
    ).rejects.toMatchObject({ reason: 'no-models' });
  });

  it('peeks the same pick from held state without any request', () => {
    const models = vi.fn(inFormat(CATALOG));
    expect(
      peekDoeCreditsPick({ linked: () => true, token: () => openaiOnly, models })?.model.id
    ).toBe('r-best');
    expect(
      peekDoeCreditsPick({ linked: () => false, token: () => everyFormat, models })
    ).toBeNull();
    // No token yet reads like the model list: the Anthropic format only.
    expect(peekDoeCreditsPick({ linked: () => true, token: () => null, models })?.model.id).toBe(
      'a-best'
    );
    expect(
      peekDoeCreditsPick({ linked: () => true, token: () => everyFormat, models: () => [] })
    ).toBeNull();
  });

  it('lists the picked format with the pick first, described as chosen by DorkOS', async () => {
    const options = await listDoeCreditsModels({
      token: () => everyFormat,
      models: asyncInFormat(CATALOG),
    });
    expect(options.map((o) => [o.value, o.description, o.isDefault ?? false])).toEqual([
      ['a-best', CHOSEN_BY_DORKOS, true],
      ['a-other', '', false],
    ]);
    expect(options.every((o) => o.paidFromCredits)).toBe(true);
  });

  it('reads as ready on credits with no token yet, and needs a pick once one is held', () => {
    const base = { inUse: () => true, linked: () => true, models: inFormat(CATALOG) };
    expect(doeCreditsReady({ ...base, token: () => null, models: () => [] })).toBe(true);
    expect(doeCreditsReady({ ...base, token: () => everyFormat })).toBe(true);
    // A token before any catalog read: nothing to decide by yet, so not "missing".
    expect(doeCreditsReady({ ...base, token: () => everyFormat, models: () => [] })).toBe(true);
    // A catalog that names no recommended model in a served format is not ready.
    const unrecommended = CATALOG.map((m) => ({ ...m, recommendedOn: [] }));
    expect(
      doeCreditsReady({ ...base, token: () => everyFormat, models: inFormat(unrecommended) })
    ).toBe(false);
    expect(doeCreditsReady({ ...base, inUse: () => false, token: () => everyFormat })).toBe(false);
    expect(doeCreditsReady({ ...base, linked: () => false, token: () => null })).toBe(false);
  });

  it('counts credits in use only when DorkOS itself defaults to them, not any agent', () => {
    // A Claude Code agent allowed onto credits says nothing about DorkOS.
    stored.settings = { defaults: {}, offer: 'none', agents: ['claude-agent'], linkedTo: null };
    expect(doeCreditsInUse()).toBe(false);
    expect(doeCreditsReady({ linked: () => true, token: () => null })).toBe(false);
    stored.settings = {
      defaults: { doe: { runsOn: 'credits' } },
      offer: 'none',
      agents: [],
      linkedTo: null,
    };
    expect(doeCreditsInUse()).toBe(true);
    expect(doeCreditsReady({ linked: () => true, token: () => null })).toBe(true);
  });
});
