/**
 * @vitest-environment node
 *
 * The app-server transport against the REAL vendored Codex binary, for free
 * (spec `codex-app-server-transport` §17, the spike technique): a throwaway
 * `CODEX_HOME` and `HOME`, no API key in sight, and one local HTTP server on
 * 127.0.0.1 playing both a Responses provider (configured in the throwaway
 * home's `config.toml`) and the DorkOS tool server. Nothing leaves the
 * machine; nothing of this machine's `~/.codex` is read or written.
 *
 * Proves, on the binary DorkOS pins:
 * - a turn streams text and ends with exactly one `done`;
 * - Stop is acknowledged (`acked`) when Codex winds the turn down;
 * - the `dorkos` MCP server receives the thread key, and the listener's
 *   resolution of that key works only while the turn is open;
 * - no secret is in the child's argv or environment;
 * - the throwaway home's trust list is not written by a writable-mode turn;
 * - a command Codex must ask about raises a card; approved, it runs; denied,
 *   it does not (spec §10);
 * - a steer mid-turn reaches the open turn, and no new turn starts (§11).
 *
 * Skipped by name where no vendored binary is installed for this platform.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import { CodexAppServerPool, type SpawnAppServer } from '../process-pool.js';
import { AppServerCodexTransport } from '../../transport/app-server-transport.js';
import { createCodexEventContext } from '../../event-mapper.js';
import { ConnectorThreadKeyRegistry } from '../../../../connectors/principal/thread-keys.js';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimeTools } from '../../../connector-tools.js';
import type { CodexTurnRequest } from '../../transport/codex-transport.js';
import { spawn as nodeSpawn } from 'node:child_process';

const BINARY = resolveCodexVendoredBinary();
const IDENTITY_SECRET = 'identity-token-never-real';

interface Seen {
  responses: number;
  mcpAuthorizations: string[];
  /** Listener resolutions made while a provider request (a turn) was open. */
  resolvedDuringTurn: string[];
}

let root: string;
let codexHome: string;
let project: string;
let server: http.Server;
let base: string;
let stallNext = false;
/** Scripted provider answers, consumed in order before the default "pong". */
const scripted: Array<(res: http.ServerResponse, body: string) => void> = [];
/** Tool calls the third-party MCP server ran, by name. */
const mcpCalls: string[] = [];
/** `turn/started` notifications every spawned process sent, counted off its stdout. */
let turnStartedSeen = 0;
const seen: Seen = { responses: 0, mcpAuthorizations: [], resolvedDuringTurn: [] };
const pools: CodexAppServerPool[] = [];
const spawned: Array<{ args: readonly string[]; env: Record<string, string> }> = [];

const keys = new ConnectorThreadKeyRegistry();
const db = createDb(':memory:');
runMigrations(db);
const principals = new ConnectorRuntimePrincipalService({
  db,
  threadKeys: keys,
  authority: {
    authorizeTurn: async () => ({
      owner: { kind: 'local_install', installationId: 'i' },
      agentId: 'a',
    }),
    revalidateTurn: async () => true,
  },
});

