/**
 * An agent DM'd by another agent is answered by the program IT runs on
 * (DOR-1627), and keeps that program for the whole conversation (DOR-1774).
 *
 * The end-to-end seam, with nothing stubbed between the manifest and the
 * runtime: a real `.dork/agent.json` on disk, the real `resolveTurnRuntimeType`
 * ladder, the real `runtimeRegistry` over a real SQLite, and the real built-in
 * adapter built by the real `createAdapter` wiring. A test that injected its own
 * resolver here would only prove the adapter calls what it is given — it could
 * not catch the composition root forgetting to give it anything, which is the
 * half of this change that lives in `adapter-factory.ts`.
 *
 * The database is real for the same reason (DOR-1774): the property that closes
 * the reroute is that the row the relay WRITES when a turn starts is the row the
 * next turn READS. A stubbed registry answering `bound: true` would only encode
 * the hypothesis that those two agree.
 *
 * The subject under test is `relay.agent.<namespace>.<agentId>`: a mesh
 * endpoint, the shape `relay_send` uses to reach another agent. It names no
 * runtime, so before this the default one answered — a Codex agent replying in
 * Claude Code, under its own name.
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

/**
 * A runtime that finishes any turn it is handed immediately.
 *
 * Two scenarios, so the same runtime can answer both turns of a conversation —
 * `FakeAgentRuntime` dequeues one per `sendMessage` and a spent queue yields
 * nothing at all, which would read as a turn that never started.
 */
function fakeRuntime(type: string): FakeAgentRuntime {
  const answer = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  };
  return new FakeAgentRuntime(type).withScenarios([answer, answer]);
}

/**
 * Write a real `.dork/agent.json`. The manifest read runs for real — a stub
 * would prove nothing about the rule under test, which is "does the relay read
 * the target agent's manifest".
 */
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

  beforeEach(async () => {
    claude = fakeRuntime('claude-code');
    codex = fakeRuntime('codex');
    // The REAL registry over a real database: the ladder asks it whether the
    // runtime a manifest names is one this build actually started, and — since
    // DOR-1774 — reads and writes the binding row that decides every turn after
    // the first.
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

  it('answers a claude-code agent on claude-code', async () => {
    await writeAgentManifest('claude-code', agentDir);

    await adapter.deliver(MESH_SUBJECT, agentEnvelope(), {
      agent: { directory: agentDir, runtime: 'claude-code' },
    });

    expect(claude.sendMessage).toHaveBeenCalledOnce();
    expect(codex.sendMessage).not.toHaveBeenCalled();
  });

  it('answers on the default runtime when the manifest names none', async () => {
    await writeAgentManifest(undefined, agentDir);

    const result = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), {
      agent: { directory: agentDir, runtime: 'claude-code' },
    });

    expect(result.success).toBe(true);
    expect(claude.sendMessage).toHaveBeenCalledOnce();
  });

  it('answers on the default runtime when the manifest names one this build did not start', async () => {
    // The soft edge `resolveAgentRuntimeType` documents, and the reason a
    // test-mode server — whose manifests all say `claude-code` — can answer
    // anything at all. It is a fallback INSIDE the ladder, so the adapter never
    // sees the unregistered name and never refuses on it.
    await writeAgentManifest('opencode', agentDir);

    const result = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), {
      agent: { directory: agentDir, runtime: 'claude-code' },
    });

    expect(result.success).toBe(true);
    expect(claude.sendMessage).toHaveBeenCalledOnce();
    expect(codex.sendMessage).not.toHaveBeenCalled();
  });

  it('answers on the default runtime when no agent directory resolved', async () => {
    const result = await adapter.deliver(MESH_SUBJECT, agentEnvelope());

    expect(result.success).toBe(true);
    expect(claude.sendMessage).toHaveBeenCalledOnce();
  });

  describe('and keeps that program for the rest of the conversation (DOR-1774)', () => {
    /** The delivery context `AdapterManager.buildContext` builds for this agent. */
    function meshContext(): { agent: { directory: string; runtime: string } } {
      return { agent: { directory: agentDir, runtime: 'claude-code' } };
    }

    it('a manifest edited mid-conversation does not move it to another program', async () => {
      // The reroute this closes, end to end. The first turn binds this
      // conversation to codex; the manifest then says claude-code — which is a
      // preference about the agent's NEXT conversation, not a fact about the one
      // whose transcript is sitting in codex. Handing turn two to claude-code
      // would hand it the session key codex minted and no history to go with it
      // (the DOR-764 shape).
      await writeAgentManifest('codex', agentDir);
      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      await writeAgentManifest('claude-code', agentDir);
      const second = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(second.success).toBe(true);
      expect(codex.sendMessage).toHaveBeenCalledTimes(2);
      expect(claude.sendMessage).not.toHaveBeenCalled();
      // The write and the read are the same row — the thing no injected double
      // could show.
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toEqual({
        type: 'codex',
        bound: true,
      });
    });

    it('leaves no binding behind when the first turn never ran', async () => {
      // The orphan-row hazard `room-turn-runner.ts` documents. A row written on
      // arrival is indistinguishable afterwards from one a real turn wrote, so
      // one failed message would pin a conversation that never existed to
      // whichever program happened to be asked first.
      await writeAgentManifest('codex', agentDir);
      codex.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          throw new Error('the runtime fell over before it said anything');
        },
      ]);

      const result = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(result.success).toBe(false);
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toEqual({
        type: 'claude-code',
        bound: false,
      });
    });

    it('a failed first turn leaves the manifest in charge of the next one', async () => {
      // The consequence of the row above being absent, and the reason "no row"
      // is the right outcome rather than a tidy one: nothing was decided, so the
      // agent's own manifest decides again — and still reaches codex.
      await writeAgentManifest('codex', agentDir);
      codex.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          throw new Error('the runtime fell over before it said anything');
        },
        async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'done', data: {} } as StreamEvent;
        },
      ]);

      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());
      const second = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(second.success).toBe(true);
      expect(codex.sendMessage).toHaveBeenCalledTimes(2);
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toEqual({
        type: 'codex',
        bound: true,
      });
    });
  });
});
