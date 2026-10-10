/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UserConfigSchema,
  type DoeInferenceConfig,
  type UserConfig,
} from '@dorkos/shared/config-schema';

vi.mock('../../operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));
vi.mock('../../config-manager.js', () => ({ configManager: { get: vi.fn(), set: vi.fn() } }));

import type { PresetFetch } from '../../../runtimes/doe/presets.js';
import { recordFirstRunCreditsChoice } from '../../cloud/credits-defaults.js';
import { FirstRunError, applyFirstRun, type FirstRunDeps } from '../first-run.js';

const KEY_REF = 'file:doe-key';
const REGISTERED = new Set(['claude-code', 'codex', 'opencode', 'doe']);

/** A model-list answer. */
function list(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

/** An in-memory config plus fakes for every writer. No network, no disk. */
function harness(opts: { linked?: boolean; models?: unknown; listStatus?: number } = {}) {
  let config: UserConfig = UserConfigSchema.parse({ version: 1 });
  const dorkbot: string[] = [];
  const fetch = vi.fn<PresetFetch>(async () =>
    list(opts.models ?? { data: [{ id: 'gpt-4.1' }, { id: 'gpt-5' }] }, opts.listStatus)
  );
  const storeCredential = vi.fn(async (inference: DoeInferenceConfig) => {
    const stored = { ...inference, credentialRef: KEY_REF, credentialEndpoint: inference.endpoint };
    config = {
      ...config,
      runtimes: { ...config.runtimes, doe: { ...config.runtimes.doe, inference: stored } },
    };
    return stored;
  });
  const deps: FirstRunDeps = {
    config: {
      get: (key) => config[key],
      set: (key, value) => {
        config = { ...config, [key]: value };
      },
    },
    setDorkBotRuntime: async (runtime) => {
      dorkbot.push(runtime);
    },
    storeCredential,
    fetch,
    linked: () => opts.linked ?? false,
    isRuntime: (type) => REGISTERED.has(type),
    now: () => new Date('2026-10-10T12:00:00.000Z'),
  };
  return {
    deps,
    fetch,
    storeCredential,
    dorkbot,
    config: () => config,
    edit: (next: Partial<UserConfig>) => {
      config = { ...config, ...next };
    },
  };
}

const OPENAI = { path: 'own', choice: { kind: 'openai', apiKey: 'sk-test' } } as const;

describe('applyFirstRun', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('dorkos: moves the default and DorkBot to DorkOS, writes no credits record, stamps the pick', async () => {
    const result = await applyFirstRun({ path: 'dorkos' }, h.deps);
    expect(result).toEqual({ path: 'dorkos', runtime: 'doe' });
    expect(h.config().runtimes.default).toBe('doe');
    expect(h.dorkbot).toEqual(['doe']);
    expect(h.config().cloud.credits?.defaults ?? {}).toEqual({});
    expect(h.config().onboarding).toMatchObject({
      firstRunPath: 'dorkos',
      priorRuntime: 'claude-code',
      runtimeDefaultSetAt: '2026-10-10T12:00:00.000Z',
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('dorkos: clears a model setup an earlier pick left, so DorkOS picks the model', async () => {
    await applyFirstRun(OPENAI, h.deps);
    expect(h.config().runtimes.doe.inference?.credentialRef).toBe(KEY_REF);
    await applyFirstRun({ path: 'dorkos' }, h.deps);
    expect(h.config().runtimes.doe.inference).toBeNull();
  });

  it('dorkos on a computer already linked records credits as the person’s pick now', async () => {
    h = harness({ linked: true });
    await applyFirstRun({ path: 'dorkos' }, h.deps);
    expect(h.config().cloud.credits?.defaults.doe).toEqual({
      runsOn: 'credits',
      chosenBy: 'user',
      announced: true,
      signInReoffered: false,
    });
  });

  it('own key: reads the list with the key, then saves the key with the picked model', async () => {
    const result = await applyFirstRun(OPENAI, h.deps);
    expect(result).toEqual({ path: 'own', runtime: 'doe', model: 'gpt-5' });
    expect(h.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      h.storeCredential.mock.invocationCallOrder[0]!
    );
    expect(h.storeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5', endpoint: 'https://api.openai.com/v1' }),
      'sk-test'
    );
    expect(h.config().runtimes.doe.inference).toMatchObject({
      source: 'api-key',
      protocol: 'openai-responses',
      model: 'gpt-5',
      credentialRef: KEY_REF,
    });
    expect(h.dorkbot).toEqual(['doe']);
    expect(h.config().onboarding.firstRunPath).toBe('own');
  });

  it('own key: turns off credits a link made before the first run set as a default', async () => {
    // A link approved before the first run, whose gap fill put the DorkOS
    // runtime on credits as DorkOS's own choice.
    h.edit({
      cloud: {
        ...h.config().cloud,
        credits: {
          defaults: {
            doe: {
              runsOn: 'credits',
              chosenBy: 'default',
              announced: false,
              signInReoffered: false,
            },
          },
          offer: 'none',
          agents: [],
          linkedTo: 'acct-1',
        },
      },
    });
    await applyFirstRun(OPENAI, h.deps);
    expect(h.config().cloud.credits?.defaults.doe).toMatchObject({
      runsOn: 'own-sign-in',
      chosenBy: 'user',
    });
  });

  it('own key: a list that cannot be read changes nothing at all', async () => {
    await applyFirstRun({ path: 'dorkos' }, h.deps);
    const before = h.config();
    h.deps.fetch = vi.fn<PresetFetch>(async () => list({ error: 'no' }, 401));
    const error = await applyFirstRun(
      { path: 'own', choice: { kind: 'anthropic', apiKey: 'sk-ant-api-x' } },
      h.deps
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FirstRunError);
    expect(error).toMatchObject({
      status: 502,
      code: 'models_unreachable',
      message: "Couldn't reach Anthropic. Check the key.",
    });
    expect(h.config()).toBe(before);
    expect(h.storeCredential).not.toHaveBeenCalled();
  });

  it('own key: a refused key changes nothing and reaches no service', async () => {
    await applyFirstRun({ path: 'dorkos' }, h.deps);
    const before = h.config();
    await expect(
      applyFirstRun({ path: 'own', choice: { kind: 'anthropic', apiKey: 'sk-ant-oat-1' } }, h.deps)
    ).rejects.toMatchObject({ status: 400, code: 'invalid_key' });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.config()).toBe(before);
  });

  it('local: lists the models with no key and runs on the first one', async () => {
    h = harness({ models: { data: [{ id: 'qwen3' }] } });
    const result = await applyFirstRun({ path: 'own', choice: { kind: 'local' } }, h.deps);
    expect(result.model).toBe('qwen3');
    expect(h.storeCredential).not.toHaveBeenCalled();
    expect(h.config().runtimes.doe.inference).toMatchObject({
      source: 'local',
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    });
  });

  it('local: nothing answering says so, and writes nothing', async () => {
    h = harness({ listStatus: 500 });
    await expect(
      applyFirstRun({ path: 'own', choice: { kind: 'local' } }, h.deps)
    ).rejects.toMatchObject({ message: "Couldn't reach Ollama. Check that it is running." });
    expect(h.config().runtimes.doe.inference).toBeNull();
  });

  it('custom: saves the key with the setup as typed, and reads no list', async () => {
    const inference = {
      source: 'api-key' as const,
      provider: 'acme',
      protocol: 'openai-chat-completions' as const,
      endpoint: 'https://llm.example.com/v1',
      model: 'acme-1',
      contextWindow: 64_000,
      maxOutputTokens: 4_000,
    };
    const result = await applyFirstRun(
      { path: 'own', choice: { kind: 'custom', inference, apiKey: 'k' } },
      h.deps
    );
    expect(result.model).toBe('acme-1');
    expect(h.storeCredential).toHaveBeenCalledWith(inference, 'k');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('agent-app: moves nothing and leaves the default for the connect cards to pick', async () => {
    const result = await applyFirstRun({ path: 'own', choice: { kind: 'agent-app' } }, h.deps);
    expect(result).toEqual({ path: 'own', runtime: 'claude-code' });
    expect(h.dorkbot).toEqual([]);
    expect(h.config().onboarding.runtimeDefaultSetAt).toBeNull();
  });

  it('none: records the path only', async () => {
    await applyFirstRun({ path: 'none' }, h.deps);
    expect(h.config().runtimes.default).toBe('claude-code');
    expect(h.config().onboarding).toMatchObject({
      firstRunPath: 'none',
      priorRuntime: 'claude-code',
    });
  });

  for (const closed of ['completedAt', 'dismissedAt'] as const) {
    it(`refuses once the first run has ${closed}, and writes nothing`, async () => {
      h.edit({ onboarding: { ...h.config().onboarding, [closed]: '2026-10-01T00:00:00.000Z' } });
      const before = h.config();
      await expect(applyFirstRun({ path: 'dorkos' }, h.deps)).rejects.toMatchObject({
        status: 409,
        code: 'onboarding_complete',
      });
      expect(h.config()).toBe(before);
    });
  }

  it('runs calls one at a time, in the order they arrived', async () => {
    // The key check is slow; a DorkOS press lands while it waits. Run in
    // order, the later press is the one that stands, and its credits record
    // is not undone by the earlier key arriving late.
    h = harness({ linked: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.deps.fetch = vi.fn<PresetFetch>(async () => {
      await gate;
      return list({ data: [{ id: 'gpt-5' }] });
    });
    const own = applyFirstRun(OPENAI, h.deps);
    const dorkos = applyFirstRun({ path: 'dorkos' }, h.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([own, dorkos]);
    expect(h.config().onboarding.firstRunPath).toBe('dorkos');
    expect(h.config().runtimes.doe.inference).toBeNull();
    expect(h.config().cloud.credits?.defaults.doe?.runsOn).toBe('credits');
  });

  it('undoes to the built-in default when the runtime before is not registered', async () => {
    h.edit({ runtimes: { ...h.config().runtimes, default: 'gone-runtime' } });
    await applyFirstRun({ path: 'dorkos' }, h.deps);
    await applyFirstRun({ path: 'none' }, h.deps);
    expect(h.config().runtimes.default).toBe('claude-code');
    expect(h.dorkbot.at(-1)).toBe('claude-code');
  });

  describe('each call undoes the previous one first', () => {
    it('Continue with DorkOS, link approved, then a key: credits are put back, never left armed', async () => {
      await applyFirstRun({ path: 'dorkos' }, h.deps);
      // The new link approved in the browser records the person's pick.
      expect(recordFirstRunCreditsChoice(h.deps.config)).toBe(true);
      expect(h.config().cloud.credits?.defaults.doe?.runsOn).toBe('credits');

      await applyFirstRun(OPENAI, h.deps);
      expect(h.config().cloud.credits?.defaults.doe).toMatchObject({
        runsOn: 'own-sign-in',
        chosenBy: 'user',
      });
      expect(h.config().onboarding.firstRunPath).toBe('own');
      // And a link approved after this is not armed by the earlier pick.
      expect(recordFirstRunCreditsChoice(h.deps.config)).toBe(false);
    });

    it('DorkOS, then no account: the default and DorkBot go back to what they were', async () => {
      h.edit({ runtimes: { ...h.config().runtimes, default: 'codex' } });
      await applyFirstRun({ path: 'dorkos' }, h.deps);
      await applyFirstRun({ path: 'none' }, h.deps);
      expect(h.config().runtimes.default).toBe('codex');
      expect(h.dorkbot).toEqual(['doe', 'codex']);
      // The runtime to undo to is the one from before the FIRST call.
      expect(h.config().onboarding.priorRuntime).toBe('codex');
    });

    it('DorkOS, then an AI app: credits the DorkOS pick armed are put back', async () => {
      h = harness({ linked: true });
      await applyFirstRun({ path: 'dorkos' }, h.deps);
      await applyFirstRun({ path: 'own', choice: { kind: 'agent-app' } }, h.deps);
      expect(h.config().cloud.credits?.defaults.doe?.runsOn).toBe('own-sign-in');
      expect(h.config().runtimes.default).toBe('claude-code');
    });
  });
});

describe('recordFirstRunCreditsChoice', () => {
  it('records nothing once the first run is dismissed', async () => {
    const h = harness();
    await applyFirstRun({ path: 'dorkos' }, h.deps);
    h.edit({ onboarding: { ...h.config().onboarding, dismissedAt: '2026-10-10T13:00:00.000Z' } });
    expect(recordFirstRunCreditsChoice(h.deps.config)).toBe(false);
    expect(h.config().cloud.credits?.defaults ?? {}).toEqual({});
  });
});
