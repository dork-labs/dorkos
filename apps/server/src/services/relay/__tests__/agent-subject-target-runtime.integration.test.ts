/**
 * An agent DM'd by another agent is answered by the program IT runs on
 * (DOR-1627), and keeps that program for the whole conversation (DOR-1774).
 * Nothing is stubbed between the manifest and the runtime: a real manifest, the
 * real ladder, the real `runtimeRegistry` over SQLite (the row a turn WRITES is
 * the row the next one READS), and the adapter built by the real `createAdapter`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AdapterConfig, RelayAdapter, RelayPublisher, TraceStoreLike } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { createAdapter } from '../adapter-factory.js';

const AGENT_ID = '01AGENTULIDDOR1627';
const MESH_SUBJECT = `relay.agent.ana.${AGENT_ID}`;
/** The id claude-code renames its session to once a turn has started. */
const SDK_ID = '550e8400-e29b-41d4-a716-446655440000';

/** A turn that says something: the binding write only counts turns with content. */
async function* answerScenario(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'here' } } as StreamEvent;
  yield { type: 'done', data: {} } as StreamEvent;
}

/** A runtime that answers two turns (a spent fake yields nothing at all). */
function fakeRuntime(type: string): FakeAgentRuntime {
  return new FakeAgentRuntime(type).withScenarios([answerScenario, answerScenario]);
}

/** Teach a fake to rename its own session, as claude-code does, so the durable-key rule has work to do. */
function renamingItsOwnSessions(runtime: FakeAgentRuntime, sdkSessionId: string): FakeAgentRuntime {
  return Object.assign(runtime, { getSdkSessionId: () => sdkSessionId });
}

/** Write a real `.dork/agent.json`. */
async function writeAgentManifest(runtime: string | undefined, dir: string): Promise<void> {
  await mkdir(path.join(dir, '.dork'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: 'Ana',
      registeredAt: '2026-09-03T10:00:00.000Z',
      registeredBy: 'test',
      ...(runtime ? { runtime } : {}),
    })
  );
}

function relayStub(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'r-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as RelayPublisher;
}

function agentEnvelope(): RelayEnvelope {
  return {
    id: 'msg-1627',
    subject: MESH_SUBJECT,
    from: 'agent:01SENDERULID',
    replyTo: 'relay.inbox.01SENDERULID',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'are you there?' },
  } as unknown as RelayEnvelope;
}

describe('a mesh agent subject runs on the target agent’s own runtime', () => {
  let claude: FakeAgentRuntime;
  let codex: FakeAgentRuntime;
  let agentDir: string;
  let adapter: RelayAdapter;
  /** The agent-key → SDK-session-id map, wired for real so the durable key can fail. */
  let sessionStore: Map<string, string>;

  beforeEach(async () => {
    sessionStore = new Map<string, string>();
    claude = renamingItsOwnSessions(fakeRuntime('claude-code'), SDK_ID);
    codex = fakeRuntime('codex');
    runtimeRegistry.setDb(createTestDb());
    runtimeRegistry.register(claude);
    runtimeRegistry.register(codex);
    runtimeRegistry.setDefault('claude-code');
    agentDir = await mkdtemp(path.join(tmpdir(), 'dorkos-dor1627-agent-'));

    const config = {
      id: 'claude-code',
      type: 'claude-code',
      enabled: true,
      builtin: true,
      config: {},
    };
    const built = await createAdapter(
      config as AdapterConfig,
      {
        agentRuntimes: new Map([
          ['claude-code', claude],
          ['codex', codex],
        ]),
        traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike,
        agentSessionStore: {
          get: (agentId: string) => sessionStore.get(agentId),
          set: (agentId: string, sdkSessionId: string) =>
            void sessionStore.set(agentId, sdkSessionId),
        },
        approvalAuthorizer: () => true,
      },
      '/tmp/adapters.json'
    );
    if (!built) throw new Error('the built-in adapter did not build');
    adapter = built;
    await adapter.start(relayStub());
  });

  afterEach(async () => {
    await adapter.stop();
    await rm(agentDir, { recursive: true, force: true });
  });

  it('answers a codex agent on codex, not on the default runtime', async () => {
    await writeAgentManifest('codex', agentDir);

    const result = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), {
      agent: { directory: agentDir, runtime: 'claude-code' },
    });

    expect(result.success).toBe(true);
    expect(codex.sendMessage).toHaveBeenCalledOnce();
    expect(claude.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['the manifest names none', undefined, true],
    ['the manifest names one this build did not start', 'opencode', true],
    ['no agent directory resolved', undefined, false],
  ])('answers on the default runtime when %s', async (_label, runtime, withDir) => {
    await writeAgentManifest(runtime, agentDir);
    const result = await adapter.deliver(
      MESH_SUBJECT,
      agentEnvelope(),
      withDir ? { agent: { directory: agentDir, runtime: 'claude-code' } } : undefined
    );
    expect(result.success).toBe(true);
    expect(claude.sendMessage).toHaveBeenCalledOnce();
    expect(codex.sendMessage).not.toHaveBeenCalled();
  });

  describe('and keeps that program for the rest of the conversation (DOR-1774)', () => {
    /** The delivery context `AdapterManager.buildContext` builds for this agent. */
    function meshContext(): { agent: { directory: string; runtime: string } } {
      return { agent: { directory: agentDir, runtime: 'claude-code' } };
    }

    /** A turn that dies before it says anything. */
    async function* crashScenario(): AsyncGenerator<StreamEvent> {
      throw new Error('the runtime fell over before it said anything');
    }

    /** A turn that reports it cannot run and then ends — events, but no content. */
    async function* notSignedInScenario(): AsyncGenerator<StreamEvent> {
      yield {
        type: 'error',
        data: { message: 'Not signed in. Run `claude auth login`.' },
      } as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    }

    it('a manifest edited mid-conversation does not move it to another program', async () => {
      await writeAgentManifest('claude-code', agentDir);
      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      await writeAgentManifest('codex', agentDir);
      const second = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(second.success).toBe(true);
      expect(claude.sendMessage).toHaveBeenCalledTimes(2);
      expect(codex.sendMessage).not.toHaveBeenCalled();
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toEqual({
        type: 'claude-code',
        bound: true,
      });
    });

    it('binds the id the runtime renamed to, not the one the first turn started on', async () => {
      await writeAgentManifest('claude-code', agentDir);

      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(sessionStore.get(AGENT_ID)).toBe(SDK_ID);
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toMatchObject({ bound: true });
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toMatchObject({ bound: false });
    });

    it.each([
      ['crashed', crashScenario],
      ['only reported an error', notSignedInScenario],
    ])('leaves no binding behind when the first turn %s', async (_label, scenario) => {
      await writeAgentManifest('claude-code', agentDir);
      claude.withScenarios([scenario]);
      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toMatchObject({ bound: false });
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toMatchObject({ bound: false });
    });
  });
});
