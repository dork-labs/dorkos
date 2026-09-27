/**
 * The built-in claude-code adapter is built WITH the desk guard (spec
 * `agent-home-desk` §3.4). The guard itself is tested in
 * `core/agent-identity/__tests__/turn-desk-check.test.ts`; this pins that the
 * factory hands it to the adapter, and wires it to the session-cwd chain and the
 * session's recorded agent. Seeded: dropping `checkTurnDesk` from the factory
 * reddens the first case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntimeLike, TurnDeskCheck } from '@dorkos/relay';

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

const resolveSessionCwd = vi.hoisted(() => vi.fn());
vi.mock('../../workspace/resolve-session-cwd.js', () => ({ resolveSessionCwd }));

const getSessionAgentPath = vi.hoisted(() => vi.fn(async () => null as string | null));
vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: { getSessionAgentPath, getDefaultType: () => 'claude-code' },
}));

import { createAdapter, type AdapterFactoryDeps } from '../adapter-factory.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';

describe('the claude-code adapter the factory builds', () => {
  let scratch: string;
  let agent: string;
  let roomsDir: string;

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-desk-')));
    agent = path.join(scratch, 'agents', 'a');
    roomsDir = path.join(scratch, 'dork', 'rooms');
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(path.join(roomsDir, 'r1', 'repo'), { recursive: true });
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  afterEach(() => clearTestHomes());

  async function build(): Promise<TurnDeskCheck> {
    captured.deps = null;
    await createAdapter(
      { id: 'claude-code', type: 'claude-code', enabled: true, config: {} } as never,
      {
        agentRuntimes: new Map([['claude-code', {} as AgentRuntimeLike]]),
        traceStore: {},
      } as unknown as AdapterFactoryDeps,
      '/tmp/adapters.json'
    );
    const deps = captured.deps as Record<string, unknown> | null;
    const check = deps?.checkTurnDesk as TurnDeskCheck | undefined;
    expect(check).toBeTypeOf('function');
    return check!;
  }

  it('refuses a turn that would stand in a room`s files', async () => {
    registerTestHomes([agent], { roomsDir });
    resolveSessionCwd.mockResolvedValue({ cwd: agent, rung: 'agent-home' });

    const check = await build();

    await expect(
      check({
        cwd: path.join(roomsDir, 'r1', 'repo'),
        agentDirectory: agent,
        forAgent: undefined,
        sessionKey: 's',
      })
    ).resolves.toContain('room');
  });

  it('reads the agent`s desk from the session-cwd chain, for the session`s recorded agent', async () => {
    registerTestHomes([agent], { roomsDir });
    resolveSessionCwd.mockResolvedValue({ cwd: agent, rung: 'agent-home' });
    getSessionAgentPath.mockResolvedValueOnce(agent);

    const check = await build();

    await expect(
      check({ cwd: agent, agentDirectory: undefined, forAgent: undefined, sessionKey: 's-1' })
    ).resolves.toBeNull();
    expect(getSessionAgentPath).toHaveBeenCalledWith('s-1');
    expect(resolveSessionCwd).toHaveBeenCalledWith({ agentPath: agent });
  });
});
