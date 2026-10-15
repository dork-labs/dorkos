import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DoeInferenceConfig } from '@dorkos/shared/config-schema';
import { makeRuntime, drain, model, projectDir } from './runtime-fixture.js';

/** Whether credits are chosen, and every agent the payer rule was asked about. */
const credits = vi.hoisted(() => ({
  chosen: true,
  agentsAsked: [] as unknown[],
  runtimesAsked: [] as string[],
}));
vi.mock('../../../core/cloud/credits-model-gate.js', () => ({
  agentRunsOnCredits: (runtime: { type: string }, agent: unknown, accountNamedNow: boolean) => {
    credits.runtimesAsked.push(runtime.type);
    credits.agentsAsked.push({ agent, accountNamedNow });
    return credits.chosen;
  },
}));
vi.mock('../../../core/cloud/credits-defaults.js', () => ({
  creditsIsDefaultFor: (runtime: string) => {
    credits.runtimesAsked.push(runtime);
    return credits.chosen;
  },
}));
/** The agent this chat runs as: its home and its manifest. */
const agent = vi.hoisted(() => ({
  manifest: { id: 'agent-1', account: 'dorkos-credits', runtime: 'doe' } as Record<
    string,
    unknown
  > | null,
}));
vi.mock('../../../core/agent-identity/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/agent-identity/index.js')>()),
  homeOf: () => '/agents/one',
  readHomeManifest: async () => agent.manifest,
}));
const auto = vi.hoisted(() => ({
  list: [{ value: 'picked', displayName: 'Picked', description: 'Chosen by DorkOS' }],
  ready: false,
  peek: null as null | { protocol: 'anthropic-messages'; model: { id: string } },
}));
vi.mock('../auto-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auto-model.js')>()),
  listDoeCreditsModels: async () => auto.list,
  doeCreditsReady: () => auto.ready,
  peekDoeCreditsPick: () => auto.peek,
}));

const picked: DoeInferenceConfig = {
  source: 'dorkos-credits',
  provider: 'dorkos',
  protocol: 'anthropic-messages',
  endpoint: 'https://credits.example/anthropic',
  model: 'picked',
  contextWindow: 100_000,
  maxOutputTokens: 4_000,
};

beforeEach(() => {
  credits.chosen = true;
  credits.agentsAsked = [];
  credits.runtimesAsked = [];
  agent.manifest = { id: 'agent-1', account: 'dorkos-credits', runtime: 'doe' };
  auto.ready = false;
  auto.peek = null;
});

