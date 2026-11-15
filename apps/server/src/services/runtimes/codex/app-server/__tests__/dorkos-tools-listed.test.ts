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

  it('warns once per load, however many turns it runs', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(h.request({ sessionId: 'chat-c', tools: toolsWith(true) }));
    // The second turn runs on the thread the first one bound: the same load.
    const boundThreadId = h.bindings[0]!.threadId;
    h.host.home(PERSON_HOME).nextTurn(turn(h, { lists: false }));
    await h.run(h.request({ sessionId: 'chat-c', boundThreadId, tools: toolsWith(true) }));
    await settle();
    const starts = h.host.home(PERSON_HOME).processes.flatMap((p) => p.requestsOf('thread/start'));
    expect(starts, 'both turns ran on one load').toHaveLength(1);
    expect(unlistedWarnings()).toHaveLength(1);
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
