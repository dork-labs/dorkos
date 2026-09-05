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
/** The id claude-code renames its session to once a turn has started. */
const SDK_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * A turn that says something. Content rather than a bare `done`, because a
 * `done` is an ENDING and the binding write only counts turns that produced
 * something (`isTurnContentEvent`) — a fake that only ends never binds.
 */
async function* answerScenario(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'here' } } as StreamEvent;
  yield { type: 'done', data: {} } as StreamEvent;
}

/**
 * A runtime that finishes any turn it is handed immediately.
 *
 * Two scenarios, so the same runtime can answer both turns of a conversation —
 * `FakeAgentRuntime` dequeues one per `sendMessage` and a spent queue yields
 * nothing at all, which would read as a turn that never started.
 */
function fakeRuntime(type: string): FakeAgentRuntime {
  return new FakeAgentRuntime(type).withScenarios([answerScenario, answerScenario]);
}

/**
 * Teach a fake to rename its own session, the way claude-code does.
 *
 * `AgentRuntime` does not declare `getSdkSessionId` — renaming your own
 * sessions is a Claude Code habit, not a runtime contract — so the real
 * `FakeAgentRuntime` has none and every key stays the one DorkOS handed over.
 * The relay's durable-key rule only has anything to do on a runtime that DOES
 * rename, so a harness without this proves that half of DOR-1774 not at all.
 *
 * @param runtime - The fake to teach.
 * @param sdkSessionId - The id it reports once a turn has started.
 */
function renamingItsOwnSessions(runtime: FakeAgentRuntime, sdkSessionId: string): FakeAgentRuntime {
  return Object.assign(runtime, { getSdkSessionId: () => sdkSessionId });
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
  /**
   * The agent-key → SDK-session-id map, wired for real.
   *
   * Without one the adapter warns and every turn runs under the agent key, so
   * the durable-key half of DOR-1774 — bind the id the runtime RENAMED to, not
   * the one the turn started on — has no path to execute and no way to fail.
   */
  let sessionStore: Map<string, string>;

  beforeEach(async () => {
    sessionStore = new Map<string, string>();
    claude = renamingItsOwnSessions(fakeRuntime('claude-code'), SDK_ID);
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
    // The claude-code agent is the subject here rather than the codex one,
    // because claude-code is the runtime that RENAMES its own session
    // mid-flight. That rename is what makes the durable-key rule real: turn one
    // runs under the agent key, turn two under the id the runtime minted, and
    // binding the wrong one of those two closes nothing.

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
      // The reroute this closes, end to end. The first turn binds this
      // conversation to claude-code; the manifest then says codex — which is a
      // preference about the agent's NEXT conversation, not a fact about the one
      // whose transcript is sitting in claude-code. Handing turn two to codex
      // would hand it the session key claude-code minted and no history to go
      // with it (the DOR-764 shape).
      await writeAgentManifest('claude-code', agentDir);
      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      await writeAgentManifest('codex', agentDir);
      const second = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(second.success).toBe(true);
      expect(claude.sendMessage).toHaveBeenCalledTimes(2);
      expect(codex.sendMessage).not.toHaveBeenCalled();
      // The write and the read are the same row — the thing no injected double
      // could show.
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toEqual({
        type: 'claude-code',
        bound: true,
      });
    });

    it('binds the id the runtime renamed to, not the one the first turn started on', async () => {
      // The durable key, executed rather than asserted through a double: the
      // store really maps the agent key to the SDK id, and the row really lands
      // under the SDK id. A binding under the agent key would be a row nothing
      // ever reads again, leaving the manifest in charge of every later turn.
      await writeAgentManifest('claude-code', agentDir);

      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(sessionStore.get(AGENT_ID)).toBe(SDK_ID);
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toMatchObject({ bound: true });
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toMatchObject({ bound: false });
    });

    it('leaves no binding behind when the first turn reached no runtime at all', async () => {
      // The orphan-row hazard `room-turn-runner.ts` documents. A row written on
      // arrival is indistinguishable afterwards from one a real turn wrote, so
      // one failed message would pin a conversation that never existed to
      // whichever program happened to be asked first.
      await writeAgentManifest('claude-code', agentDir);
      claude.withScenarios([crashScenario]);

      const result = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(result.success).toBe(false);
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toMatchObject({ bound: false });
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toMatchObject({ bound: false });
    });

    it('leaves no binding behind when the first turn only reported an error', async () => {
      // The case that makes this gate about CONTENT rather than about events. A
      // turn that never reached the model still emits: the credential failure
      // arrives as an `error` event rather than a throw, with a terminal `done`
      // under it. Binding on that pins the agent on the strength of "not signed
      // in" — permanently, because this shape keys its conversation by the agent
      // id alone and `persistSessionRuntime` is first-write-wins.
      await writeAgentManifest('claude-code', agentDir);
      claude.withScenarios([notSignedInScenario]);

      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(await runtimeRegistry.resolveSessionRuntime(AGENT_ID)).toMatchObject({ bound: false });
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toMatchObject({ bound: false });
    });

    it('lets the operator’s correction take effect after an error-only first turn', async () => {
      // Why "no row" is the right outcome rather than a tidy one, and the input
      // `main` recovered from: the operator reads "not signed in", switches the
      // agent to codex, and sends again. With a binding written from that first
      // turn nothing could ever move it — there is no next conversation to
      // correct it on and no UI over the row.
      await writeAgentManifest('claude-code', agentDir);
      claude.withScenarios([notSignedInScenario]);
      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      await writeAgentManifest('codex', agentDir);
      const second = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(second.success).toBe(true);
      expect(codex.sendMessage).toHaveBeenCalledOnce();
    });

    it('a crashed first turn leaves the manifest in charge of the next one', async () => {
      // The same recovery from the other failure shape: nothing was decided, so
      // the agent's own manifest decides again — and the turn that DOES produce
      // something is the one that binds.
      await writeAgentManifest('claude-code', agentDir);
      claude.withScenarios([crashScenario, answerScenario]);

      await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());
      const second = await adapter.deliver(MESH_SUBJECT, agentEnvelope(), meshContext());

      expect(second.success).toBe(true);
      expect(claude.sendMessage).toHaveBeenCalledTimes(2);
      expect(codex.sendMessage).not.toHaveBeenCalled();
      expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toEqual({
        type: 'claude-code',
        bound: true,
      });
    });
  });
});
