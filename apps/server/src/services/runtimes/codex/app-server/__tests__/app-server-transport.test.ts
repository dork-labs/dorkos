/**
 * The app-server transport end to end over the fake app-server (spec
 * `codex-app-server-transport` §6–§9): a real pool, loader, mapper, JSON-RPC
 * client and thread-key registry; only the binary is pretend.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { StreamEventSchema } from '@dorkos/shared/schemas';

vi.mock('../../credits-launch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../credits-launch.js')>()),
  ensureCreditsCodexHome: () => {},
}));

import {
  makeAppServerHarness,
  PERSON_HOME,
  CREDITS_ENV_HOME,
} from '../../__tests__/app-server-harness.js';
import {
  backgroundCommandTurn,
  hangingTurn,
  parkedTurn,
  steerableTurn,
  type FakeTurnScript,
} from '../../__tests__/fake-app-server.js';
import { APP_SERVER_ARGS } from '../process-pool.js';
import { CODEX_STOPPED_COPY } from '../notification-mapper.js';
import { BACKGROUND_WORK_LOST_COPY, type BackgroundWake } from '../background-work.js';
import { THREAD_STARTS_FRESH_NOTICE } from '../thread-loader.js';
import { sandboxPolicyFor } from '../turn-parts.js';
import type { CreditsRelay } from '../../../../core/cloud/credits-relay.js';

type Harness = ReturnType<typeof makeAppServerHarness>;
const harnesses: Harness[] = [];
function harness(options?: Parameters<typeof makeAppServerHarness>[0]): Harness {
  const h = makeAppServerHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
});

const dones = (events: StreamEvent[]) => events.filter((event) => event.type === 'done');
const texts = (events: StreamEvent[]) =>
  events
    .filter((e) => e.type === 'text_delta')
    .map((e) => (e.data as { text: string }).text)
    .join('');

/** Read events off a running turn until one matches. */
async function until(
  gen: AsyncGenerator<StreamEvent>,
  type: StreamEvent['type']
): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return seen;
    seen.push(next.value);
    if (next.value.type === type) return seen;
  }
}
async function rest(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of gen) seen.push(event);
  return seen;
}

describe('a turn', () => {
  it('starts a thread, streams, ends with exactly one done, and binds at turn/started', async () => {
    const h = harness();
    const events = await h.run(
      h.request({
        sessionId: 's1',
        messageId: 'm1',
        settings: { permissionMode: 'default', effort: 'max', model: 'gpt-x' },
      })
    );
    for (const event of events) StreamEventSchema.parse(event);
    expect(texts(events)).toBe('pong');
    expect(dones(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
    expect(events.find((e) => e.type === 'session_status')).toMatchObject({
      data: { terminalReason: 'completed', contextTokens: 1200, contextMaxTokens: 200000 },
    });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    const threadId =
      fake.requestsOf('thread/start').length === 1 ? [...fake.loaded.keys()][0]! : '';
    expect(h.bindings).toEqual([{ sessionId: 's1', threadId }]);
    expect(fake.requestsOf('turn/start')[0]).toEqual({
      threadId,
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      clientUserMessageId: 'm1',
      cwd: '/project',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      model: 'gpt-x',
      effort: 'xhigh',
      summary: 'auto',
    });
  });

  it('runs the next turn on the loaded thread without reloading it', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    const threadId = h.bindings[0]!.threadId;
    const events = await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
    expect(dones(events)).toHaveLength(1);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/resume')).toHaveLength(0);
    expect(fake.requestsOf('turn/start')).toHaveLength(2);
    expect(h.bindings).toHaveLength(1);
  });

  it('never sends a second turn/start into a thread with an open turn (the joining trap)', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(parkedTurn);
    const first = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(first, 'text_delta');
    const second = await h.run(h.request({ sessionId: 's1' }));
    expect(second.map((e) => e.type)).toEqual(['error', 'done']);
    expect(second[0]).toMatchObject({ data: { code: 'turn_open' } });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('turn/start')).toHaveLength(1);
    await h.transport.interrupt('s1');
    expect(dones(await rest(first))).toHaveLength(1);
  });

  it('maps a workspace-write turn to the tagged sandbox policy with its grants', () => {
    expect(
      sandboxPolicyFor({
        settings: { permissionMode: 'acceptEdits' },
        writableDirectories: ['/grant'],
      })
    ).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/grant'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(
      sandboxPolicyFor({
        settings: { permissionMode: 'bypassPermissions' },
        writableDirectories: [],
      })
    ).toEqual({
      type: 'dangerFullAccess',
    });
  });

  it('refuses the requests DorkOS takes no part in, at once, inside an open turn', async () => {
    const h = harness();
    const replies: unknown[] = [];
    const script: FakeTurnScript = async (ctx) => {
      replies.push(await ctx.serverRequest('item/tool/call', { callId: 'c', tool: 'x' }));
      replies.push(
        await ctx.serverRequest('mcpServer/elicitation/request', {
          serverName: 'x',
          mode: 'openai/userVerification',
        })
      );
      ctx.complete('completed');
    };
    h.host.home(PERSON_HOME).nextTurn(script);
    const events = await h.run(h.request({ sessionId: 's1' }));
    expect(dones(events)).toHaveLength(1);
    expect(replies).toEqual([
      { contentItems: [], success: false },
      { action: 'cancel', content: null, _meta: null },
    ]);
  });
});

