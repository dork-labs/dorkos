/**
 * `control_ui` records its caller as a session document's opener on Claude
 * Code's own in-process MCP server, so `configure_doc_channel` then works
 * (QA on #3104, 2026-10-27).
 *
 * Real Main services and the real SDK MCP projection, reached through an MCP
 * client: no test-mode runtime, no test-only route and no principal handed to
 * `canvas.open` directly. The opener comes from the turn's own verified
 * principal, which `control_ui` now resolves when it can and runs without when
 * it cannot.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../../core/capabilities/index.js';
import { peekCanvasService, setCanvasService } from '../../../../canvas/index.js';
import { uiDomain } from '../../../../session/browser-seat/ui-capabilities.js';
import { uiActionRefusalMessage } from '../../../../session/browser-seat/ui-surface-consent.js';
import {
  runtimeDocMcpFixture,
  docMcpPayload,
} from '../../../../canvas/doc-channel/__tests__/runtime-doc-mcp-fixture.js';
import { ClaudeConnectorTurnContext } from '../../connector-turn-context.js';
import { createDorkOsToolServer } from '../index.js';
import type { McpToolDeps } from '../types.js';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined, DORKOS_OLLAMA_URL: 'http://127.0.0.1:11434' },
}));
vi.mock('../../../../../lib/version.js', () => ({
  SERVER_VERSION: '0.0.0-test',
  IS_DEV_BUILD: false,
}));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

type TurnSource = 'real' | 'unresolvable';

/** Claude's MCP server over the real fixture, with a real or a failing turn. */
async function connect(source: TurnSource) {
  const f = await runtimeDocMcpFixture('claude-code', 'chat');
  cleanups.push(() => f.close());
  const prior = peekCanvasService();
  setCanvasService(f.canvas);
  if (prior) cleanups.push(async () => setCanvasService(prior));
  const registry = composeRegistry([uiDomain], {
    logger: noopLogger,
    docChannelGrantDeps: { service: f.http.grants, authorization: f.http.authorization },
    docChannelDownstream: f.http.downstream,
  });
  const real = new ClaudeConnectorTurnContext({
    tools: {
      principals: f.principals,
      listenerUrl: 'http://127.0.0.1:1/mcp',
      agentToolsUrl: 'http://127.0.0.1:1/agent-mcp',
      isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
    },
    canonicalSessionId: () => 'session-1',
    agentPath: f.dir,
    cwd: f.dir,
  });
  cleanups.push(() => real.revoke('turn_terminal'));
  const resolvePrincipal = vi.fn(
    source === 'real'
      ? () => real.resolvePrincipal()
      : async () => {
          throw new Error('Runtime tools are unavailable for this Claude turn.');
        }
  );
  const connectorTurn = {
    isConnectorCapabilityId: (id: string) => id.startsWith('connectors.'),
    resolvePrincipal,
  } as unknown as ClaudeConnectorTurnContext;
  const session = { eventQueue: [], cwd: f.dir, sdkSessionId: 'session-1', connectorTurn };
  const deps: McpToolDeps = {
    defaultCwd: f.dir,
    dorkHome: f.dir,
    transcriptReader: {
      listSessions: async () => [],
    } as unknown as McpToolDeps['transcriptReader'],
  };
  const server = createDorkOsToolServer(
    deps,
    session,
    'request-id',
    undefined,
    registry,
    new Set(),
    undefined,
    false
  );
  const client = new Client({ name: 'control-ui-opener-test', version: '1.0.0' });
  cleanups.push(() => client.close());
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.instance.connect(right)]);
  return { ...f, client, resolvePrincipal };
}

/** The configure call the fixture makes, aimed at another document. */
function configureCall(f: Awaited<ReturnType<typeof connect>>, documentId: string) {
  const call = f.calls[0]!;
  return { ...call, arguments: { ...call.arguments, documentId } };
}

const OPENS = [
  ['browser_navigate', { action: 'browser_navigate', url: 'http://localhost:5173/' }],
  [
    'open_canvas',
    { action: 'open_canvas', content: { type: 'browser', url: 'http://localhost:5173/' } },
  ],
] as const;

describe.each(OPENS)('Claude `control_ui` %s', (_action, args) => {
  it('binds the verified caller as opener, and configure_doc_channel then passes', async () => {
    const f = await connect('real');
    const opened = await f.client.callTool({ name: 'control_ui', arguments: { ...args } });
    expect(opened).not.toHaveProperty('isError', true);
    const documentId = String(docMcpPayload(opened).documentId);
    expect(f.http.channels.getChannel(documentId)?.openerAgentId).toBe('agent-1');

    const configured = await f.client.callTool(configureCall(f, documentId));
    expect(configured).not.toHaveProperty('isError', true);
    expect(docMcpPayload(configured)).toEqual({ configured: true });
  });

  it('still opens the page when the principal cannot be resolved, with no opener', async () => {
    const f = await connect('unresolvable');
    const opened = await f.client.callTool({ name: 'control_ui', arguments: { ...args } });
    expect(opened).not.toHaveProperty('isError', true);
    expect(f.resolvePrincipal).toHaveBeenCalled();
    const documentId = String(docMcpPayload(opened).documentId);
    expect(f.http.channels.getChannel(documentId)?.openerAgentId ?? null).toBeNull();
  });
});

it('ignores an opener named in the arguments: the turn decides, not the call', async () => {
  const f = await connect('real');
  const opened = await f.client.callTool({
    name: 'control_ui',
    arguments: { ...OPENS[0][1], openerAgentId: 'foreign-agent' },
  });
  expect(opened).not.toHaveProperty('isError', true);
  const documentId = String(docMcpPayload(opened).documentId);
  expect(f.http.channels.getChannel(documentId)?.openerAgentId).toBe('agent-1');
});

it('keeps the window verbs working when the principal cannot be resolved', async () => {
  const f = await connect('unresolvable');
  const toast = await f.client.callTool({
    name: 'control_ui',
    arguments: { action: 'show_toast', message: 'Hello' },
  });
  expect(toast).not.toHaveProperty('isError', true);
});

it('does not read Claude Code’s own principal as the loopback surface', async () => {
  // `apply_layout` is refused only for a caller that cannot be asked first;
  // Claude Code raises a card for it, so it must reach the client here.
  const f = await connect('real');
  const applied = await f.client.callTool({
    name: 'control_ui',
    arguments: { action: 'apply_layout', shape: 'focus' },
  });
  expect(f.resolvePrincipal).toHaveBeenCalled();
  const text = (applied.content as Array<{ text?: string }>).map((part) => part.text).join('');
  expect(text).not.toContain(uiActionRefusalMessage('apply_layout'));
  expect(applied).not.toHaveProperty('isError', true);
});
