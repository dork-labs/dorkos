/**
 * DOR-4384: a Codex thread that was handed the `dorkos` MCP server but never
 * fetched its tool list says so once, at the default log level, naming the
 * chat and how the thread was loaded. DOR-3169's broken binding produced
 * exactly that thread, and nothing was logged. A real pool, loader and
 * thread-key registry over the fake app-server; made-up values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CodexTurnTools } from '../../transport/codex-transport.js';
import { resetThreadKeyTurnWarnings } from '../../transport/thread-key-turn.js';
import { makeAppServerHarness, PERSON_HOME } from '../../__tests__/app-server-harness.js';
import type { FakeTurnScript } from '../../__tests__/fake-app-server.js';
import { logger } from '../../../../../lib/logger.js';

type Harness = ReturnType<typeof makeAppServerHarness>;
const harnesses: Harness[] = [];
let warn: MockInstance<typeof logger.warn>;

beforeEach(() => {
  resetThreadKeyTurnWarnings();
  warn = vi.spyOn(logger, 'warn');
});
afterEach(async () => {
  warn.mockRestore();
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
});

/** The harness with the connector listener's tools and thread keys wired. */
function harness(): Harness {
  const h = makeAppServerHarness({ withConnectorTools: true });
  harnesses.push(h);
  return h;
}

/** A turn's tools: the DorkOS tools server, and optionally the connector one. */
function toolsWith(dorkos: boolean): CodexTurnTools {
  return {
    agentTokenEnv: {},
    managed: { servers: {}, env: {} },
    dorkosTools: dorkos
      ? { url: 'http://127.0.0.1:9999/agent', headers: { Authorization: 'Bearer turn-bearer' } }
      : null,
    connectorTools: {
      url: 'http://127.0.0.1:9999/mcp',
      agentToolsUrl: 'http://127.0.0.1:9999/agent',
      headers: {},
    },
    connectorBindingId: 'binding-1',
  };
}

/**
 * A turn that ends with `status`, and first fetches the DorkOS tool list the way
 * the listener records it, when `lists` is set.
 */
function turn(
  h: Harness,
  options: { lists: boolean; status?: 'completed' | 'failed' }
): FakeTurnScript {
  return (ctx) => {
    if (options.lists) {
      const config = ctx.server.loaded.get(ctx.turn.threadId)!.loadParams.config as {
        mcp_servers: Record<string, { http_headers: { Authorization: string } }>;
      };
      h.threadKeys.noteToolsListed(
        config.mcp_servers.dorkos!.http_headers.Authorization.slice('Bearer '.length)
      );
    }
    ctx.agentMessage('ok');
    ctx.complete(options.status ?? 'completed');
  };
}

/** The DOR-4384 warnings logged so far. */
function unlistedWarnings(): unknown[][] {
  // The check runs once the turn's completion settles, a tick after the turn ends.
  return warn.mock.calls.filter(([message]) => String(message).includes('listed none'));
}

/** Let the completion callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('a Codex thread that never lists its DorkOS tools (DOR-4384)', () => {
  it('warns once, naming the chat and that the thread was freshly started', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(h.request({ sessionId: 'chat-a', tools: toolsWith(true) }));
    await settle();
    expect(unlistedWarnings()).toHaveLength(1);
    expect(unlistedWarnings()[0]![1]).toMatchObject({ sessionId: 'chat-a', loadKind: 'start' });
  });

  it('stays quiet when the thread fetched its tool list', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: true }));
    await h.run(h.request({ sessionId: 'chat-b', tools: toolsWith(true) }));
    await settle();
    expect(unlistedWarnings()).toEqual([]);
  });

  it('warns once per load: a retry is a new load, and warns for itself', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(h.request({ sessionId: 'chat-c', tools: toolsWith(true) }));
    // The next turn reloads the thread to try again (DOR-4393): a fork, with a new key.
    const boundThreadId = h.bindings[0]!.threadId;
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(h.request({ sessionId: 'chat-c', boundThreadId, tools: toolsWith(true) }));
    await settle();
    const forks = h.host.home(PERSON_HOME).processes.flatMap((p) => p.requestsOf('thread/fork'));
    expect(forks, 'the second turn ran on a fresh load').toHaveLength(1);
    const keyIds = unlistedWarnings().map(([, data]) => (data as { keyId: string }).keyId);
    expect(keyIds).toHaveLength(2);
    expect(new Set(keyIds).size, 'one warning per key').toBe(2);
  });

  it('stays quiet for a turn that did not complete', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false, status: 'failed' }));
    await h.run(h.request({ sessionId: 'chat-d', tools: toolsWith(true) }));
    await settle();
    expect(unlistedWarnings()).toEqual([]);
  });

  it('stays quiet for a thread that was never handed the DorkOS tools server', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(h.request({ sessionId: 'chat-e', tools: toolsWith(false) }));
    await settle();
    expect(unlistedWarnings()).toEqual([]);
  });
});

describe('a Codex chat that loses its DorkOS tools (DOR-4393)', () => {
  /** The forks Codex was asked for: each is a reload with a fresh key. */
  const forksOf = (h: Harness) =>
    h.host.home(PERSON_HOME).processes.flatMap((p) => p.requestsOf('thread/fork'));

  it('tells the runtime, and the next message reloads the thread to try again', async () => {
    const h = harness();
    const listings: boolean[] = [];
    const onDorkosToolsListing = (listed: boolean) => void listings.push(listed);
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(h.request({ sessionId: 'chat-f', tools: toolsWith(true), onDorkosToolsListing }));
    await settle();
    expect(listings).toEqual([false]);
    expect(forksOf(h), 'nothing reloads before the next message').toHaveLength(0);

    const boundThreadId = h.bindings[0]!.threadId;
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: true }));
    await h.run(
      h.request({
        sessionId: 'chat-f',
        boundThreadId,
        tools: toolsWith(true),
        onDorkosToolsListing,
      })
    );
    await settle();
    expect(forksOf(h), 'the next message reloaded the thread').toHaveLength(1);
    expect(listings).toEqual([false, true]);
  });

  it('reports a kept listing and never reloads the thread', async () => {
    const h = harness();
    const listings: boolean[] = [];
    const onDorkosToolsListing = (listed: boolean) => void listings.push(listed);
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: true }));
    await h.run(h.request({ sessionId: 'chat-g', tools: toolsWith(true), onDorkosToolsListing }));
    const boundThreadId = h.bindings[0]!.threadId;
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: true }));
    await h.run(
      h.request({
        sessionId: 'chat-g',
        boundThreadId,
        tools: toolsWith(true),
        onDorkosToolsListing,
      })
    );
    await settle();
    expect(listings).toEqual([true, true]);
    expect(forksOf(h)).toHaveLength(0);
  });

  it('reports nothing for a chat never handed the DorkOS tools', async () => {
    const h = harness();
    const listings: boolean[] = [];
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(
      h.request({
        sessionId: 'chat-h',
        tools: toolsWith(false),
        onDorkosToolsListing: (listed) => void listings.push(listed),
      })
    );
    await settle();
    expect(listings).toEqual([]);
  });
});