describe('interrupt', () => {
  it('answers not-running with no open turn', async () => {
    const h = harness();
    await expect(h.transport.interrupt('nobody')).resolves.toEqual({
      outcome: 'not-running',
      reason: 'no-open-turn',
      runtime: 'codex',
    });
  });

  it('acks when Codex winds the turn down, and the turn ends with one quiet done', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(parkedTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    await expect(h.transport.interrupt('s1')).resolves.toEqual({
      outcome: 'acked',
      runtime: 'codex',
    });
    const after = await rest(gen);
    expect(after).toEqual([{ type: 'done', data: { sessionId: 's1' } }]);
    expect(h.transport.getSessionWarmth('s1')).toBe('warm');
  });

  it('reports unconfirmed when Codex never completes the turn, and still ends it', async () => {
    const h = harness({ stopAckMs: 100 });
    h.host.home(PERSON_HOME).nextTurn(hangingTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    await expect(h.transport.interrupt('s1')).resolves.toEqual({
      outcome: 'unconfirmed',
      reason: 'ack-timeout',
      runtime: 'codex',
    });
    expect(dones(await rest(gen))).toHaveLength(1);
  });

  it('interrupts through the turn’s abort signal too', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(parkedTurn);
    const controller = new AbortController();
    const gen = h.transport.runTurn(h.request({ sessionId: 's1', signal: controller.signal }));
    await until(gen, 'text_delta');
    controller.abort();
    expect(dones(await rest(gen))).toHaveLength(1);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('turn/interrupt')).toHaveLength(1);
  });
});

describe('crashes and cold resume', () => {
  it('ends an open turn with an honest error and one done, then resumes cold with fresh config', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    const threadId = h.bindings[0]!.threadId;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      ctx.emit('item/agentMessage/delta', { itemId: 'x', delta: 'half' });
      await ctx.tick();
      ctx.server.exit(137);
    });
    const crashed = await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
    expect(crashed.filter((e) => e.type === 'error')).toEqual([
      {
        type: 'error',
        data: { message: CODEX_STOPPED_COPY, code: 'codex_stopped', details: 'exit code 137' },
      },
    ]);
    expect(dones(crashed)).toHaveLength(1);

    const resumed = await h.run(
      h.request({
        sessionId: 's1',
        boundThreadId: threadId,
        settings: { permissionMode: 'acceptEdits' },
      })
    );
    expect(texts(resumed)).toBe('pong');
    const second = h.host.home(PERSON_HOME).processes[1]!;
    expect(second.requestsOf('thread/resume')[0]).toMatchObject({
      threadId,
      sandbox: 'workspace-write',
    });
  });

  it('starts fresh with a notice and replaces the binding when Codex lost the thread', async () => {
    const h = harness();
    const events = await h.run(h.request({ sessionId: 's1', boundThreadId: 'gone' }));
    expect(events[0]).toEqual({
      type: 'system_status',
      data: { message: THREAD_STARTS_FRESH_NOTICE },
    });
    expect(h.bindings[0]).toMatchObject({ sessionId: 's1', replaces: 'gone' });
  });
});