/** The SSE body of one streamed Responses answer. */
function sse(text: string): string {
  const events = [
    { type: 'response.created', response: { id: 'resp_1' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text.slice(0, 2),
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text.slice(2),
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function resolveAll(): Promise<void> {
  for (const authorization of new Set(seen.mcpAuthorizations)) {
    const result = await principals.resolve({
      bearer: authorization.replace(/^Bearer /, ''),
      expectedRuntime: 'codex',
      expectedCanonicalCwd: project,
    });
    if (result.status === 'resolved') seen.resolvedDuringTurn.push(result.principal.claims.kind);
  }
}

/** One streamed Responses answer that calls `exec_command`. */
function sseCall(
  args: Record<string, unknown>,
  tool: { name: string; namespace?: string } = { name: 'exec_command' }
): string {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: `call_${Math.random().toString(36).slice(2, 8)}`,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(args),
  };
  return [
    { type: 'response.created', response: { id: 'resp_call' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    {
      type: 'response.completed',
      response: {
        id: 'resp_call',
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  if (req.url?.startsWith('/v1/responses') && scripted.length > 0) {
    seen.responses += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    scripted.shift()!(res, body);
    return;
  }
  if (req.url?.startsWith('/v1/responses')) {
    seen.responses += 1;
    // The turn is open while Codex waits on this answer: resolve the key now.
    void resolveAll().then(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (stallNext) {
        stallNext = false;
        res.write(': stalled\n\n');
        return; // never completes: Stop has to end this turn
      }
      res.end(sse('pong'));
    });
    return;
  }
  if (req.url?.startsWith('/repo-mcp')) {
    // A third-party MCP server: one tool that changes things, one its server
    // marks read-only.
    const message = JSON.parse(body || '{}') as { id?: number; method?: string; params?: unknown };
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'repo', version: '0' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'delete_repo',
                  description: 'Delete a repository',
                  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
                },
                {
                  name: 'read_file',
                  description: 'Read a file',
                  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : message.method === 'tools/call'
            ? (mcpCalls.push((message.params as { name: string }).name),
              { content: [{ type: 'text', text: 'ok' }] })
            : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    return;
  }
  if (req.url?.startsWith('/mcp')) {
    if (req.headers.authorization) seen.mcpAuthorizations.push(req.headers.authorization);
    let message: { id?: number; method?: string } = {};
    try {
      message = JSON.parse(body) as typeof message;
    } catch {
      // Not JSON.
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-dorkos', version: '0' },
          }
        : message.method === 'tools/list'
          ? { tools: [] }
          : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    return;
  }
  res.writeHead(404).end();
}

function makeTransport(): AppServerCodexTransport {
  const spawn: SpawnAppServer = (binary, args, options) => {
    spawned.push({ args, env: options.env });
    const child = nodeSpawn(binary, [...args], {
      env: options.env,
      cwd: options.cwd,
      stdio: 'pipe',
    });
    child.stdout.on('data', (chunk: Buffer) => {
      turnStartedSeen += chunk.toString().split('"method":"turn/started"').length - 1;
    });
    return child;
  };
  const pool = new CodexAppServerPool({ spawn });
  pools.push(pool);
  const tools = {
    principals,
    threadKeys: keys,
    listenerUrl: `${base}/mcp`,
    agentToolsUrl: `${base}/mcp`,
    isConnectorCapabilityId: () => false,
  } satisfies ConnectorRuntimeTools;
  return new AppServerCodexTransport({
    pool,
    connectorTools: () => tools,
    environment: {
      person: () => ({
        PATH: '/usr/bin:/bin',
        HOME: path.join(root, 'home'),
        CODEX_HOME: codexHome,
      }),
      credits: () => ({
        PATH: '/usr/bin:/bin',
        HOME: path.join(root, 'home'),
        CODEX_HOME: codexHome,
      }),
    },
  });
}

function request(
  sessionId: string,
  bindingId: string | undefined,
  overrides: Partial<CodexTurnRequest> = {}
): CodexTurnRequest {
  return {
    binary: BINARY!,
    sessionId,
    boundThreadId: undefined,
    cwd: project,
    settings: { permissionMode: 'acceptEdits', model: 'fake-model' },
    writableDirectories: [],
    prompt: 'say pong',
    launch: { home: 'person' },
    tools: {
      agentTokenEnv: { DORKOS_AGENT_TOKEN: IDENTITY_SECRET },
      managed: { servers: {}, env: {} },
      dorkosTools: { url: `${base}/mcp`, headers: {} },
      connectorTools: null,
      ...(bindingId ? { connectorBindingId: bindingId } : {}),
    },
    signal: new AbortController().signal,
    events: createCodexEventContext(sessionId),
    onThreadBound: () => {},
    ...overrides,
  };
}

describe.skipIf(BINARY === null)('the app-server transport against the real Codex binary', () => {
  beforeAll(async () => {
    vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-')));
    codexHome = path.join(root, 'codex-home');
    project = path.join(root, 'project');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => handle(req, res, body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The throwaway home's provider is the local fake. No key anywhere.
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "fake"',
        '[model_providers.fake]',
        'name = "fake"',
        `base_url = "${base}/v1"`,
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'request_max_retries = 0',
        'stream_max_retries = 0',
      ].join('\n') + '\n'
    );
    await principals.initializeBoot();
  });

  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Codex may still be finishing a background write into the throwaway home
    // (its plugin cache) as it exits; a leftover temp dir is not a failure.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, 60_000);

  it('streams a turn, binds the thread key to it only while it is open, and leaks nothing', async () => {
    const transport = makeTransport();
    const configBefore = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const opened = await principals.openTurn(
      {
        runtime: 'codex',
        canonicalSessionId: 's1',
        agentPath: project,
        canonicalCwd: project,
        signal: new AbortController().signal,
      },
      { isCurrent: () => true }
    );
    const events: StreamEvent[] = [];
    for await (const event of transport.runTurn(request('s1', opened.bindingId)))
      events.push(event);

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(text, JSON.stringify(events)).toBe('pong');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');

    // The dorkos server got the thread key, never the turn bearer.
    expect(seen.mcpAuthorizations.length).toBeGreaterThan(0);
    expect(seen.mcpAuthorizations.every((a) => a.startsWith('Bearer dtk_'))).toBe(true);
    expect(seen.mcpAuthorizations.some((a) => a.includes(opened.bearer))).toBe(false);
    // While the turn was open, the listener resolved it; now it does not.
    expect(seen.resolvedDuringTurn).toContain('runtime');
    const after = await principals.resolve({
      bearer: seen.mcpAuthorizations[0]!.replace(/^Bearer /, ''),
      expectedRuntime: 'codex',
      expectedCanonicalCwd: project,
    });
    expect(after).toEqual({ status: 'refused', reason: 'expired' });

    // Nothing secret in argv or the process environment.
    expect(spawned[0]!.args).toEqual(['app-server', '--listen', 'stdio://']);
    const visible = JSON.stringify(spawned);
    expect(visible).not.toContain(IDENTITY_SECRET);
    expect(visible).not.toContain('dtk_');
    expect(visible).not.toContain(opened.bearer);

    // A writable-mode thread did not write the trust list.
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe(configBefore);
  });

  // Spec §9 asks P1 to RECORD whether a stdio MCP server Codex launches sees
  // the identity token (on exec it inherits the process environment; here the
  // token rides shell_environment_policy.set instead). Either answer is
  // acceptable under spec `agent-trust` §3.1; this pins which one it is.
  it('records whether a stdio MCP server Codex launches sees the identity token', async () => {
    const report = path.join(root, 'stdio-env.json');
    const script = path.join(root, 'stdio-mcp.cjs');
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ sawToken: 'DORKOS_AGENT_TOKEN' in process.env }));`,
        "let buf = '';",
        "process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);",
        '  let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue;',
        "  const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '0' } } : m.method === 'tools/list' ? { tools: [] } : {};",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });",
      ].join('\n')
    );
    const transport = makeTransport();
    const turn = request('s3', undefined, {
      tools: {
        agentTokenEnv: { DORKOS_AGENT_TOKEN: IDENTITY_SECRET },
        managed: { servers: { probe: { command: process.execPath, args: [script] } }, env: {} },
        dorkosTools: null,
        connectorTools: null,
      },
    });
    for await (const _event of transport.runTurn(turn)) {
      // drained
    }
    expect(fs.existsSync(report), 'the stdio MCP server never started').toBe(true);
    // Recorded: the token does NOT reach a stdio MCP server's environment on
    // app-server (it is set for the agent's own shell commands only).
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual({ sawToken: false });
  });

  // A refreshed OAuth header on a managed server reaches a loaded thread by
  // reloading just that thread as a fork (a loaded resume ignores config).
  it('reloads a thread whose managed header value changed, and its MCP server sees the new one', async () => {
    const transport = makeTransport();
    const managed = (value: string) => ({
      servers: { refreshed: { url: `${base}/mcp`, env_http_headers: { Authorization: 'H' } } },
      env: { H: value },
    });
    const bound: string[] = [];
    const turn = (value: string, boundThreadId?: string) =>
      request('s4', undefined, {
        boundThreadId,
        tools: {
          agentTokenEnv: {},
          managed: managed(value),
          dorkosTools: null,
          connectorTools: null,
        },
        onThreadBound: (threadId) => bound.push(threadId),
      });
    for await (const _event of transport.runTurn(turn('Bearer first-oauth'))) {
      // drained
    }
    expect(seen.mcpAuthorizations).toContain('Bearer first-oauth');
    const events: StreamEvent[] = [];
    for await (const event of transport.runTurn(turn('Bearer refreshed-oauth', bound[0])))
      events.push(event);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(seen.mcpAuthorizations).toContain('Bearer refreshed-oauth');
    expect(bound).toHaveLength(2);
    expect(bound[1]).not.toBe(bound[0]);
  });

  it('acknowledges a stop: Codex winds the turn down and the turn ends with one done', async () => {
    const transport = makeTransport();
    stallNext = true;
    const turn = transport.runTurn(request('s2', undefined));
    const events: StreamEvent[] = [];
    // Wait until the provider has the request (the turn is open and waiting).
    const before = seen.responses;
    const reader = (async () => {
      for await (const event of turn) events.push(event);
    })();
    for (let i = 0; i < 300 && seen.responses === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen.responses).toBeGreaterThan(before);
    await expect(transport.interrupt('s2')).resolves.toEqual({
      outcome: 'acked',
      runtime: 'codex',
    });
    await reader;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  describe('Ask first and MCP tools (spec §10)', () => {
    const repoTools = () => ({
      agentTokenEnv: {},
      managed: { servers: { repo: { url: `${base}/repo-mcp` } }, env: {} },
      dorkosTools: null,
      connectorTools: null,
    });
    const callTool = (name: string) =>
      scripted.push(
        (res) => res.end(sseCall({ name: 'prod' }, { name, namespace: 'mcp__repo' })),
        (res) => res.end(sse('done'))
      );

    it('stops before an MCP tool that can change things, on that call’s own card', async () => {
      mcpCalls.length = 0;
      callTool('delete_repo');
      const transport = makeTransport();
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(
        request('mcp-ask', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
          tools: repoTools(),
        })
      )) {
        events.push(event);
        if (event.type === 'approval_required') {
          const card = event.data as { toolCallId: string; toolName: string; input: string };
          expect(card.toolName).toBe('mcp__repo__delete_repo');
          expect(JSON.parse(card.input)).toEqual({ name: 'prod' });
          const start = events.find(
            (e) =>
              e.type === 'tool_call_start' &&
              (e.data as { toolCallId: string }).toolCallId === card.toolCallId
          );
          expect(start, 'the card is the running call’s own').toBeDefined();
          expect(mcpCalls, 'nothing runs before a person answers').toEqual([]);
          expect(transport.answerApproval('mcp-ask', card.toolCallId, true)).toBe(true);
        }
      }
      expect(
        events.some((e) => e.type === 'approval_required'),
        JSON.stringify(events)
      ).toBe(true);
      expect(mcpCalls).toEqual(['delete_repo']);
    });

    it('runs an MCP tool its own server marks read-only without asking', async () => {
      mcpCalls.length = 0;
      callTool('read_file');
      const transport = makeTransport();
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(
        request('mcp-read', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
          tools: repoTools(),
        })
      ))
        events.push(event);
      expect(events.some((e) => e.type === 'approval_required')).toBe(false);
      expect(mcpCalls).toEqual(['read_file']);
    });
  });

  describe('approvals and steer (spec §10, §11)', () => {
    const made = () => path.join(project, 'approved.txt');
    const askToWrite = () => {
      scripted.push(
        (res) =>
          res.end(
            sseCall({
              cmd: 'echo approved > approved.txt',
              sandbox_permissions: 'require_escalated',
              justification: 'Create approved.txt?',
              login: false,
            })
          ),
        (res) => res.end(sse('done'))
      );
    };

    it('raises a card for a command that needs approval, and runs it once approved', async () => {
      fs.rmSync(made(), { force: true });
      askToWrite();
      const transport = makeTransport();
      const gen = transport.runTurn(
        request('approve-1', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
        })
      );
      const events: StreamEvent[] = [];
      let answered = false;
      for await (const event of gen) {
        events.push(event);
        if (event.type === 'approval_required' && !answered) {
          answered = true;
          const card = event.data as { toolCallId: string; toolName: string; input: string };
          expect(card.toolName).toBe('Shell');
          expect(card.input).toContain('approved.txt');
          expect(fs.existsSync(made()), 'nothing runs before a person answers').toBe(false);
          expect(transport.answerApproval('approve-1', card.toolCallId, true)).toBe(true);
        }
      }
      expect(answered, JSON.stringify(events)).toBe(true);
      expect(fs.readFileSync(made(), 'utf8').trim()).toBe('approved');
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    });

    it('declines the command when a person denies it, and it never runs', async () => {
      fs.rmSync(made(), { force: true });
      askToWrite();
      const transport = makeTransport();
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(
        request('deny-1', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
        })
      )) {
        events.push(event);
        if (event.type === 'approval_required') {
          const id = (event.data as { toolCallId: string }).toolCallId;
          expect(transport.answerApproval('deny-1', id, false)).toBe(true);
        }
      }
      expect(
        events.some((e) => e.type === 'approval_required'),
        JSON.stringify(events)
      ).toBe(true);
      expect(fs.existsSync(made())).toBe(false);
      const ends = events.filter((e) => e.type === 'tool_call_end');
      expect(ends.at(-1)).toMatchObject({ data: { status: 'error' } });
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    });

    it('steers a running turn: the words reach that turn, and no new turn starts', async () => {
      let secondBody = '';
      scripted.push(
        // A long first answer: half now, the rest a while later.
        (res) => {
          const whole = sse('first');
          const cut = whole.indexOf('event: response.output_item.done');
          res.write(whole.slice(0, cut));
          setTimeout(() => res.end(whole.slice(cut)), 1_500);
        },
        (res, body) => {
          secondBody = body;
          res.end(sse('after steer'));
        }
      );
      const transport = makeTransport();
      const startedBefore = turnStartedSeen;
      const gen = transport.runTurn(request('steer-1', undefined));
      const events: StreamEvent[] = [];
      for (;;) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value);
        if (next.value.type === 'text_delta') break;
      }
      await expect(
        transport.deliverIntoTurn('steer-1', 'STEERED-WORDS', {
          mode: 'steer',
          messageId: 'steer-msg-1',
        })
      ).resolves.toEqual({ delivered: true });
      for await (const event of gen) events.push(event);
      const text = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e.data as { text: string }).text)
        .join('');
      expect(text).toContain('after steer');
      expect(secondBody).toContain('STEERED-WORDS');
      expect(turnStartedSeen - startedBefore, 'one turn, steered').toBe(1);
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    });
  });
});
