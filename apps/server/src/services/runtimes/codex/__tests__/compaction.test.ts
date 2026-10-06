/**
 * A person's `/compact` and the agent's own `compact_my_session` on Codex
 * (DOR-2732), through `CodexRuntime.executeCommandIntent` over the fake
 * app-server: which transport can summarize, that a summary is an open turn
 * while it runs, that a focus note goes nowhere, and that the thread is told
 * who it is again after one.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../check-dependencies.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../check-dependencies.js')>()),
  checkCodexDependencies: vi.fn(() => []),
}));
vi.mock('../enumerate-mcp-servers.js', () => ({
  enumerateCodexMcpServers: vi.fn(async () => null),
}));

import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { SessionEventStore, setSessionEventStore } from '../../../session/index.js';
import { resetMessageDispatcher } from '../../../session/message-dispatcher.js';
import { AgentCompactionService } from '../../../session/agent-compaction/agent-compaction-service.js';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';
import { CodexAppServerPool } from '../app-server/process-pool.js';
import { AppServerCodexTransport } from '../transport/app-server-transport.js';
import { FakeAppServerHost, parkedCompactionTurn } from './fake-app-server.js';

const HOME = '/fake/compaction/person';
const pools: CodexAppServerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

function appServerRuntime() {
  const host = new FakeAppServerHost();
  const pool = new CodexAppServerPool({ spawn: host.spawn, timing: { shutdownStepMs: 10 } });
  pools.push(pool);
  const transport = new AppServerCodexTransport({
    pool,
    connectorTools: () => undefined,
    environment: {
      person: () => ({ PATH: '/usr/bin', CODEX_HOME: HOME }),
      credits: () => ({ PATH: '/usr/bin', CODEX_HOME: '/fake/compaction/credits' }),
    },
    stopAckMs: 1_000,
  });
  const runtime = new CodexRuntime({
    threadMap: new CodexThreadMap(createTestDb()),
    resolveBinary: async () => '/opt/codex',
    transport,
  });
  return { runtime, home: host.home(HOME) };
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/** The prompt text of every turn/start the fake received. */
function prompts(home: ReturnType<typeof appServerRuntime>['home']): string[] {
  return home.processes
    .flatMap((process) => process.requestsOf('turn/start'))
    .map((params) =>
      ((params.input as Array<{ text: string }> | undefined) ?? []).map((i) => i.text).join('')
    );
}

describe('which Codex can summarize', () => {
  it('declares compact on app-server, and not on exec, where executeCommandIntent refuses', async () => {
    const { runtime } = appServerRuntime();
    expect(runtime.getCapabilities().commandIntents.compact.supported).toBe(true);

    const exec = new CodexRuntime({
      threadMap: new CodexThreadMap(createTestDb()),
      transport: 'exec',
    });
    expect(exec.getCapabilities().commandIntents.compact.supported).toBe(false);
    await expect(drain(exec.executeCommandIntent('s1', 'compact'))).rejects.toThrow(/exec/);
  });
});