describe('the thread key', () => {
  it('resolves to the turn’s binding only while the turn is open', async () => {
    const h = harness({ withConnectorTools: true });
    let duringTurn: string | undefined = 'unset';
    let key = '';
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const loaded = ctx.server.loaded.get(ctx.turn.threadId)!;
      const servers = (
        loaded.loadParams.config as {
          mcp_servers: Record<string, { http_headers: { Authorization: string } }>;
        }
      ).mcp_servers;
      key = servers.dorkos!.http_headers.Authorization.slice('Bearer '.length);
      duringTurn = h.threadKeys.lookup(key)?.bindingId;
      ctx.agentMessage('ok');
      ctx.complete('completed');
    });
    await h.run(
      h.request({
        sessionId: 's1',
        tools: {
          agentTokenEnv: { DORKOS_AGENT_TOKEN: 'identity-secret' },
          managed: { servers: {}, env: {} },
          dorkosTools: {
            url: 'http://127.0.0.1:9999/agent',
            headers: { Authorization: 'Bearer turn-bearer' },
          },
          connectorTools: {
            url: 'http://127.0.0.1:9999/mcp',
            agentToolsUrl: 'http://127.0.0.1:9999/agent',
            headers: {},
          },
          connectorBindingId: 'binding-1',
        },
      })
    );
    expect(duringTurn).toBe('binding-1');
    expect(h.threadKeys.lookup(key)).toMatchObject({ bindingId: undefined });
    // Nothing secret rode the process's argv or environment.
    const spawn = h.host.spawns[0]!;
    expect(spawn.args).toEqual([...APP_SERVER_ARGS]);
    const visible = JSON.stringify(spawn);
    expect(visible).not.toContain(key);
    expect(visible).not.toContain('identity-secret');
    expect(visible).not.toContain('turn-bearer');
    // And the key dies with the process.
    await h.pool.shutdown();
    expect(h.threadKeys.lookup(key)).toBeUndefined();
  });
});

describe('warmth and reaping', () => {
  it('is warm between turns, running during one, and cold after a reap', async () => {
    const h = harness();
    expect(h.transport.getSessionWarmth('s1')).toBe('cold');
    h.host.home(PERSON_HOME).nextTurn(parkedTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    expect(h.transport.getSessionWarmth('s1')).toBe('running');
    await h.transport.interrupt('s1');
    await rest(gen);
    expect(h.transport.getSessionWarmth('s1')).toBe('warm');
    await h.transport.reapSession('s1');
    expect(h.transport.getSessionWarmth('s1')).toBe('cold');
    expect(h.host.home(PERSON_HOME).processes[0]!.hasExited).toBe(true);
    const next = await h.run(
      h.request({ sessionId: 's1', boundThreadId: h.bindings[0]!.threadId })
    );
    expect(texts(next)).toBe('pong');
  });
});

describe('late events', () => {
  it('routes a notification for an ended turn to the late sink, never into the next turn', async () => {
    const h = harness();
    let late!: () => void;
    h.host.home(PERSON_HOME).nextTurn((ctx) => {
      ctx.agentMessage('first');
      ctx.complete('completed');
      late = () => ctx.emit('item/agentMessage/delta', { itemId: 'old', delta: 'LATE' });
    });
    await h.run(h.request({ sessionId: 's1' }));
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      late();
      await ctx.tick();
      ctx.agentMessage('second');
      ctx.complete('completed');
    });
    const second = await h.run(
      h.request({ sessionId: 's1', boundThreadId: h.bindings[0]!.threadId })
    );
    expect(texts(second)).toBe('second');
  });
});

