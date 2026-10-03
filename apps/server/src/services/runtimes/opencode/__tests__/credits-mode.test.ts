/**
 * What an OpenCode sidecar on DorkOS credits is handed (ADR 261001-000811): the
 * credits provider as the only one enabled, its endpoint, the token only by
 * variable name in config and by value in the environment, and none of the
 * person's own provider keys. The installed binary's behaviour with this
 * config is proved in `credits-mode.binary.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceModel, InferenceToken } from '@dork-labs/cloud-api';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };

const choice = vi.hoisted(() => ({ credits: false }));
vi.mock('../../../core/cloud/credits-defaults.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/cloud/credits-defaults.js')>()),
  creditsIsDefaultFor: (runtime: string) => runtime === 'opencode' && choice.credits,
}));
const link = vi.hoisted(() => ({ linked: true }));
vi.mock('../../../core/cloud/v1-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/cloud/v1-client.js')>()),
  isCloudLinked: () => link.linked,
  captureCloudV1Context: () => null,
}));

import {
  __setCreditsModelsForTests,
  __setCreditsStateForTests,
} from '../../../core/cloud/credits-inference.js';
import { CREDITS_TOKEN_ENV_NAME } from '../../../core/cloud/credits-protocols.js';
import { planOpenCodeSidecar, planOpenCodeTurn } from '../credits-mode.js';
import {
  OPENCODE_CREDITS_PROVIDER_ID,
  OPENCODE_OWN_PLAN,
  creditsModelFor,
  openCodeCreditsConfig,
  openCodeCreditsEnv,
  planSidecarWithoutCloud,
  planTurnWithoutCloud,
} from '../credits-sidecar.js';

const TOKEN: InferenceToken = {
  ...tokenFixture,
  served: ['anthropicMessages', 'openaiChat'],
  expiresAt: '2999-01-01T00:00:00.000Z',
};
const LAUNCH = {
  protocol: 'openai-chat-completions' as const,
  baseUrl: TOKEN.endpoints.openaiChat,
  token: TOKEN.token,
  tokenId: TOKEN.tokenId,
};
const model = (id: string, tools: boolean): InferenceModel => ({
  id,
  displayName: id,
  contextWindow: 1000,
  maxOutputTokens: 100,
  supports: { tools, promptCaching: false, streaming: true, thinking: false },
});

afterEach(() => {
  choice.credits = false;
  link.linked = true;
  __setCreditsStateForTests({ token: null });
  __setCreditsModelsForTests(null);
});

describe('the credits sidecar’s environment', () => {
  it('drops the person’s provider keys and endpoint, and carries the token', () => {
    const env = openCodeCreditsEnv(
      {
        PATH: '/bin',
        OPENROUTER_API_KEY: 'person',
        OPENAI_API_KEY: 'person',
        ANTHROPIC_API_KEY: 'person',
        OPENAI_BASE_URL: 'https://elsewhere.invalid',
        GITHUB_TOKEN: 'gh',
      },
      LAUNCH
    );
    expect(env).toEqual({
      PATH: '/bin',
      GITHUB_TOKEN: 'gh',
      [CREDITS_TOKEN_ENV_NAME]: LAUNCH.token,
    });
  });

  it('carries no token at all when none is held, so nothing on it can pay', () => {
    expect(openCodeCreditsEnv({ PATH: '/bin', [CREDITS_TOKEN_ENV_NAME]: 'stale' }, null)).toEqual({
      PATH: '/bin',
    });
  });
});

describe('the credits sidecar’s config', () => {
  it('enables the credits provider alone, names the token’s variable, and lists the models', () => {
    const config = openCodeCreditsConfig(LAUNCH, [model('m-chat', false), model('m-tools', true)]);
    expect(config).toEqual({
      enabled_providers: [OPENCODE_CREDITS_PROVIDER_ID],
      model: `${OPENCODE_CREDITS_PROVIDER_ID}/m-tools`,
      small_model: `${OPENCODE_CREDITS_PROVIDER_ID}/m-tools`,
      provider: {
        [OPENCODE_CREDITS_PROVIDER_ID]: {
          name: 'DorkOS credits',
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: LAUNCH.baseUrl,
            apiKey: `{env:${CREDITS_TOKEN_ENV_NAME}}`,
            includeUsage: true,
          },
          models: {
            'm-chat': {
              name: 'm-chat',
              tool_call: false,
              reasoning: false,
              limit: { context: 1000, output: 100 },
            },
            'm-tools': {
              name: 'm-tools',
              tool_call: true,
              reasoning: false,
              limit: { context: 1000, output: 100 },
            },
          },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain(LAUNCH.token);
  });

  it('is the allow list alone with no token or no models, so no provider can run', () => {
    expect(openCodeCreditsConfig(null, [model('m', true)])).toEqual({
      enabled_providers: [OPENCODE_CREDITS_PROVIDER_ID],
    });
    expect(openCodeCreditsConfig(LAUNCH, [])).toEqual({
      enabled_providers: [OPENCODE_CREDITS_PROVIDER_ID],
    });
  });
});

describe('which model a credits turn runs on', () => {
  const available = [model('a', false), model('b', true)];
  it('keeps the session’s model when it is a credits model', () => {
    expect(creditsModelFor(`${OPENCODE_CREDITS_PROVIDER_ID}/a`, available)).toBe('a');
  });
  it('falls back to the first that can call tools, never to another provider’s model', () => {
    expect(creditsModelFor('openrouter/some-model', available)).toBe('b');
    expect(creditsModelFor(`${OPENCODE_CREDITS_PROVIDER_ID}/gone`, available)).toBe('b');
    expect(creditsModelFor(undefined, [model('only', false)])).toBe('only');
    expect(creditsModelFor(undefined, [])).toBeNull();
  });
});

describe('planning the sidecar', () => {
  it('is the person’s own sign-in unless OpenCode’s choice is credits', async () => {
    __setCreditsStateForTests({ token: TOKEN });
    expect(await planOpenCodeSidecar()).toEqual(OPENCODE_OWN_PLAN);
    expect(await planOpenCodeTurn()).toEqual(OPENCODE_OWN_PLAN);
  });

  it('plans a sidecar that can pay for nothing on credits with no token, never the person’s own', async () => {
    choice.credits = true;
    const plan = await planOpenCodeSidecar();
    expect(plan).toMatchObject({ mode: 'credits', launch: null });
  });

  it('refuses a credits turn with no live token, and one with no models', async () => {
    choice.credits = true;
    await expect(planOpenCodeTurn()).rejects.toMatchObject({
      code: 'credits_unavailable',
      reason: 'unreachable',
    });
    __setCreditsStateForTests({ token: TOKEN });
    await expect(planOpenCodeTurn()).rejects.toMatchObject({ reason: 'unreachable' });
    link.linked = false;
    await expect(planOpenCodeTurn()).rejects.toMatchObject({ reason: 'not-linked' });
  });

  it('plans no paying sidecar and refuses turns while the token does not list chat', async () => {
    choice.credits = true;
    __setCreditsStateForTests({ token: { ...TOKEN, served: undefined } });
    __setCreditsModelsForTests({ catalogVersion: 'cv', models: [model('m', true)] });
    expect(await planOpenCodeSidecar()).toMatchObject({ mode: 'credits', launch: null });
    await expect(planOpenCodeTurn()).rejects.toMatchObject({ reason: 'not-supported' });
  });

  it('plans a credits turn on the chat endpoint, the token and the models', async () => {
    choice.credits = true;
    __setCreditsStateForTests({ token: TOKEN });
    __setCreditsModelsForTests({ catalogVersion: 'cv', models: [model('m', true)] });
    const plan = await planOpenCodeTurn();
    expect(plan.mode).toBe('credits');
    expect(plan.launch).toEqual(LAUNCH);
    expect(plan.models.map((m) => m.id)).toEqual(['m']);
    // The fingerprint tells plans apart without ever holding the token.
    expect(plan.fingerprint).not.toContain(LAUNCH.token);
    expect(plan.fingerprint).toContain(LAUNCH.tokenId);
  });
});

describe('planning with nothing that can reach the cloud', () => {
  it('fails closed for a person who chose credits: a sidecar that pays for nothing, a refused turn', async () => {
    expect(await planSidecarWithoutCloud()).toEqual(OPENCODE_OWN_PLAN);
    expect(await planTurnWithoutCloud()).toEqual(OPENCODE_OWN_PLAN);
    choice.credits = true;
    expect(await planSidecarWithoutCloud()).toMatchObject({ mode: 'credits', launch: null });
    await expect(planTurnWithoutCloud()).rejects.toMatchObject({ reason: 'not-supported' });
  });
});