describe('a DorkOS chat with nothing configured', () => {
  it('asks the payer rule about this chat’s agent, then freezes what DorkOS picks', async () => {
    const resolveModel = vi.fn(async () => model);
    const chooseCreditsInference = vi.fn(async () => ({ inference: picked }));
    const runtime = makeRuntime({ inference: () => null, resolveModel, chooseCreditsInference });
    const events = await drain(runtime, 'auto');
    expect(events.filter((e) => e.type === 'error').map((e) => e.data)).toEqual([]);
    expect(credits.runtimesAsked).toContain('doe');
    expect(credits.agentsAsked).toEqual([
      { agent: { id: 'agent-1', account: 'dorkos-credits' }, accountNamedNow: false },
    ]);
    expect(chooseCreditsInference).toHaveBeenCalledWith([]);
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ ...picked }));
    expect(runtime.sessions.get('auto')?.inference).toMatchObject({ model: 'picked' });
  });

  it('offers the chat’s model, its agent’s, then the preference, best first', async () => {
    agent.manifest = { id: 'agent-1', runtime: 'doe', model: 'agent-model' };
    const chooseCreditsInference = vi.fn(async () => ({ inference: picked }));
    const runtime = makeRuntime({
      inference: () => null,
      defaultModel: () => 'preferred',
      chooseCreditsInference,
    });
    runtime.ensureSession('ladder', { cwd: projectDir, permissionMode: 'default' });
    await runtime.updateSession('ladder', { model: 'chat-model' });
    await drain(runtime, 'ladder');
    expect(chooseCreditsInference).toHaveBeenCalledWith(['chat-model', 'agent-model', 'preferred']);
  });

  it('ignores an agent model written for another runtime', async () => {
    agent.manifest = { id: 'agent-1', runtime: 'claude-code', model: 'sonnet' };
    const chooseCreditsInference = vi.fn(async () => ({ inference: picked }));
    const runtime = makeRuntime({ inference: () => null, chooseCreditsInference });
    await drain(runtime);
    expect(chooseCreditsInference).toHaveBeenCalledWith([]);
  });

  it('says when its pick replaced a model credits do not serve, by name, and keeps the pick', async () => {
    const resolveModel = vi.fn(async () => model);
    const chooseCreditsInference = vi.fn(async () => ({
      inference: picked,
      replaced: { from: 'gone', fromName: 'Gone Model', toName: 'Picked' },
    }));
    const runtime = makeRuntime({ inference: () => null, resolveModel, chooseCreditsInference });
    runtime.ensureSession('swap', { cwd: projectDir, permissionMode: 'default' });
    await runtime.updateSession('swap', { model: 'gone' });
    const events = await drain(runtime, 'swap');
    expect(events.find((e) => e.type === 'model_substituted')?.data).toEqual({
      from: 'gone',
      fromName: 'Gone Model',
      to: 'picked',
      toName: 'Picked',
      reason: 'credits-not-covered',
    });
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'picked' }));
    expect(runtime.sessions.get('swap')?.session.model).toBe('picked');
  });

  it('carries the catalog id forward for a variant id, so later turns resolve', async () => {
    const resolveModel = vi.fn(async (_config: DoeInferenceConfig) => model);
    const chooseCreditsInference = vi.fn(async () => ({
      inference: { ...picked, model: 'claude-opus-5-5' },
    }));
    const runtime = makeRuntime({ inference: () => null, resolveModel, chooseCreditsInference });
    runtime.ensureSession('variant', { cwd: projectDir, permissionMode: 'default' });
    await runtime.updateSession('variant', { model: 'claude-opus-5-5[1m]' });
    const events = await drain(runtime, 'variant');
    expect(events.some((e) => e.type === 'model_substituted')).toBe(false);
    expect(runtime.sessions.get('variant')?.session.model).toBe('claude-opus-5-5');
    await drain(runtime, 'variant');
    for (const [config] of resolveModel.mock.calls)
      expect(config).toMatchObject({ model: 'claude-opus-5-5' });
  });

  it('refuses with a credits refusal when DorkOS has nothing to pick, never another payer', async () => {
    const resolveModel = vi.fn();
    const { CreditsUnavailableError } = await import('../../../core/cloud/credits-protocols.js');
    const runtime = makeRuntime({
      inference: () => null,
      resolveModel,
      chooseCreditsInference: async () => {
        throw new CreditsUnavailableError('no-models', 'DorkOS');
      },
    });
    const events = await drain(runtime);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      code: 'credits_unavailable',
      reason: 'no-models',
    });
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('asks a person to connect AI when credits are off, even with a preferred model', async () => {
    credits.chosen = false;
    const chooseCreditsInference = vi.fn();
    const resolveModel = vi.fn();
    const runtime = makeRuntime({
      inference: () => null,
      defaultModel: () => 'preferred',
      resolveModel,
      chooseCreditsInference,
    });
    const events = await drain(runtime);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      message: 'Connect AI to use this agent.',
    });
    expect(chooseCreditsInference).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('keeps a started chat’s payer and model when settings change between turns', async () => {
    let preferred: string | null = null;
    const resolveModel = vi.fn(async () => model);
    const chooseCreditsInference = vi.fn(async () => ({ inference: picked }));
    const runtime = makeRuntime({
      inference: () => null,
      defaultModel: () => preferred,
      resolveModel,
      chooseCreditsInference,
    });
    await drain(runtime, 'frozen');
    credits.chosen = false;
    preferred = 'something-else';
    const events = await drain(runtime, 'frozen');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(chooseCreditsInference).toHaveBeenCalledTimes(1);
    expect(resolveModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'dorkos-credits', model: 'picked' })
    );
  });

  it('lists the catalog models DorkOS picks from, and nothing off credits', async () => {
    const runtime = makeRuntime({ inference: () => null });
    expect(await runtime.getSupportedModels()).toEqual(auto.list);
    expect(await runtime.autoCreditsModels()).toEqual(auto.list);
    credits.chosen = false;
    expect(await runtime.getSupportedModels()).toEqual([]);
    const configured = makeRuntime({ inference: () => picked });
    expect(await configured.autoCreditsModels()).toBeNull();
  });

  it('reads as ready exactly when DorkOS can run a chat on credits', async () => {
    const runtime = makeRuntime({ inference: () => null });
    const ready = async () =>
      (await runtime.checkDependencies()).find((d) => d.name === 'Model authentication')?.status;
    expect(await ready()).toBe('missing');
    auto.ready = true;
    expect(await ready()).toBe('satisfied');
    auto.peek = { protocol: 'anthropic-messages', model: { id: 'picked' } };
    expect(runtime.getCreditsProtocol()).toBe('anthropic-messages');
  });
});
