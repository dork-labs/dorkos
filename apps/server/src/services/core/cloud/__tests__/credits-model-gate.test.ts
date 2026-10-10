/**
 * The one rule every model write asks when the work runs on DorkOS credits
 * (DOR-2636): an agent is on credits by its own allowed pick or by the
 * machine default, and an alias is judged by the id it expands to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

const state = vi.hoisted(() => ({ allowed: false, isDefault: false }));
vi.mock('../credits-defaults.js', () => ({
  creditsAllowedForAgent: vi.fn(() => state.allowed),
  creditsIsDefaultFor: vi.fn(() => state.isDefault),
}));
vi.mock('../credits-models.js', () => ({
  judgeCreditsModel: vi.fn(async (_caps: unknown, model: string, resolved?: string) => ({
    judged: true,
    refusal: [model, resolved].includes('md_served') ? null : 'not covered',
  })),
}));
const runtimes = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../runtime-registry.js', () => ({
  runtimeRegistry: {
    getNativeSessionCwd: vi.fn(() => null),
    getDefaultType: () => 'claude-code',
    has: (type: string) => runtimes.has(type),
    get: (type: string) => runtimes.get(type),
  },
}));

import { judgeCreditsModel } from '../credits-models.js';
import {
  sessionRunsOnCredits,
  agentRunsOnCredits,
  creditsAgentModelRefusal,
  creditsModelRefusal,
  resolvedModelFor,
} from '../credits-model-gate.js';

const claude = {
  type: 'claude-code',
  getCapabilities: () => ({ credits: { protocol: 'anthropic-messages', scope: 'conversation' } }),
  getSupportedModels: async () => [
    { value: 'sonnet', displayName: 'Sonnet', description: '', resolvedModel: 'md_served' },
    { value: 'opus', displayName: 'Opus', description: '', resolvedModel: 'claude-opus-wire' },
  ],
} as unknown as AgentRuntime;
const codex = {
  type: 'codex',
  getCapabilities: () => ({}),
  getSupportedModels: async () => [],
} as unknown as AgentRuntime;

beforeEach(() => {
  state.allowed = false;
  state.isDefault = false;
  runtimes.clear();
  runtimes.set('claude-code', claude);
  runtimes.set('codex', codex);
});

describe('agentRunsOnCredits', () => {
  it('follows a pick a person allowed, or credits as the default for an agent naming none', () => {
    expect(agentRunsOnCredits(claude, { id: 'a', account: 'dorkos-credits' }, false)).toBe(false);
    state.allowed = true;
    expect(agentRunsOnCredits(claude, { id: 'a', account: 'dorkos-credits' }, false)).toBe(true);
    expect(agentRunsOnCredits(claude, { id: undefined, account: 'dorkos-credits' }, false)).toBe(
      false
    );
    expect(agentRunsOnCredits(claude, { id: 'a', account: 'dorkos-credits' }, true)).toBe(true);
    state.isDefault = true;
    expect(agentRunsOnCredits(claude, { id: 'a', account: null }, false)).toBe(true);
    expect(agentRunsOnCredits(claude, { id: 'a', account: 'work' }, false)).toBe(false);
    expect(agentRunsOnCredits(codex, { id: 'a', account: null }, false)).toBe(false);
  });
});

describe('judging a model on credits', () => {
  it.each(['openai-chat-completions', 'openai-responses'] as const)(
    'judges the frozen %s protocol',
    async (protocol) => {
      const runtime = {
        getCapabilities: () => ({
          type: 'doe',
          credits: {
            protocol: 'anthropic-messages',
            scope: 'conversation',
            supportedProtocols: [
              'anthropic-messages',
              'openai-chat-completions',
              'openai-responses',
            ],
          },
        }),
        getSupportedModels: async () => [],
        getCreditsProtocol: (id?: string) => (id === 'frozen' ? protocol : 'anthropic-messages'),
      } as unknown as AgentRuntime;
      await creditsModelRefusal(runtime, 'md_served', 'frozen');
      expect(judgeCreditsModel).toHaveBeenLastCalledWith(
        expect.objectContaining({ credits: expect.objectContaining({ protocol }) }),
        'md_served',
        undefined
      );
    }
  );

  it('reads the id an alias expands to', async () => {
    expect(await resolvedModelFor(claude, 'sonnet')).toBe('md_served');
    expect(await resolvedModelFor(claude, 'md_served')).toBeUndefined();
    expect(
      await resolvedModelFor(
        {
          getSupportedModels: async () => Promise.reject(new Error('x')),
        } as unknown as AgentRuntime,
        'a'
      )
    ).toBeUndefined();
    expect(await creditsModelRefusal(claude, 'sonnet')).toBeNull();
    expect(await creditsModelRefusal(claude, 'opus')).toBe('not covered');
  });

  it('refuses an agent’s model only when the agent runs on credits', async () => {
    const base = { agentId: 'a', runtime: 'claude-code', model: 'opus', accountNamedNow: false };
    expect(await creditsAgentModelRefusal({ ...base, account: 'work' })).toBeNull();
    state.isDefault = true;
    expect(await creditsAgentModelRefusal({ ...base, account: null })).toBe('not covered');
    expect(await creditsAgentModelRefusal({ ...base, account: null, model: 'sonnet' })).toBeNull();
    expect(
      await creditsAgentModelRefusal({ ...base, runtime: 'not-installed', account: null })
    ).toBeNull();
  });
});

describe('sessionRunsOnCredits for a runtime with no account ladder', () => {
  const declares = { credits: { protocol: 'openai-responses', scope: 'conversation' } };
  it('asks the runtime about its own session when it can answer', async () => {
    const answers = (onCredits: boolean) =>
      ({
        type: 'codex',
        getCapabilities: () => declares,
        sessionRunsOnCredits: async () => onCredits,
      }) as unknown as AgentRuntime;
    expect(await sessionRunsOnCredits(answers(true), 's')).toBe(true);
    expect(await sessionRunsOnCredits(answers(false), 's')).toBe(false);
    // A stale pick of credits never overrules what the runtime says.
    expect(await sessionRunsOnCredits(answers(false), 's', { accountHint: 'dorkos-credits' })).toBe(
      false
    );
  });

  it('falls back to its recorded default, and to a pick of credits', async () => {
    const plain = { type: 'codex', getCapabilities: () => declares } as unknown as AgentRuntime;
    expect(await sessionRunsOnCredits(plain, 's')).toBe(false);
    expect(await sessionRunsOnCredits(plain, 's', { accountHint: 'dorkos-credits' })).toBe(true);
    state.isDefault = true;
    expect(await sessionRunsOnCredits(plain, 's')).toBe(true);
    expect(await sessionRunsOnCredits(codex, 's')).toBe(false);
  });
});
