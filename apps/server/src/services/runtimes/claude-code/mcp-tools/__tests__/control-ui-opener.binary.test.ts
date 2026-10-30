/**
 * @vitest-environment node
 *
 * The real bundled Claude Code binary drives DorkOS's own in-process MCP server
 * through one turn: `control_ui` opens a served page, then
 * `configure_doc_channel` declares a route on it (QA on #3104, 2026-10-27,
 * where the opener stayed NULL and configure failed with `OPENER_REQUIRED`).
 *
 * Two rows. A plain turn: the page's opener is this agent and configure passes.
 * A turn a stranger started in a chat set below Full, held to the runtime default
 * exactly as the launch holds one: the page still binds its opener, and configure
 * is put in front of a person (DorkOS's own `canUseTool` raises the card) rather
 * than run.
 *
 * Nothing here can spend or reach the internet: a fake HTTP server on 127.0.0.1
 * plays the model, and the key is made up. Real Main services sit behind the
 * MCP server (`runtimeDocMcpFixture`); no test-mode runtime and no test-only
 * route sets the opener.
 *
 * Skipped where the SDK's bundled binary is not installed for this platform.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { noopLogger } from '@dorkos/shared/logger';
import type { PermissionModeId, StreamEvent } from '@dorkos/shared/types';
import { composeRegistry } from '../../../../core/capabilities/index.js';
import { peekCanvasService, setCanvasService } from '../../../../canvas/index.js';
import { uiDomain } from '../../../../session/browser-seat/ui-capabilities.js';
import { noteTurnOrigin, resetOutsiderTurns } from '../../../../session/origin/outsider-turns.js';
import { runtimeDocMcpFixture } from '../../../../canvas/doc-channel/__tests__/runtime-doc-mcp-fixture.js';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { ClaudeConnectorTurnContext } from '../../connector-turn-context.js';
import { createCanUseTool } from '../../messaging/interactive-handlers.js';
import type { PendingInteraction } from '../../messaging/interaction-wait.js';
import { createDorkOsToolServer } from '../index.js';
import type { McpToolDeps } from '../types.js';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined, DORKOS_OLLAMA_URL: 'http://127.0.0.1:11434' },
}));
vi.mock('../../../../../lib/version.js', () => ({
  SERVER_VERSION: '0.0.0-test',
  IS_DEV_BUILD: false,
}));

const BINARY = resolveBundledClaudeBinary();
const SESSION_ID = 'session-1';
const PAGE = 'http://localhost:5173/';
const OPEN_ID = 'toolu_open';
const CONFIGURE_ID = 'toolu_configure';

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed reply: one tool call, or a closing line of text. */
function reply(call?: { id: string; name: string; input: Record<string, unknown> }): string {
  const message = {
    id: `msg_${call?.id ?? 'end'}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const block = call
    ? { type: 'tool_use', id: call.id, name: call.name, input: {} }
    : { type: 'text', text: '' };
  const delta = call
    ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
    : { type: 'text_delta', text: 'done' };
  return [
    sse('message_start', { type: 'message_start', message }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('');
}

/** The text of one tool result in a request body, or `undefined` before it exists. */
function toolResultText(body: string, toolUseId: string): string | undefined {
  const messages = (JSON.parse(body) as { messages?: Array<{ content?: unknown }> }).messages ?? [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool_result' || part.tool_use_id !== toolUseId) continue;
      const content = part.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content))
        return (content as Array<{ text?: string }>).map((piece) => piece.text ?? '').join('');
      return '';
    }
  }
  return undefined;
}

/** The fake model: open the page, configure it, then stop. */
function playModel(onConfigureResult: (text: string) => void) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no' } })
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const opened = toolResultText(body, OPEN_ID);
      if (opened === undefined) {
        res.end(
          reply({
            id: OPEN_ID,
            name: 'mcp__dorkos__control_ui',
            input: { action: 'browser_navigate', url: PAGE },
          })
        );
        return;
      }
      const configured = toolResultText(body, CONFIGURE_ID);
      if (configured === undefined) {
        const documentId = /"documentId"\s*:\s*"([^"]+)"/.exec(opened)?.[1] ?? 'no-document';
        res.end(
          reply({
            id: CONFIGURE_ID,
            name: 'mcp__dorkos__configure_doc_channel',
            input: {
              documentId,
              channel: {
                routes: [{ id: 'own-route', on: 'task.*', to: 'log', turn: { mode: 'none' } }],
              },
            },
          })
        );
        return;
      }
      onConfigureResult(configured);
      res.end(reply());
    });
  });
}

type Row = 'plain' | 'stranger';

/** Run one real CLI turn against the real DorkOS MCP server. */
async function runTurn(row: Row) {
  const f = await runtimeDocMcpFixture('claude-code', 'chat');
  cleanups.push(() => f.close());
  const prior = peekCanvasService();
  setCanvasService(f.canvas);
  if (prior) cleanups.push(() => setCanvasService(prior));
  const registry = composeRegistry([uiDomain], {
    logger: noopLogger,
    docChannelGrantDeps: { service: f.http.grants, authorization: f.http.authorization },
    docChannelDownstream: f.http.downstream,
  });
  const connectorTurn = new ClaudeConnectorTurnContext({
    tools: {
      principals: f.principals,
      listenerUrl: 'http://127.0.0.1:1/mcp',
      agentToolsUrl: 'http://127.0.0.1:1/agent-mcp',
      isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
    },
    canonicalSessionId: () => SESSION_ID,
    agentPath: f.dir,
    cwd: f.dir,
  });
  cleanups.push(() => connectorTurn.revoke('turn_terminal'));
  if (row === 'stranger') {
    noteTurnOrigin(SESSION_ID, { kind: 'relay-binding' });
    cleanups.push(() => resetOutsiderTurns());
  }
  const session = {
    cwd: f.dir,
    sdkSessionId: SESSION_ID,
    connectorTurn,
    // A chat set to Full asks nobody, whoever started the turn (DOR-3394), so the
    // row that must ask is a chat set below it.
    permissionMode: (row === 'stranger' ? 'default' : 'bypassPermissions') as PermissionModeId,
    // What the launch sets on a turn a stranger started.
    ...(row === 'stranger' ? { turnPermissionCeiling: 'runtime-default' as const } : {}),
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: () => {},
  };
  const deps: McpToolDeps = {
    defaultCwd: f.dir,
    dorkHome: f.dir,
    transcriptReader: {
      listSessions: async () => [],
    } as unknown as McpToolDeps['transcriptReader'],
  };
  const dorkos = createDorkOsToolServer(
    deps,
    session,
    'request-id',
    undefined,
    registry,
    new Set(),
    undefined,
    false
  );

  let configureResult: string | undefined;
  const server = playModel((text) => (configureResult = text));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const { port } = server.address() as AddressInfo;

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'control-ui-binary-')));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10 }));
  const account = path.join(home, 'account');
  fs.mkdirSync(account);

  // DorkOS's own gate, as the launch wires it: `control_ui` is auto-allowed on
  // every turn, `configure_doc_channel` asks on a held one.
  const canUseTool = createCanUseTool(
    session,
    { debug: () => {}, info: () => {} },
    undefined,
    async () => ({
      agentPath: f.dir,
    })
  ) as unknown as CanUseTool;

  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const stream = query({
    prompt: 'open the page and wire it up',
    options: {
      cwd: f.dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CLAUDE_CONFIG_DIR: account,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'fake-key-never-real',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      mcpServers: { dorkos: dorkos as never },
      // The turn's mode, as the launch computes it: a held turn runs at the
      // runtime default, so the CLI asks DorkOS about every tool.
      permissionMode: row === 'stranger' ? 'default' : 'bypassPermissions',
      ...(row === 'plain' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool,
      settingSources: [],
      pathToClaudeCodeExecutable: BINARY!,
      abortController: abort,
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: spawnOptions.signal,
        });
        childClosed = new Promise<void>((done) => child.once('close', () => done()));
        return child as unknown as ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>>;
      },
    },
  });

  // A held configure waits on a person forever; stop the turn once it asks.
  const asking = setInterval(() => {
    if (session.pendingInteractions.size > 0) abort.abort();
  }, 100);
  const deadline = setTimeout(() => abort.abort(), 50_000);
  try {
    for await (const message of stream) {
      if (message.type === 'result') break;
    }
  } catch {
    // Aborted on purpose, or the CLI gave up on the fake server.
  } finally {
    clearTimeout(deadline);
    clearInterval(asking);
    abort.abort();
    stream.close();
    await childClosed;
  }

  const documents = f.canvas.list(`session:${SESSION_ID}`);
  const pageDoc = documents.find(
    (doc) => (doc.content as { url?: string } | undefined)?.url === PAGE
  );
  const channel = pageDoc ? f.http.channels.getChannel(pageDoc.id) : undefined;
  return { session, channel, pageDoc, configureResult };
}

describe.skipIf(BINARY === null)('real Claude Code: control_ui then configure_doc_channel', () => {
  it('binds this agent as opener, and configure passes', async () => {
    const { pageDoc, channel, configureResult } = await runTurn('plain');
    expect(pageDoc).toBeDefined();
    expect(configureResult).toBeDefined();
    expect(configureResult).not.toContain('OPENER_REQUIRED');
    expect(JSON.parse(configureResult!)).toEqual({ configured: true });
    expect(channel?.openerAgentId).toBe('agent-1');
    expect(channel?.declaration).toMatchObject({ routes: [{ id: 'own-route' }] });
  }, 90_000);

  it('a stranger’s turn below Full still binds the opener, and configure asks a person', async () => {
    const { session, pageDoc, channel, configureResult } = await runTurn('stranger');
    expect(pageDoc).toBeDefined();
    expect(channel?.openerAgentId).toBe('agent-1');
    // Configure never ran: a card was up for it when the turn stopped, and
    // nothing was declared. (The CLI reports the stopped card as its result.)
    expect(configureResult ?? '').not.toContain('configured');
    const cards = session.eventQueue.filter((event) => event.type === 'approval_required');
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain('configure_doc_channel');
    expect(channel?.declaration ?? null).toBeNull();
  }, 90_000);
});