describe('a summary on app-server', () => {
  it('RT-CMP-01: summarizes the session’s own thread, ignoring a focus note Codex cannot take', async () => {
    const { runtime, home } = appServerRuntime();
    await drain(runtime.sendMessage('s1', 'hello', { cwd: '/project' }));
    const events = await drain(
      runtime.executeCommandIntent('s1', 'compact', {
        cwd: '/project',
        instructions: 'keep the migration plan',
      })
    );
    const compacts = home.processes.flatMap((p) => p.requestsOf('thread/compact/start'));
    expect(compacts).toHaveLength(1);
    expect(Object.keys(compacts[0]!)).toEqual(['threadId']);
    expect(events.filter((e) => e.type === 'compact_boundary')).toEqual([
      { type: 'compact_boundary', data: expect.objectContaining({ trigger: 'manual' }) },
    ]);
    expect(events.at(-1)?.type).toBe('done');
    expect(runtime.isTurnOpen('s1')).toBe(false);
  });

  it('is an open turn while it runs, and a stop ends it', async () => {
    const { runtime, home } = appServerRuntime();
    await drain(runtime.sendMessage('s1', 'hello', { cwd: '/project' }));
    home.compactionScripts.push(parkedCompactionTurn);
    const gen = runtime.executeCommandIntent('s1', 'compact', { cwd: '/project' });
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'operation_progress', data: { state: 'started' } });
    expect(runtime.isTurnOpen('s1')).toBe(true);

    expect(await runtime.interruptQuery('s1')).toMatchObject({ outcome: 'acked' });
    const rest = await drain(gen);
    expect(rest.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(runtime.isTurnOpen('s1')).toBe(false);
  });

  it('tells the thread who it is again on the turn after a summary', async () => {
    const { runtime, home } = appServerRuntime();
    await drain(runtime.sendMessage('s1', 'one', { cwd: '/project' }));
    await drain(runtime.sendMessage('s1', 'two', { cwd: '/project' }));
    await drain(runtime.executeCommandIntent('s1', 'compact', { cwd: '/project' }));
    await drain(runtime.sendMessage('s1', 'three', { cwd: '/project' }));

    const [first, second, third] = prompts(home);
    // `<env>` rides the gated half of DorkOS's context (no agent here, so
    // there is no identity block to look for).
    expect(first).toContain('<env>');
    // Already in the thread, so not sent again…
    expect(second).not.toContain('<env>');
    // …until a summary may have dropped it.
    expect(third).toContain('<env>');
  });

  it('says there is nothing to summarize on a session that never ran a turn', async () => {
    const { runtime, home } = appServerRuntime();
    runtime.ensureSession('s-new', { permissionMode: 'default', cwd: '/project' });
    const events = await drain(
      runtime.executeCommandIntent('s-new', 'compact', { cwd: '/project' })
    );
    expect(events.map((e) => e.type)).toEqual(['operation_progress', 'done']);
    expect(home.processes.flatMap((p) => p.requestsOf('thread/start'))).toHaveLength(0);
  });
});

describe('RT-CMP-02 on Codex — the agent asks for its own summary', () => {
  const SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const CWD = '/projects/codex';
  afterEach(() => {
    resetMessageDispatcher();
    disposeProjector(SESSION);
    setSessionEventStore(undefined);
  });

  it('RT-CMP-02: summarizes on the agent’s request, and the reopened chat keeps that the agent asked', async () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const { runtime, home } = appServerRuntime();
    await drain(runtime.sendMessage(SESSION, 'hello', { cwd: CWD }));
    getOrCreateProjector(SESSION, CWD, { persist: 'history' }).seedStatus({
      contextUsage: {
        totalTokens: 180_000,
        maxTokens: 200_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    const compaction = new AgentCompactionService({ resolveRuntime: async () => runtime });

    const outcome = await compaction.request({ sessionId: SESSION, note: 'keep the plan' });
    expect(outcome.status).toBe('scheduled');

    const projector = getOrCreateProjector(SESSION, CWD, { persist: 'history' });
    await expect
      .poll(() => projector.replayFrom(0).some((event) => event.type === 'compact_boundary'))
      .toBe(true);
    expect(
      projector.replayFrom(0).find((event) => event.type === 'compact_boundary')
    ).toMatchObject({ requestedBy: 'agent', contextPercent: 90, trigger: 'manual' });
    expect(home.processes.flatMap((p) => p.requestsOf('thread/compact/start'))).toHaveLength(1);
    await expect.poll(() => runtime.isTurnOpen(SESSION)).toBe(false);

    // Gone from memory, as after a restart: history is rebuilt from the record.
    await expect
      .poll(() => projector.replayFrom(0).some((event) => event.type === 'turn_end'))
      .toBe(true);
    disposeProjector(SESSION);
    const history = await runtime.getMessageHistory(CWD, SESSION);
    const row = history.find((message) => message.messageType === 'compaction');
    expect(row?.compactMetadata).toMatchObject({ requestedBy: 'agent', contextPercent: 90 });
  });
});