describe('credits', () => {
  function fakeRelay(): CreditsRelay & { revoked: string[] } {
    const revoked: string[] = [];
    return {
      revoked,
      issue: vi.fn(() => ({ baseUrl: 'http://127.0.0.1:7/v1', key: 'relay-key-1' })),
      revoke: (key: string) => void revoked.push(key),
      abortAll: () => {},
      close: async () => {},
    };
  }
  const credits = {
    home: 'credits' as const,
    credits: { baseUrl: 'https://x', token: 'never-sent', protocol: 'openai-responses' },
  };

  it('runs in the credits home through the relay, with no token in the process', async () => {
    const relay = fakeRelay();
    const h = harness({ relay });
    const events = await h.run(h.request({ sessionId: 's1', launch: credits as never }));
    expect(dones(events)).toHaveLength(1);
    const fake = h.host.home(CREDITS_ENV_HOME).processes[0]!;
    const config = fake.requestsOf('thread/start')[0]!.config as Record<string, unknown>;
    expect(config).toMatchObject({
      model_provider: 'dorkos-credits',
      model_providers: { 'dorkos-credits': { experimental_bearer_token: 'relay-key-1' } },
      web_search: 'disabled',
    });
    expect(JSON.stringify(h.host.spawns)).not.toContain('never-sent');
    expect(JSON.stringify(fake.received)).not.toContain('never-sent');
    await h.transport.closeCreditsProcess();
    // The pool closed nothing it should not have; the relay key revokes with the process.
    await h.pool.shutdown();
    expect(relay.revoked).toEqual(['relay-key-1']);
  });

  it('terminates a credits thread’s background command before closing its process (unlink)', async () => {
    const h = harness({ relay: fakeRelay() });
    const seen: BackgroundWake[] = [];
    h.transport.onWake((wake) => {
      seen.push(wake);
      return true;
    });
    const bg = backgroundCommandTurn('pnpm dev');
    h.host.home(CREDITS_ENV_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1', launch: credits as never }));
    const fake = h.host.home(CREDITS_ENV_HOME).processes[0]!;
    await h.transport.closeCreditsProcess();
    expect(fake.requestsOf('thread/backgroundTerminals/terminate')).toEqual([
      { threadId: expect.any(String), processId: bg.processId },
    ]);
    expect(fake.hasExited).toBe(true);
    for (let i = 0; i < 100 && seen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Stopped, as Codex confirmed, never "lost track"; and no model turn.
    expect(seen[0]).toMatchObject({ startTurn: false, notices: [] });
    expect(seen[0]!.completions[0]).toMatchObject({ status: 'stopped', wakes: false });
  });

  it('refuses a credits turn with the credits card when no relay is running', async () => {
    const h = harness();
    const events = await h.run(h.request({ sessionId: 's1', launch: credits as never }));
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]).toMatchObject({ data: { code: 'credits_unavailable' } });
    expect(h.host.spawns).toHaveLength(0);
  });
});

describe('reaping respects background terminals', () => {
  it('keeps a process whose thread still runs a background terminal', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    const threadId = h.bindings[0]!.threadId;
    fake.backgroundTerminals.set(threadId, [{ itemId: 'bg', processId: 'p1' }]);
    h.pool.list()[0]!.stale = true;
    await h.pool.reapOnce();
    expect(fake.hasExited).toBe(false);
    expect(fake.requestsOf('thread/backgroundTerminals/list')).toEqual([{ threadId }]);
    fake.backgroundTerminals.delete(threadId);
    await h.pool.reapOnce();
    expect(fake.hasExited).toBe(true);
  });
});

