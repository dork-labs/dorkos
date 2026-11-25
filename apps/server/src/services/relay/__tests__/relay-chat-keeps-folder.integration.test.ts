/**
 * A chat an agent starts over relay keeps its folder and its agent on every
 * turn, after a restart too (DOR-5245).
 *
 * The first message carries the place the server sealed for the new chat. The
 * turn records the chat's runtime and agent, and the claude-code runtime renames
 * the chat to its own id. A restart then leaves nothing in memory: a fresh
 * runtime and a fresh adapter, and only the database and the adapter's
 * conversation map survive. The next message carries no place, and its turn
 * still runs in the agent's home and as that agent.
 *
 * Nothing between the adapter and the database is stubbed: the adapter is the
 * one `createAdapter` builds, over the real `runtimeRegistry` on SQLite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  CARRIED_TURN_LIMITS_FIELD,
  sealTurnLimits,
  type AdapterConfig,
  type RelayAdapter,
  type RelayPublisher,
  type TraceStoreLike,
} from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { initBoundary } from '../../../lib/boundary.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { setSessionAgentSources } from '../../core/agent-identity/session-agent.js';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';
import { createAdapter } from '../adapter-factory.js';

// The boot's own registration, so the protected-folder rule can read the account folders.
registerClaudeCodeFacts();

const CHAT = '00000000-0000-4000-8000-0000000052c5';
const SUBJECT = `relay.agent.claude-code.${CHAT}`;
const SOL_SUBJECT = 'relay.agent.claude-code.sol-id';
/** The id claude-code renames the chat to once its first turn starts. */
const SDK_ID = '550e8400-e29b-41d4-a716-4466554452c5';

/** A turn that says something: only a turn with content records its chat. */
async function* answerScenario(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'here' } } as StreamEvent;
  yield { type: 'done', data: {} } as StreamEvent;
}

/** A claude-code runtime with nothing in memory, which renames the chats it starts. */
function freshClaudeCode(): FakeAgentRuntime {
  return Object.assign(new FakeAgentRuntime('claude-code').withScenarios([answerScenario]), {
    getSdkSessionId: () => SDK_ID,
  });
}

function relayStub(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'r-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as RelayPublisher;
}

/** A codex runtime with nothing in memory, which keeps the key it was given. */
function freshCodex(): FakeAgentRuntime {
  return new FakeAgentRuntime('codex').withScenarios([answerScenario]);
}

function message(payload: Record<string, unknown>, subject = SUBJECT): RelayEnvelope {
  return {
    id: `msg-${Math.random()}`,
    subject,
    from: SOL_SUBJECT,
    replyTo: 'relay.inbox.query.q-52c5',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'hello', ...payload },
  } as unknown as RelayEnvelope;
}

/** Where a turn's runtime was told to run it, and as whom. */
function turnOf(runtime: FakeAgentRuntime) {
  const [key, , sent] = vi.mocked(runtime.sendMessage).mock.calls.at(-1)!;
  const ensured = vi.mocked(runtime.ensureSession).mock.calls.at(-1)![1];
  const opts = sent as { cwd?: string; forAgent?: string };
  return {
    key,
    cwd: opts.cwd,
    forAgent: opts.forAgent,
    ensuredCwd: ensured.cwd,
    hasStarted: ensured.hasStarted,
  };
}

describe('a chat an agent started over relay', () => {
  let scratch: string;
  let sol: string;
  /** The adapter's conversation map, which a restart keeps. */
  let conversations: Map<string, string>;
  let adapter: RelayAdapter | null;

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-keeps-folder-')));
    sol = path.join(scratch, 'agents', 'sol');
    fs.mkdirSync(sol, { recursive: true });
    await initBoundary(scratch);
  });

  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  beforeEach(() => {
    conversations = new Map();
    adapter = null;
    runtimeRegistry.setDb(createTestDb());
    registerTestHomes([sol]);
    setSessionAgentSources({ liveCwd: () => undefined });
  });

  afterEach(async () => {
    await adapter?.stop();
    setSessionAgentSources(undefined);
    clearTestHomes();
  });

  /** Boot: register this runtime and build the adapter over it. */
  async function boot(runtime: FakeAgentRuntime): Promise<RelayAdapter> {
    await adapter?.stop();
    runtimeRegistry.register(runtime as never);
    runtimeRegistry.setDefault(runtime.type);
    const built = await createAdapter(
      {
        id: 'claude-code',
        type: 'claude-code',
        enabled: true,
        builtin: true,
        config: {},
      } as AdapterConfig,
      {
        agentRuntimes: new Map([[runtime.type, runtime]]),
        traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike,
        agentSessionStore: {
          get: (key: string) => conversations.get(key),
          set: (key: string, id: string) => void conversations.set(key, id),
        },
        approvalAuthorizer: () => true,
      },
      '/tmp/adapters.json'
    );
    if (!built) throw new Error('the built-in adapter did not build');
    adapter = built;
    await adapter.start(relayStub());
    return adapter;
  }

  it('keeps its folder and its agent on the next turn after a restart', async () => {
    const first = freshClaudeCode();
    await boot(first);
    const placed = sealTurnLimits(SOL_SUBJECT, {
      newChat: { sessionKey: CHAT, cwd: sol, forAgent: sol },
    });
    const opened = await adapter!.deliver(
      SUBJECT,
      message({ [CARRIED_TURN_LIMITS_FIELD]: placed })
    );
    expect(opened.success).toBe(true);
    expect(turnOf(first)).toMatchObject({ key: CHAT, cwd: sol, forAgent: sol });

    const restarted = freshClaudeCode();
    await boot(restarted);
    const next = await adapter!.deliver(SUBJECT, message({}));

    expect(next.success).toBe(true);
    expect(turnOf(restarted)).toEqual({
      key: SDK_ID,
      cwd: sol,
      forAgent: sol,
      ensuredCwd: sol,
      hasStarted: true,
    });
  });

  it('keeps its folder and its agent after a restart on a runtime that keeps its key', async () => {
    const subject = `relay.agent.codex.${CHAT}`;
    const placed = sealTurnLimits(SOL_SUBJECT, {
      newChat: { sessionKey: CHAT, cwd: sol, forAgent: sol },
    });
    const first = freshCodex();
    await boot(first);
    await adapter!.deliver(subject, message({ [CARRIED_TURN_LIMITS_FIELD]: placed }, subject));
    expect(turnOf(first)).toMatchObject({ key: CHAT, cwd: sol, forAgent: sol });
    expect(conversations.size).toBe(0);

    const restarted = freshCodex();
    await boot(restarted);
    const next = await adapter!.deliver(subject, message({}, subject));

    expect(next.success).toBe(true);
    expect(turnOf(restarted)).toEqual({
      key: CHAT,
      cwd: sol,
      forAgent: sol,
      ensuredCwd: sol,
      hasStarted: false,
    });
  });

  it('records the chat as its agent’s, under the id its next turn runs on', async () => {
    await boot(freshClaudeCode());
    const placed = sealTurnLimits(SOL_SUBJECT, {
      newChat: { sessionKey: CHAT, cwd: sol, forAgent: sol },
    });
    await adapter!.deliver(SUBJECT, message({ [CARRIED_TURN_LIMITS_FIELD]: placed }));

    expect(await runtimeRegistry.getSessionAgentPath(SDK_ID)).toBe(sol);
    expect(await runtimeRegistry.resolveSessionRuntime(SDK_ID)).toEqual({
      type: 'claude-code',
      bound: true,
    });
  });
});
