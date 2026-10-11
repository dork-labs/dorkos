/**
 * The built-in claude-code adapter notes, before every relay turn runs, who
 * started it (PR 3 review B1): the factory hands it `noteTurnStart`, wired to
 * the outsider-turn record, so an A2A or bridged sender's turn reads as a
 * stranger's and one of our agents' does not. Seeded: dropping `noteTurnStart`
 * from the factory reddens this.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeLike } from '@dorkos/relay';

const captured = vi.hoisted(() => ({ deps: null as Record<string, unknown> | null }));

vi.mock('@dorkos/relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dorkos/relay')>();
  class CapturingClaudeCodeAdapter {
    constructor(_id: string, _config: unknown, deps: Record<string, unknown>) {
      captured.deps = deps;
    }
  }
  return { ...actual, ClaudeCodeAdapter: CapturingClaudeCodeAdapter };
});

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getNativeSessionCwd: vi.fn(() => null),
    getSessionAgentPath: vi.fn(async () => null),
    getDefaultType: () => 'claude-code',
  },
}));

import { createAdapter, type AdapterFactoryDeps } from '../adapter-factory.js';
import { resetOutsiderTurns, turnStartedByOutsider } from '../../session/origin/outsider-turns.js';

afterEach(() => resetOutsiderTurns());

describe('the claude-code adapter the factory builds', () => {
  it('notes at turn start whether a stranger sent the message', async () => {
    await createAdapter(
      { id: 'claude-code', type: 'claude-code', enabled: true, config: {} } as never,
      {
        agentRuntimes: new Map([['claude-code', {} as AgentRuntimeLike]]),
        traceStore: {},
      } as unknown as AdapterFactoryDeps,
      '/tmp/adapters.json'
    );
    const noteTurnStart = captured.deps?.noteTurnStart as
      ((turn: { sessionId: string; from: string }) => void) | undefined;
    expect(noteTurnStart).toBeTypeOf('function');
    noteTurnStart!({ sessionId: 's-a2a', from: 'a2a-gateway' });
    noteTurnStart!({ sessionId: 's-telegram', from: 'relay.human.telegram.4242' });
    noteTurnStart!({ sessionId: 's-agent', from: 'relay.agent.default.agent-02' });
    expect(turnStartedByOutsider('s-a2a')).toBe(true);
    expect(turnStartedByOutsider('s-telegram')).toBe(true);
    expect(turnStartedByOutsider('s-agent')).toBe(false);
  });
});