describe('review fixes: every early exit ends with one done, and no turn is joined', () => {
  it('ends with the crash and one done when Codex exits while turn/start is in flight', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    h.host.home(PERSON_HOME).processes[0]!.exitOnTurnStart = true;
    const events = await h.run(
      h.request({ sessionId: 's1', boundThreadId: h.bindings[0]!.threadId })
    );
    expect(events.map((e) => e.type)).toEqual(['session_status', 'error', 'done']);
    expect(events[1]).toMatchObject({ data: { message: CODEX_STOPPED_COPY } });
  });

  it('ends with one done when a stop gives up before turn/start answered, then stops that turn', async () => {
    const h = harness({ stopAckMs: 100 });
    await h.run(h.request({ sessionId: 's1' }));
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    let open!: () => void;
    fake.turnStartGate = new Promise((resolve) => (open = resolve));
    h.host.home(PERSON_HOME).nextTurn(parkedTurn);
    const gen = h.transport.runTurn(
      h.request({ sessionId: 's1', boundThreadId: h.bindings[0]!.threadId })
    );
    const reading = rest(gen);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(h.transport.interrupt('s1')).resolves.toMatchObject({ outcome: 'unconfirmed' });
    open();
    expect(dones(await reading)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.requestsOf('turn/interrupt')).toHaveLength(1);
  });

  it('never joins a turn Codex is still running after an unconfirmed stop', async () => {
    const h = harness({ stopAckMs: 100 });
    h.host.home(PERSON_HOME).nextTurn(hangingTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    await expect(h.transport.interrupt('s1')).resolves.toMatchObject({ outcome: 'unconfirmed' });
    await rest(gen);
    const next = await h.run(
      h.request({ sessionId: 's1', boundThreadId: h.bindings[0]!.threadId })
    );
    expect(next.map((e) => e.type)).toEqual(['error', 'done']);
    expect(next[0]).toMatchObject({ data: { code: 'turn_stopping' } });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('turn/start')).toHaveLength(1);
    expect(fake.requestsOf('turn/interrupt')).toHaveLength(2);
  });

  it('starts the next turn once the abandoned one finally ends', async () => {
    const h = harness({ stopAckMs: 100 });
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      ctx.emit('item/agentMessage/delta', { itemId: 'slow', delta: 'working' });
      while (ctx.server.requestsOf('turn/interrupt').length < 2) await ctx.tick();
      ctx.complete('interrupted');
    });
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    await h.transport.interrupt('s1');
    await rest(gen);
    const next = await h.run(
      h.request({ sessionId: 's1', boundThreadId: h.bindings[0]!.threadId })
    );
    expect(texts(next)).toBe('pong');
    expect(h.host.home(PERSON_HOME).processes[0]!.requestsOf('turn/start')).toHaveLength(2);
  });
});

