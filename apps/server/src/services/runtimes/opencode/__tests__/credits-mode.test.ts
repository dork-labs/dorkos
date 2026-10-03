/**
 * What an OpenCode sidecar on DorkOS credits is handed (ADR 261002-221210): the
 * credits provider as the only one enabled, pointed at the loopback relay with
 * the boot's key, no credits token anywhere, and none of the person's own
 * provider keys. The installed binary's behaviour with this
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
/** A relay grant, as the sidecar manager hands one to a boot. */
const RELAY = { baseUrl: 'http://127.0.0.1:9/relay/openai-chat-completions', key: 'relay-key' };
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
  it('drops the person’s provider keys and endpoint, and carries no credits token at all', () => {
    const env = openCodeCreditsEnv({
      PATH: '/bin',
      OPENROUTER_API_KEY: 'person',
      OPENAI_API_KEY: 'person',
      ANTHROPIC_API_KEY: 'person',
      OPENAI_BASE_URL: 'https://elsewhere.invalid',
      GITHUB_TOKEN: 'gh',
      DORKOS_CREDITS_TOKEN_OLD: 'a token that must not ride along',
    });
    expect(env).toEqual({ PATH: '/bin', GITHUB_TOKEN: 'gh' });
  });
});

describe('the credits sidecar’s config', () => {
  it('enables the credits provider alone, points it at the relay with the boot’s key, and lists the models', () => {
    const config = openCodeCreditsConfig(RELAY, [model('m-chat', false), model('m-tools', true)]);
    expect(config).toEqual({
      enabled_providers: [OPENCODE_CREDITS_PROVIDER_ID],
      model: `${OPENCODE_CREDITS_PROVIDER_ID}/m-tools`,
      small_model: `${OPENCODE_CREDITS_PROVIDER_ID}/m-tools`,
      provider: {
        [OPENCODE_CREDITS_PROVIDER_ID]: {
          name: 'DorkOS credits',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: RELAY.baseUrl, apiKey: RELAY.key, includeUsage: true },
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
    expect(JSON.stringify(config)).not.toContain(TOKEN.token);
  });

  it('is the allow list alone with no relay grant or no models, so no provider can run', () => {
    expect(openCodeCreditsConfig(null, [model('m', true)])).toEqual({
      enabled_providers: [OPENCODE_CREDITS_PROVIDER_ID],
    });
    expect(openCodeCreditsConfig(RELAY, [])).toEqual({
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
    expect(plan).toEqual({ mode: 'credits', fingerprint: 'credits:none', models: [] });
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
    expect(await planOpenCodeSidecar()).toEqual({
      mode: 'credits',
      fingerprint: 'credits:none',
      models: [],
    });
    await expect(planOpenCodeTurn()).rejects.toMatchObject({ reason: 'not-supported' });
  });

  it('plans a credits turn on the models when credits can pay, and the plan holds no credential', async () => {
    choice.credits = true;
    __setCreditsStateForTests({ token: TOKEN });
    __setCreditsModelsForTests({ catalogVersion: 'cv', models: [model('m', true)] });
    const plan = await planOpenCodeTurn();
    expect(plan).toEqual({ mode: 'credits', fingerprint: 'credits:m', models: [model('m', true)] });
    expect(JSON.stringify(plan)).not.toContain(TOKEN.token);
  });
});

describe('planning with nothing that can reach the cloud', () => {
  it('fails closed for a person who chose credits: a sidecar that pays for nothing, a refused turn', async () => {
    expect(await planSidecarWithoutCloud()).toEqual(OPENCODE_OWN_PLAN);
    expect(await planTurnWithoutCloud()).toEqual(OPENCODE_OWN_PLAN);
    choice.credits = true;
    expect(await planSidecarWithoutCloud()).toEqual({
      mode: 'credits',
      fingerprint: 'credits:none',
      models: [],
    });
    await expect(planTurnWithoutCloud()).rejects.toMatchObject({ reason: 'not-supported' });
  });
});
