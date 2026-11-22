/**
 * The built-in claude-code adapter is built WITH the desk guard (spec
 * `agent-home-desk` §3.4). The guard itself is tested in
 * `core/agent-identity/__tests__/turn-desk-check.test.ts`; this pins that the
 * factory hands it to the adapter, and wires it to the session-cwd chain and the
 * session's agent: the recorded one, else its folder's (DOR-5038). Seeded:
 * dropping `checkTurnDesk` from the factory reddens the first case.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntimeLike, TurnDeskCheck } from '@dorkos/relay';
import type { Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';

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

vi.mock('../../core/runtime-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/runtime-registry.js')>();
  return {
    ...actual,
    runtimeRegistry: {
      computerRuntimeForAgentPath: () => undefined,
      getNativeSessionCwd: vi.fn(() => null),
      getDefaultType: () => 'claude-code',
    },
  };
});

import { createAdapter, type AdapterFactoryDeps } from '../adapter-factory.js';
import { RuntimeRegistry } from '../../core/runtime-registry.js';
import { setSessionAgentSources } from '../../core/agent-identity/session-agent.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';

describe('the claude-code adapter the factory builds', () => {
  let scratch: string;
  let agent: string;
  let other: string;
  let roomsDir: string;
  let db: Db;
  let live: Record<string, string>;

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-desk-')));
    agent = path.join(scratch, 'agents', 'a');
    other = path.join(scratch, 'agents', 'b');
    roomsDir = path.join(scratch, 'dork', 'rooms');
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(path.join(roomsDir, 'r1', 'repo'), { recursive: true });
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  beforeEach(() => {
    db = createTestDb();
    live = {};
    setSessionAgentSources({ db, liveCwd: (sessionId) => live[sessionId] });
  });
  afterEach(() => {
    setSessionAgentSources(undefined);
    clearTestHomes();
  });

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

  /** A real chat, bound through the registry's own write: with `agentPath`, or with none. */
  async function boundChat(sessionId: string, agentPath?: string): Promise<void> {
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    registry.register(new FakeAgentRuntime('claude-code') as never);
    await registry.persistSessionRuntime(
      sessionId,
      'claude-code',
      { kind: 'interactive' },
      agentPath
    );
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
    await boundChat('s-1', agent);

    const check = await build();

    await expect(
      check({ cwd: agent, agentDirectory: undefined, forAgent: undefined, sessionKey: 's-1' })
    ).resolves.toBeNull();
    expect(resolveSessionCwd).toHaveBeenCalledWith({ agentPath: agent });
  });

  // DOR-5038: a chat started in an agent's folder from the command line records no agent.
  it('takes an unrecorded chat`s agent from its folder, and still refuses another agent', async () => {
    registerTestHomes([agent, other], { roomsDir });
    resolveSessionCwd.mockResolvedValue({ cwd: agent, rung: 'agent-home' });
    await boundChat('s-cli');
    live['s-cli'] = agent;

    const check = await build();

    await expect(
      check({ cwd: agent, agentDirectory: undefined, forAgent: undefined, sessionKey: 's-cli' })
    ).resolves.toBeNull();
    await expect(
      check({ cwd: other, agentDirectory: undefined, forAgent: other, sessionKey: 's-cli' })
    ).resolves.toContain('different agent');
  });

  it('refuses an unrecorded chat whose folder is unknown, as before', async () => {
    registerTestHomes([agent], { roomsDir });
    await boundChat('s-gone');

    const check = await build();

    await expect(
      check({ cwd: agent, agentDirectory: undefined, forAgent: undefined, sessionKey: 's-gone' })
    ).resolves.toEqual(expect.any(String));
  });
});