describe('re-review fixes', () => {
  const withManaged = (value: string) => ({
    agentTokenEnv: {},
    managed: {
      servers: {
        notion: {
          url: 'https://n.example/mcp',
          env_http_headers: { Authorization: 'DORKOS_MCP_HDR_N' },
        },
      },
      env: { DORKOS_MCP_HDR_N: value },
    },
    dorkosTools: null,
    connectorTools: null,
  });

  it('reloads just the thread whose OAuth header was refreshed, never the whole home (N1)', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1', tools: withManaged('Bearer old') }));
    await h.run(h.request({ sessionId: 's2' }));
    const first = h.bindings[0]!.threadId;
    const events = await h.run(
      h.request({ sessionId: 's1', boundThreadId: first, tools: withManaged('Bearer fresh') })
    );
    expect(texts(events)).toBe('pong');
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(h.pool.list()[0]!.stale).toBe(false);
    expect(fake.hasExited).toBe(false);
    const fork = fake.requestsOf('thread/fork')[0]!;
    expect(fork.threadId).toBe(first);
    expect(JSON.stringify(fork.config)).toContain('Bearer fresh');
    expect(fake.unsubscribed.has(first)).toBe(true);
    // The session is re-bound to the fork, replacing the old thread.
    expect(h.bindings.at(-1)).toMatchObject({ sessionId: 's1', replaces: first });
    // The other session's thread was not touched.
    expect(fake.requestsOf('thread/fork')).toHaveLength(1);
  });

  it('counts a thread Codex no longer has as not live, and drops it (N2)', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    fake.loaded.clear();
    h.pool.list()[0]!.stale = true;
    await h.pool.reapOnce();
    expect(fake.hasExited).toBe(true);
    expect(h.transport.getSessionWarmth('s1')).toBe('cold');
  });

  it('gives up on a turn Codex will not stop after a few refusals and reloads that thread (N3)', async () => {
    const h = harness({ stopAckMs: 60 });
    h.host.home(PERSON_HOME).nextTurn(hangingTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    await h.transport.interrupt('s1');
    await rest(gen);
    const bound = h.bindings[0]!.threadId;
    for (let refusal = 0; refusal < 2; refusal += 1) {
      const refused = await h.run(h.request({ sessionId: 's1', boundThreadId: bound }));
      expect(refused[0]).toMatchObject({ data: { code: 'turn_stopping' } });
    }
    const next = await h.run(h.request({ sessionId: 's1', boundThreadId: bound }));
    expect(texts(next)).toBe('pong');
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/fork')[0]).toMatchObject({ threadId: bound });
    expect(h.bindings.at(-1)).toMatchObject({ replaces: bound });
  });

  it('starts a fresh thread when the thread to reload never ran a turn (no rollout to fork)', async () => {
    const h = harness();
    // A thread loads, then the turn is stopped before `turn/start`: loaded, unbound, no rollout.
    const stopped = new AbortController();
    stopped.abort();
    await h.run(
      h.request({ sessionId: 's1', tools: withManaged('Bearer old'), signal: stopped.signal })
    );
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    const first = fake.requestsOf('thread/start').length;
    const events = await h.run(h.request({ sessionId: 's1', tools: withManaged('Bearer fresh') }));
    expect(texts(events)).toBe('pong');
    expect(fake.requestsOf('thread/start')).toHaveLength(first + 1);
    expect(JSON.stringify(fake.requestsOf('thread/start').at(-1)!.config)).toContain(
      'Bearer fresh'
    );
    // One stuck first turn must not recycle every chat in the home.
    expect(h.pool.list()[0]!.stale).toBe(false);
    expect(h.bindings.at(-1)).toEqual({ sessionId: 's1', threadId: expect.any(String) });
  });

  it('tries to stop a lingering turn before reloading its thread for fresh credentials', async () => {
    const h = harness({ stopAckMs: 60 });
    h.host.home(PERSON_HOME).nextTurn(hangingTurn);
    const gen = h.transport.runTurn(
      h.request({ sessionId: 's1', tools: withManaged('Bearer old') })
    );
    await until(gen, 'text_delta');
    await h.transport.interrupt('s1');
    await rest(gen);
    const bound = h.bindings[0]!.threadId;
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    const before = fake.received.length;
    const next = await h.run(
      h.request({ sessionId: 's1', boundThreadId: bound, tools: withManaged('Bearer fresh') })
    );
    expect(texts(next)).toBe('pong');
    const methods = fake.received.slice(before).map((message) => message.method);
    expect(methods.indexOf('turn/interrupt')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('turn/interrupt')).toBeLessThan(methods.indexOf('thread/fork'));
  });

  it('resumes the old thread cold after a restart in the window before a fork binds', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1', tools: withManaged('Bearer old') }));
    const bound = h.bindings[0]!.threadId;
    // The fork's first turn never starts: the database still names the old thread.
    h.host.home(PERSON_HOME).processes[0]!.exitOnTurnStart = true;
    await h.run(
      h.request({ sessionId: 's1', boundThreadId: bound, tools: withManaged('Bearer fresh') })
    );
    expect(h.bindings).toHaveLength(1);
    // A restart: a new transport and pool on the same home.
    const restarted = harness();
    (restarted.host as unknown as { homes: unknown }).homes = (
      h.host as unknown as { homes: unknown }
    ).homes;
    const events = await restarted.run(
      restarted.request({
        sessionId: 's1',
        boundThreadId: bound,
        tools: withManaged('Bearer fresh'),
      })
    );
    expect(texts(events)).toBe('pong');
    const resumed = restarted.host.home(PERSON_HOME).processes.at(-1)!.requestsOf('thread/resume');
    expect(resumed[0]).toMatchObject({ threadId: bound });
    expect(JSON.stringify(resumed[0]!.config)).toContain('Bearer fresh');
  });

  it('forgets a lingering turn when Codex unloads its thread, and stops watching its process (N3, N4)', async () => {
    const h = harness({ stopAckMs: 60 });
    h.host.home(PERSON_HOME).nextTurn(hangingTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    const proc = h.pool.list()[0]!;
    const realOnExit = proc.onExit.bind(proc);
    let watching = 0;
    proc.onExit = (listener) => {
      watching += 1;
      const stop = realOnExit(listener);
      return () => {
        watching -= 1;
        stop();
      };
    };
    await h.transport.interrupt('s1');
    await rest(gen);
    expect(watching).toBe(1);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    fake.send({ method: 'thread/closed', params: { threadId: h.bindings[0]!.threadId } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(watching).toBe(0);
    expect(h.transport.getSessionWarmth('s1')).toBe('cold');
  });
});

describe('steer (spec §11)', () => {
  it('delivers into the open turn with its id, and no new turn starts', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(steerableTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    const seen = await until(gen, 'text_delta');
    await expect(
      h.transport.deliverIntoTurn('s1', 'use tabs', {
        mode: 'steer',
        messageId: 'steer-1',
        additionalContext: [{ kind: 'staged', text: 'a note' } as never],
      })
    ).resolves.toEqual({ delivered: true });
    const after = await rest(gen);
    expect(texts([...seen, ...after])).toContain('steered:');
    expect(dones(after)).toHaveLength(1);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    const steer = fake.requestsOf('turn/steer')[0]!;
    // The fake, like the binary, refuses a steer whose expectedTurnId is not
    // the running turn's, so `delivered: true` above already proves the match.
    expect(steer).toMatchObject({
      clientUserMessageId: 'steer-1',
      expectedTurnId: expect.any(String),
    });
    const text = (steer.input as Array<{ text: string }>)[0]!.text;
    // The person's words come last, untouched.
    expect(text.endsWith('use tabs')).toBe(true);
    expect(fake.requestsOf('turn/start')).toHaveLength(1);
  });

  it('refuses honestly: no open turn, a stage, or a turn Codex says is gone', async () => {
    const h = harness();
    await expect(
      h.transport.deliverIntoTurn('s1', 'x', { mode: 'steer', messageId: 'm' })
    ).resolves.toEqual({ delivered: false, reason: 'no-open-turn' });
    h.host.home(PERSON_HOME).nextTurn(parkedTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'text_delta');
    await expect(
      h.transport.deliverIntoTurn('s1', 'x', { mode: 'stage', messageId: 'm' })
    ).resolves.toEqual({ delivered: false, reason: 'unsupported' });
    // The turn ends inside Codex between DorkOS's check and the steer.
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    for (const loaded of fake.loaded.values()) loaded.activeTurn!.done = true;
    await expect(
      h.transport.deliverIntoTurn('s1', 'x', { mode: 'steer', messageId: 'm' })
    ).resolves.toEqual({ delivered: false, reason: 'no-open-turn' });
    for (const loaded of fake.loaded.values()) loaded.activeTurn!.done = false;
    await h.transport.interrupt('s1');
    await rest(gen);
  });
});

describe('background work (spec §12)', () => {
  /** Collect wakes, answering as a runtime with a listener would. */
  function wakes(h: Harness): BackgroundWake[] {
    const seen: BackgroundWake[] = [];
    h.transport.onWake((wake) => {
      seen.push(wake);
      return true;
    });
    return seen;
  }
  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  }

  it('RT-LIFE-03: wakes the chat once when a command finishes after a completed turn', async () => {
    const h = harness();
    const seen = wakes(h);
    const bg = backgroundCommandTurn();
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    const events = await h.run(h.request({ sessionId: 's1' }));
    expect(dones(events)).toHaveLength(1);
    expect(events.find((e) => e.type === 'background_task_started')).toMatchObject({
      data: { taskId: bg.itemId, taskType: 'bash', command: 'sleep 3; echo done' },
    });
    expect(h.transport.holdsBackgroundWork('s1')).toBe(true);
    expect(h.transport.isSegmentPending('s1')).toBe(false);

    bg.finish(0, 'done\n');
    await waitFor(() => h.transport.isSegmentPending('s1'));
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ sessionId: 's1', startTurn: true, notices: [] });
    expect(seen[0]!.completions).toEqual([
      expect.objectContaining({ taskId: bg.itemId, status: 'completed', wakes: true }),
    ]);
    expect(h.transport.isSegmentPending('s1')).toBe(false);
    expect(h.transport.holdsBackgroundWork('s1')).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(1);
  });

  it('shows a completion in the turn that is open instead of waking', async () => {
    const h = harness();
    const seen = wakes(h);
    const bg = backgroundCommandTurn();
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1' }));
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      bg.finish(0, 'ok\n');
      await ctx.tick();
      await ctx.tick();
      ctx.agentMessage('second');
      ctx.complete('completed');
    });
    const second = await h.run(
      h.request({ sessionId: 's1', boundThreadId: h.bindings[0]!.threadId })
    );
    expect(second.find((e) => e.type === 'background_task_done')).toMatchObject({
      data: { taskId: bg.itemId, status: 'completed' },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(0);
  });

  it('stops a background command on request, and its end wakes no model turn', async () => {
    const h = harness();
    const seen = wakes(h);
    const bg = backgroundCommandTurn('pnpm dev');
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1' }));
    expect(await h.transport.stopTask('s1', 'no-such-task')).toEqual({
      outcome: 'not-running',
      reason: 'no-open-turn',
      runtime: 'codex',
    });
    expect(await h.transport.stopTask('s1', bg.itemId)).toEqual({
      outcome: 'acked',
      runtime: 'codex',
    });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/backgroundTerminals/terminate')).toEqual([
      { threadId: h.bindings[0]!.threadId, processId: bg.processId },
    ]);
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ startTurn: false });
    expect(seen[0]!.completions[0]).toMatchObject({ status: 'stopped', wakes: false });
    // Already gone: a second stop is honest about it.
    expect((await h.transport.stopTask('s1', bg.itemId)).outcome).toBe('not-running');
  });

  it('ends a paused agent’s session: its command stopped, its thread given back, no wake', async () => {
    const h = harness();
    const seen = wakes(h);
    const bg = backgroundCommandTurn('pnpm dev');
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1' }));
    expect(h.transport.liveSessionIds()).toEqual(['s1']);

    expect(await h.transport.endSession('s1')).toBe(true);

    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/backgroundTerminals/terminate')).toEqual([
      { threadId: h.bindings[0]!.threadId, processId: bg.processId },
    ]);
    expect(h.transport.getSessionWarmth('s1')).toBe('cold');
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ startTurn: false });
    expect(h.transport.holdsBackgroundWork('s1')).toBe(false);
    expect(h.transport.liveSessionIds()).toEqual([]);
    // Nothing left: ending it again is honest about it.
    expect(await h.transport.endSession('s1')).toBe(false);
  });

  it('keeps the result of a command that ended just before its stop, and wakes no model turn', async () => {
    const h = harness();
    const seen = wakes(h);
    const bg = backgroundCommandTurn();
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1' }));
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    // It has left the terminal list but its item/completed is still in flight.
    fake.backgroundTerminals.set(h.bindings[0]!.threadId, []);
    expect((await h.transport.stopTask('s1', bg.itemId)).outcome).toBe('not-running');
    bg.finish(0, 'it finished\n');
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ startTurn: false });
    expect(seen[0]!.completions[0]).toMatchObject({ status: 'completed', wakes: false });
    expect(seen[0]!.completions[0]!.summary).toContain('it finished');
  });

  it('keeps a process alive while a helper agent it started is still working', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn((ctx) => {
      ctx.emit('item/completed', {
        item: {
          type: 'subAgentActivity',
          id: 'act-1',
          kind: 'started',
          agentThreadId: 'helper-thread',
          agentPath: '/root/helper',
        },
      });
      ctx.agentMessage('asked a helper');
      ctx.complete('completed');
    });
    await h.run(h.request({ sessionId: 's1' }));
    expect(h.transport.holdsBackgroundWork('s1')).toBe(true);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    h.pool.list()[0]!.stale = true;
    await h.pool.reapOnce();
    expect(fake.hasExited).toBe(false);
  });

  it('says it lost track of the work when Codex stops, and wakes no model turn', async () => {
    const h = harness();
    const seen = wakes(h);
    const bg = backgroundCommandTurn();
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1' }));
    h.host.home(PERSON_HOME).processes[0]!.exit(137);
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({
      sessionId: 's1',
      completions: [],
      startTurn: false,
      notices: [BACKGROUND_WORK_LOST_COPY],
    });
    expect(h.transport.holdsBackgroundWork('s1')).toBe(false);
  });

  it('stops the background work at the ceiling, once, without waking the model', async () => {
    const h = harness({ backgroundWork: { ceilingMs: 30 } });
    const seen = wakes(h);
    const bg = backgroundCommandTurn('pnpm dev');
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1' }));
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ startTurn: false });
    expect(seen[0]!.completions[0]).toMatchObject({ status: 'stopped' });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.requestsOf('thread/backgroundTerminals/terminate')).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
});
